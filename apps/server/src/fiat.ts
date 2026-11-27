// Fiat staking (Pollar). Viewers who sign in with Google (or an external wallet) hold a ledger
// balance in INTEGER micro-USD; the server's treasury keypair is the on-chain setter/backer for
// all of their mines and backs. Invariants (docs/ARCHITECTURE.md "Fiat staking"):
//   I1 treasury is the on-chain setter  I2 salt+word stay in the browser until played
//   I3 integer micro-USD                I4 every change is persisted atomically
//   I5 credits need SERVER-SIDE confirmation of the USDC payment on Solana, exactly once per signature
//   I6 viewer identity is validated server-side (Pollar access token → wallet address) — mock mode: plain {user}
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { proRata } from "@wordtrap/shared";

export const MICRO = 1_000_000;
/** Dollars → integer micro-USD, exactly: "0.25" → 250000. Parses the decimal text; never multiplies a float. */
export const toMicro = (usd: number | string): number => {
  const t = String(usd ?? "").trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) throw new FiatError(`bad amount ${t}`, 400);
  return Number(m[1] + (m[2] ?? "").padEnd(6, "0"));
};
export const fromMicro = (m: number): number => m / MICRO;

export class FiatError extends Error {
  readonly code: number;
  constructor(msg: string, code = 400) { super(msg); this.name = "FiatError"; this.code = code; }
}

// ---------------------------------------------------------------- ledger (I3, I4, I5)

export type PaymentStatus = "credited" | "pending" | "failed";
export interface LedgerEntry { ts: number; user: string; delta: number; reason: string; ref?: string }
export interface TrapOwnership { user: string; runId: string; stake: number; status: "armed" | "paid" | "refunded"; payout?: number }
export interface MoneyJob { user: string; delta: number; kind: string; ref: string }
export interface LedgerFile {
  version: 1;
  balances: Record<string, number>;                                  // user -> micro-USD
  payments: Record<string, { user: string; micro: number; status: PaymentStatus; ts: number; tries: number }>;
  /** Last resort when Pollar gives no Solana wallet: Pollar userId → the address the page claimed, bound once. */
  wallets: Record<string, string>;
  /** Movements already applied, keyed user|kind|ref → balance after (a retry with the same ref is a no-op). */
  applied: Record<string, number>;
  /** Game money (bounties, payouts) that could not reach the durable store yet. */
  queue: MoneyJob[];
  traps: Record<string, TrapOwnership>;                              // on-chain trapId -> owner
  backers: Record<string, Record<string, number>>;                   // runId -> user -> micro-USD backed
  settled: Record<string, { ts: number; paid: Record<string, number> }>;
  history: LedgerEntry[];
}
const EMPTY = (): LedgerFile => ({ version: 1, balances: {}, payments: {}, wallets: {}, applied: {}, queue: [], traps: {}, backers: {}, settled: {}, history: [] });
const HISTORY_CAP = 500;

export class FiatLedger {
  readonly path: string | null;
  private d: LedgerFile;

  /** `path: null` keeps everything in memory (tests). */
  constructor(path: string | null) {
    this.path = path;
    this.d = EMPTY();
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
      if (raw.version !== 1) throw new Error(`unknown ledger version ${raw.version}`);
      this.d = { ...EMPTY(), ...raw };
    }
  }

  /** Atomic write-then-rename so a crash mid-write never corrupts the file (I4). */
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d, null, 1));
    renameSync(tmp, this.path);
  }

  balance(user: string): number { return this.d.balances[user] ?? 0; }
  balances(): Readonly<Record<string, number>> { return this.d.balances; }
  payments(): Readonly<LedgerFile["payments"]> { return this.d.payments; }
  creditedSignatures(user: string): string[] { return Object.entries(this.d.payments).filter(([, p]) => p.status === "credited" && p.user === user).map(([s]) => s); }
  /** One movement, once per (user, kind, ref): a retry returns the balance it left. Debits that exceed the balance throw 402. */
  apply(user: string, delta: number, kind: string, ref: string): number {
    const key = `${user}|${kind}|${ref}`;
    if (key in this.d.applied) return this.d.applied[key];
    if (delta < 0) this.debit(user, -delta, kind, ref); else if (delta > 0) this.credit(user, delta, kind, ref); else this.log({ ts: Date.now(), user, delta: 0, reason: kind, ref });
    this.d.applied[key] = this.balance(user); this.save();
    return this.d.applied[key];
  }

  credit(user: string, micro: number, reason: string, ref?: string) {
    if (!Number.isInteger(micro) || micro < 0) throw new FiatError(`bad credit ${micro}`, 500);
    this.d.balances[user] = this.balance(user) + micro;
    this.log({ ts: Date.now(), user, delta: micro, reason, ref });
    this.save();
  }

  debit(user: string, micro: number, reason: string, ref?: string) {
    if (!Number.isInteger(micro) || micro <= 0) throw new FiatError(`bad amount`, 400);
    const bal = this.balance(user);
    if (bal < micro) throw new FiatError(`insufficient balance: have $${fromMicro(bal).toFixed(2)}, need $${fromMicro(micro).toFixed(2)}`, 402);
    this.d.balances[user] = bal - micro;
    this.log({ ts: Date.now(), user, delta: -micro, reason, ref });
    this.save();
  }

  /** Exactly-once credit keyed by the Pollar payment id (I5). Returns what happened. */
  creditFromPayment(paymentId: string, user: string, micro: number): { credited: boolean; duplicate: boolean } {
    const p = this.d.payments[paymentId];
    if (p?.status === "credited") return { credited: false, duplicate: true };
    this.d.payments[paymentId] = { user, micro, status: "credited", ts: Date.now(), tries: (p?.tries ?? 0) + 1 };
    this.credit(user, micro, "pollar payment", paymentId);   // saves
    return { credited: true, duplicate: false };
  }
  markPending(paymentId: string, user: string, micro = 0) {
    const p = this.d.payments[paymentId];
    if (p?.status === "credited") return;
    this.d.payments[paymentId] = { user, micro, status: "pending", ts: p?.ts ?? Date.now(), tries: (p?.tries ?? 0) + 1 };
    this.save();
  }
  markFailed(paymentId: string) {
    const p = this.d.payments[paymentId];
    if (!p || p.status === "credited") return;
    p.status = "failed"; this.save();
  }
  payment(paymentId: string) { return this.d.payments[paymentId]; }
  /** Record a signature as credited without moving memory money (the MoneyStore did). */
  markCredited(paymentId: string, user: string, micro: number) { const p = this.d.payments[paymentId]; if (p?.status === "credited") return; this.d.payments[paymentId] = { user, micro, status: "credited", ts: Date.now(), tries: (p?.tries ?? 0) + 1 }; this.save(); }
  enqueue(job: MoneyJob) { if (!this.d.queue.some((j) => j.ref === job.ref && j.kind === job.kind)) { this.d.queue.push(job); this.save(); } }
  queued(): MoneyJob[] { return [...this.d.queue]; }
  dequeue(ref: string) { this.d.queue = this.d.queue.filter((j) => j.ref !== ref); this.save(); }
  /** A refused signature that may belong to another sender is not failed for everyone. */
  unmarkFailed(paymentId: string) { const p = this.d.payments[paymentId]; if (p && p.status === "failed") { delete this.d.payments[paymentId]; this.save(); } }
  /** Bind a Pollar user to one Solana address, once: one address per user, one user per address, never changed here. */
  bindWallet(userId: string, address: string): string {
    const have = this.d.wallets[userId];
    if (have) { if (have !== address) throw new FiatError("This Pollar account is already linked to a different wallet.", 409); return have; }
    const owner = Object.entries(this.d.wallets).find(([, a]) => a === address)?.[0];
    if (owner && owner !== userId) throw new FiatError("That wallet is already linked to another Pollar account.", 409);
    this.d.wallets[userId] = address; this.save();
    return address;
  }
  walletOf(userId: string): string | null { return this.d.wallets[userId] ?? null; }
  pendingPayments(): { id: string; user: string; micro: number }[] {
    return Object.entries(this.d.payments).filter(([, p]) => p.status === "pending").map(([id, p]) => ({ id, user: p.user, micro: p.micro }));
  }

  ownTrap(trapId: string, o: Omit<TrapOwnership, "status">) { this.d.traps[trapId] = { ...o, status: "armed" }; this.save(); }
  trapOwner(trapId: string): TrapOwnership | undefined { return this.d.traps[trapId]; }
  trapsOf(user: string, runId?: string): (TrapOwnership & { trapId: string })[] {
    return Object.entries(this.d.traps).filter(([, t]) => t.user === user && (!runId || t.runId === runId)).map(([trapId, t]) => ({ trapId, ...t }));
  }
  trapsIn(runId: string): (TrapOwnership & { trapId: string })[] { return Object.entries(this.d.traps).filter(([, t]) => t.runId === runId).map(([trapId, t]) => ({ trapId, ...t })); }
  /** Mark a fired fiat mine paid and return its owner; the money moves through the owner's MoneyStore. Idempotent per trap. */
  payTrap(trapId: string, payoutMicro: number): TrapOwnership | null {
    const t = this.d.traps[trapId];
    if (!t || t.status !== "armed") return null;
    t.status = "paid"; t.payout = payoutMicro; this.save();
    return t;
  }

  recordBacker(runId: string, user: string, micro: number) {
    const b = (this.d.backers[runId] ??= {});
    b[user] = (b[user] ?? 0) + micro;
    this.save();
  }
  backersOf(runId: string): Record<string, number> { return this.d.backers[runId] ?? {}; }
  /** What this ledger holds about one run (saved beside the run so a restart keeps mine owners and backers). */
  dumpRun(runId: string) { return { traps: Object.fromEntries(this.trapsIn(runId).map(({ trapId, ...t }) => [trapId, t])), backers: { ...this.backersOf(runId) }, settled: this.d.settled[runId] ?? null }; }
  /** Merge a saved slice back: what this ledger already knows wins (it may be newer, a paid mine say). */
  restoreRun(runId: string, d: any) {
    if (!d) return;
    for (const [id, t] of Object.entries(d.traps ?? {})) if (!this.d.traps[id]) this.d.traps[id] = t as TrapOwnership;
    if (!this.d.backers[runId] && d.backers && Object.keys(d.backers).length) this.d.backers[runId] = { ...d.backers };
    if (!this.d.settled[runId] && d.settled) this.d.settled[runId] = d.settled;
    this.save();
  }
  /** Split the treasury's on-chain backer payout among the fiat backers of a run, pro-rata, once. Returns each
   *  backer's share; the money moves through each backer's MoneyStore (kind payout, ref runId:payout:user). */
  settleBackers(runId: string, treasuryPayoutMicro: number): Record<string, number> {
    if (this.d.settled[runId]) return this.d.settled[runId].paid;
    const backers = this.backersOf(runId);
    const total = Object.values(backers).reduce((n, x) => n + x, 0);
    const paid: Record<string, number> = {};
    for (const [user, micro] of Object.entries(backers)) paid[user] = Number(proRata(BigInt(treasuryPayoutMicro), BigInt(micro), BigInt(total)));
    this.d.settled[runId] = { ts: Date.now(), paid };
    this.save();
    return paid;
  }
  settled(runId: string) { return this.d.settled[runId]; }

  history(user: string | undefined, n = 50): LedgerEntry[] { return this.d.history.filter((h) => user === undefined || h.user === user).slice(-n); }

  private log(e: LedgerEntry) {
    this.d.history.push(e);
    if (this.d.history.length > HISTORY_CAP) this.d.history.splice(0, this.d.history.length - HISTORY_CAP);
  }
}

// ---------------------------------------------------------------- Pollar sign-in (I6) and USDC funding (I5)
//
// Sign-in: the browser signs in through the Pollar SDK and sends its access token as `Authorization: Bearer`.
// The server verifies it with the SECRET key at Pollar Server API v3 `POST /tokens/verify` and caches the
// result until the token's `expiresAt`. The player's identity is the Solana wallet address Pollar reports.
//
// Funding: there is no payment lookup endpoint. The browser pays USDC to the treasury with the SDK's
// `sendPayment({ chain: 'SOLANA', ... })` and posts the transaction signature; the server confirms it
// on Solana itself through RPC_URL (finalized, sender = the verified wallet, destination = the treasury's
// USDC token account, mint and amount match) and credits the ledger exactly once per signature.
// Unconfirmed signatures stay pending and are retried; they are never credited.
//
// Cash top-ups through ramp orders (GET /v3/ramps/orders/{id}) are [ROADMAP].

export interface PollarSession {
  /** Pollar user id (content.userId). */
  userId: string;
  /** The player's identity: the Solana wallet address, or null when Pollar's server side gave none. */
  wallet: string | null;
  /** True on the call that verified the token with Pollar (not served from the cache). */
  fresh?: boolean;
  /** Which lookup found the user's row when verify had no Solana wallet: "verify", "q=id", "q=email", "q=stellar", "pages", or "none". */
  lookup?: string;
  /** Pollar network of the application: "testnet" (Solana devnet) or "mainnet". */
  network: "testnet" | "mainnet" | string;
  /** Unix ms when the token stops being valid. */
  expiresAt: number;
  authProvider?: string;
  /** The name Pollar's profile carries (Google's display name), when any. */
  name?: string;
}
export interface PollarGateway {
  readonly kind: "mock" | "pollar";
  /** Validate a viewer access token. Throws FiatError (401/403/503) with a clear sentence. */
  verifySession(token: string): Promise<PollarSession>;
}

/** Demo-credit mode: no Pollar keys. Payments are registered by POST /dev/credit; sessions are plain user names. */
export interface PaymentLookup { status: "paid" | "pending" | "failed" | "unknown"; micro?: number; user?: string }
export class MockPollar implements PollarGateway {
  readonly kind = "mock" as const;
  readonly payments = new Map<string, PaymentLookup>();
  register(paymentId: string, user: string, micro: number, status: PaymentLookup["status"] = "paid") { this.payments.set(paymentId, { status, micro, user }); }
  async lookupPayment(id: string): Promise<PaymentLookup> { return this.payments.get(id) ?? { status: "unknown" }; }
  async verifySession(token: string): Promise<PollarSession> {
    const m = /^mock:(.+)$/.exec(token);
    if (!m) throw new FiatError("That sign-in is not valid. Sign in again.", 401);
    return { userId: m[1], wallet: m[1], network: "testnet", expiresAt: Date.now() + 3_600_000 };
  }
}

/** What each Pollar error code means to a player. */
export const POLLAR_ERRORS: Record<string, { msg: string; code: number }> = {
  SDK_AUTH_TOKEN_EXPIRED: { msg: "Your Pollar sign-in has expired. Sign in again.", code: 401 },
  SDK_AUTH_INVALID_TOKEN: { msg: "That Pollar sign-in is not valid. Sign in again.", code: 401 },
  SDK_TOKEN_WRONG_APPLICATION: { msg: "That sign-in belongs to a different Pollar application. Sign in here again.", code: 403 },
};

/** base58 (Bitcoin alphabet) decode; null when the text is not base58. */
export function base58decode(s: string): Uint8Array | null {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
  let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
/** A Solana address: base58 that decodes to 32 bytes. (A Stellar G… address is base32 and never passes.) */
export const isSolanaAddress = (s: unknown): s is string => typeof s === "string" && s.length >= 32 && s.length <= 44 && base58decode(s)?.length === 32;
const saysSolana = (v: unknown) => /^(solana|sol)$/i.test(String(v ?? "").trim());
const saysOtherChain = (v: unknown) => /^(stellar|xlm|polygon|pol|matic|ethereum|eth)$/i.test(String(v ?? "").trim());

/**
 * Find the Solana wallet address in whatever shape Pollar sends: a bare address string; an object keyed by chain
 * ({ solana: "…" }); an object with chain|network|type and address|public_key|publicKey|pubkey; an array of those;
 * all of it under `wallet`, `wallets`, `wallet_public_key` or deeper. Chain labels match case-insensitively; an
 * unlabelled string counts when it is a base58 32-byte address.
 */
export function findSolanaAddress(root: unknown): string | null {
  const seen = new Set<unknown>();
  const labelled: string[] = [], unlabelled: string[] = [];
  const addrOf = (o: any) => [o.address, o.public_key, o.publicKey, o.pubkey, o.value].find(isSolanaAddress) ?? null;
  const walk = (v: any, label: string | null, depth: number) => {
    if (v == null || depth > 6 || (typeof v === "object" && seen.has(v))) return;
    if (typeof v === "string") { if (isSolanaAddress(v)) (saysSolana(label) ? labelled : saysOtherChain(label) ? [] : unlabelled).push(v); return; }
    if (typeof v !== "object") return;
    seen.add(v);
    if (Array.isArray(v)) { for (const e of v) walk(e, label, depth + 1); return; }
    const chain = v.chain ?? v.network ?? v.type ?? v.blockchain;
    const a = addrOf(v);
    if (a) { if (saysSolana(chain) || (chain == null && !saysOtherChain(label))) (saysSolana(chain) ? labelled : unlabelled).push(a); return; }
    for (const [k, x] of Object.entries(v)) walk(x, saysSolana(k) || saysOtherChain(k) ? k : (saysSolana(chain) ? "solana" : label), depth + 1);
  };
  walk(root, null, 0);
  return labelled[0] ?? unlabelled[0] ?? null;
}
/** The SHAPE of a response for diagnostics: key names and value types only; every string becomes its length. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return null;
  if (typeof v === "string") return `string(${v.length})`;
  if (typeof v !== "object") return typeof v;
  if (depth > 5) return "…";
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => shapeOf(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
}

/**
 * Real gateway: Pollar Server API v3 (`https://server.api.pollar.xyz/v3`), secret key in `x-pollar-api-key`.
 * `POST /tokens/verify { token }` → `{ code: "SERVER_TOKEN_VERIFIED", content: { userId, applicationId, expiresAt,
 * network, wallet, profile, authProvider } }`. When that content carries no Solana address, `GET /users?q=<userId>`
 * (rows: id, wallet_public_key, wallets: [{ network, public_key }]) is read for the user's Solana wallet.
 * Verified tokens are cached until `expiresAt`.
 */
export class PollarServerApi implements PollarGateway {
  readonly kind = "pollar" as const;
  private readonly base: string; private readonly secret: string;
  private readonly cache = new Map<string, PollarSession>();
  readonly log: (line: string) => void;
  constructor(o: { secretKey: string; baseUrl?: string; log?: (line: string) => void }) {
    this.secret = o.secretKey;
    this.base = (o.baseUrl ?? "https://server.api.pollar.xyz/v3").replace(/\/$/, "");
    this.log = o.log ?? ((line) => console.warn(line));
  }
  private headers() { return { "x-pollar-api-key": this.secret, "content-type": "application/json", accept: "application/json" }; }
  async verifySession(token: string): Promise<PollarSession> {
    const hit = this.cache.get(token);
    if (hit && hit.expiresAt > Date.now()) return hit;
    this.cache.delete(token);
    let r: Response;
    try { r = await fetch(`${this.base}/tokens/verify`, { method: "POST", headers: this.headers(), body: JSON.stringify({ token }), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new FiatError("Pollar is not answering. Try again in a moment.", 503); }
    const p: any = await r.json().catch(() => ({}));
    const code = String(p.code ?? "");
    if (!r.ok || code !== "SERVER_TOKEN_VERIFIED") {
      const known = POLLAR_ERRORS[code];
      if (known) throw new FiatError(known.msg, known.code);
      if (r.status >= 500 || r.status === 429) throw new FiatError("Pollar is not answering. Try again in a moment.", 503);
      throw new FiatError("Pollar could not verify that sign-in. Sign in again.", 401);
    }
    const c = p.content ?? {};
    const userId = String(c.userId ?? "");
    let wallet = findSolanaAddress({ wallet: c.wallet, wallets: c.wallets, wallet_public_key: c.wallet_public_key, solana: c.solana ?? c.solanaWallet });
    let lookup = wallet ? "verify" : "none";
    if (!wallet) {
      // diagnostic (temporary): the shape only, never a value
      this.log(`[fiat] verify shape (no Solana wallet found): ${JSON.stringify(shapeOf(p))}`);
      const email = String(c.profile?.mail ?? c.profile?.email ?? c.email ?? "").trim() || null;
      const stellar = typeof c.wallet === "string" ? c.wallet : String(c.wallet?.public_key ?? c.wallet?.publicKey ?? c.wallet?.address ?? c.wallet_public_key ?? "").trim() || null;
      const found = await this.findUserRow(userId, { email, stellar });
      lookup = found.path;
      if (found.row) {
        wallet = findSolanaAddress({ wallets: found.row.wallets, wallet_public_key: found.row.wallet_public_key, wallet: found.row.wallet, solana: found.row.solana });
        if (!wallet) this.log(`[fiat] users row found via ${found.path} but it has no Solana wallet yet; row shape: ${JSON.stringify(shapeOf(found.row))}`);
      }
    }
    const expiresAt = toMs(c.expiresAt);
    const name = String(c.profile?.name ?? c.profile?.displayName ?? c.profile?.display_name ?? c.name ?? "").trim() || undefined;
    const s: PollarSession = { userId, wallet, network: String(c.network ?? ""), expiresAt, authProvider: c.authProvider ? String(c.authProvider) : undefined, fresh: true, lookup, name };
    if (expiresAt > Date.now()) this.cache.set(token, { ...s, fresh: false });
    if (this.cache.size > 5000) for (const [k, v] of this.cache) if (v.expiresAt <= Date.now()) this.cache.delete(k);
    return s;
  }
  private readonly rowCache = new Map<string, { row: any; path: string; at: number }>();   // userId → the user's row (positive hits for the session, misses for a minute)
  /** One page of GET /users. Rows come as content.items (live) or users/data/rows. */
  private async usersPage(params: Record<string, string>): Promise<{ rows: any[]; total: number; page: number; totalPages: number; limit: number } | null> {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${this.base}/users?${qs}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    const p: any = await r.json().catch(() => ({}));
    if (!r.ok) { this.log(`[fiat] users lookup answered ${r.status} ${String(p.code ?? "")} for ${Object.keys(params).join(",")}`); return null; }
    const c = p.content ?? p;
    const rows: any[] = Array.isArray(c) ? c : (c.items ?? c.users ?? c.data ?? c.rows ?? []);
    const limit = Number(c.limit ?? params.limit ?? rows.length) || rows.length || 1;
    const total = Number(c.total ?? rows.length);
    return { rows, total, page: Number(c.page ?? params.page ?? 1), totalPages: Number(c.totalPages ?? c.pages ?? Math.ceil(total / limit)), limit };
  }
  /**
   * The user's row in GET /users, by exact id. `q` does not match on the user id on the live service, so: (a) q=<id>
   * anyway, (b) q=<email> then q=<Stellar public key> from the verify content, accepting only a row whose id equals the
   * verified userId, (c) page through GET /users (at most 20 pages of 200). Cached per user for the session.
   */
  async findUserRow(userId: string, hints: { email?: string | null; stellar?: string | null } = {}): Promise<{ row: any | null; path: string }> {
    if (!userId) return { row: null, path: "none" };
    const hit = this.rowCache.get(userId);
    if (hit && (hit.row || Date.now() - hit.at < 60_000)) return { row: hit.row, path: hit.path };
    const idOf = (u: any) => String(u?.id ?? u?.userId ?? u?.user_id ?? "");
    const remember = (row: any, path: string) => { this.rowCache.set(userId, { row, path, at: Date.now() }); if (row) this.log(`[fiat] users lookup found the row via ${path}`); return { row, path }; };
    try {
      const searches: [string, string | null][] = [["q=id", userId], ["q=email", hints.email ?? null], ["q=stellar", hints.stellar ?? null]];
      for (const [path, q] of searches) {
        if (!q) continue;
        const page = await this.usersPage({ q, limit: "50" });
        const me = page?.rows.find((u) => idOf(u) === userId);
        if (me) return remember(me, path);
      }
      for (let n = 1; n <= 20; n++) {
        const page = await this.usersPage({ page: String(n), limit: "200" });
        if (!page) break;
        const me = page.rows.find((u) => idOf(u) === userId);
        if (me) return remember(me, `pages (page ${n})`);
        if (!page.rows.length || n >= page.totalPages) break;
      }
      this.log(`[fiat] users lookup found no row with this id (tried q=id${hints.email ? ", q=email" : ""}${hints.stellar ? ", q=stellar" : ""}, pages)`);
      return remember(null, "none");
    } catch { this.log("[fiat] users lookup failed (network)"); return { row: null, path: "none" }; }
  }
  /** Kept for callers that only want the address. */
  async listSolanaWallet(userId: string, hints: { email?: string | null; stellar?: string | null } = {}): Promise<string | null> {
    const { row } = await this.findUserRow(userId, hints);
    return row ? findSolanaAddress({ wallets: row.wallets, wallet_public_key: row.wallet_public_key, wallet: row.wallet, solana: row.solana }) : null;
  }
}
const toMs = (x: any): number => { if (typeof x === "number") return x < 1e12 ? x * 1000 : x; const t = Date.parse(String(x ?? "")); return Number.isFinite(t) ? t : 0; };

// ---------------------------------------------------------------- Solana: confirm USDC transfers over RPC

export interface SolanaRpc {
  /** `getTransaction(sig, { encoding: "jsonParsed", commitment: "finalized" })`; null when not finalized / unknown. */
  getTransaction(signature: string): Promise<any | null>;
  /** The cluster's genesis hash, which says which network RPC_URL points at. */
  getGenesisHash(): Promise<string>;
  /** Recent signatures that touched an address, newest first (finalized). */
  getSignaturesForAddress(address: string, limit: number): Promise<{ signature: string; err: unknown }[]>;
  /** The owner's token accounts for a mint (addresses). */
  getTokenAccountsByOwner(owner: string, mint: string): Promise<string[]>;
}
export class JsonRpc implements SolanaRpc {
  private genesis: string | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  private async call(method: string, params: unknown[]) {
    let r: Response;
    try { r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new FiatError("The Solana RPC is not answering. The payment stays pending and is re-checked.", 503); }
    const j: any = await r.json().catch(() => ({}));
    if (j.error) throw new FiatError(`Solana RPC: ${j.error.message ?? "error"}`, 503);
    return j.result;
  }
  getTransaction(signature: string) { return this.call("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]); }
  async getGenesisHash() { return (this.genesis ??= String(await this.call("getGenesisHash", []))); }
  async getSignaturesForAddress(address: string, limit: number) { const r = await this.call("getSignaturesForAddress", [address, { limit, commitment: "finalized" }]); return (r ?? []).map((x: any) => ({ signature: String(x.signature), err: x.err ?? null })); }
  async getTokenAccountsByOwner(owner: string, mint: string) { const r = await this.call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]); return (r?.value ?? []).map((x: any) => String(x.pubkey)); }
}

export const GENESIS: Record<string, "mainnet" | "devnet" | "testnet"> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};
/** Circle's USDC mints. Pollar "testnet" on Solana means devnet (its SDK says so), hence devnet USDC. */
export const USDC_MINTS = { mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } as const;
/** Pollar's network word → the Solana cluster it means. */
export const pollarCluster = (network: string): "mainnet" | "devnet" | null => (network === "mainnet" ? "mainnet" : network === "testnet" ? "devnet" : null);

export interface UsdcConfig {
  /** Treasury wallet address (base58). Its USDC token account is the destination for new payments. */
  treasury: string;
  /** Earlier treasury addresses (LEGACY_TREASURY_ADDRESSES): deposits to them still count; never a destination. */
  legacy?: string[];
  /** USDC mint on the cluster RPC_URL points at. */
  mint: string;
}

/**
 * Confirm one USDC payment on-chain and credit it exactly once per signature. Amounts are integer base units
 * (micro-USDC) compared as BigInt; `amountMicro` null means "credit what the treasury received" (reconciliation).
 * Refuses (and marks failed) when the sender is not the player's wallet, the treasury did not receive the mint, or
 * the amount differs. Not yet finalized → pending (retried), never credited.
 */
export async function confirmUsdcPayment(ledger: FiatLedger, rpc: SolanaRpc, cfg: UsdcConfig, signature: string, session: PollarSession, amountMicro: number | null, store: DepositStore = ledgerStore(ledger)) {
  const user = session.wallet;
  if (!user) throw new FiatError("Your Pollar account has no Solana wallet yet.", 403);
  const existing = await store.depositOf(signature);
  if (existing) return { status: "credited" as const, credited: false, duplicate: true, micro: existing.micro };
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) throw new FiatError("That is not a Solana transaction signature.", 400);
  if (amountMicro !== null && (!Number.isInteger(amountMicro) || amountMicro <= 0)) throw new FiatError("Say how much USDC the payment was.", 400);
  // the player's Pollar app and this server must be on the same Solana network
  const cluster = GENESIS[await rpc.getGenesisHash()] ?? "unknown";
  const theirs = pollarCluster(session.network);
  if (theirs && theirs !== cluster) throw new FiatError(`Your Pollar wallet is on Solana ${theirs}, but this server settles on Solana ${cluster}. That payment cannot be credited here.`, 409);
  const tx = await rpc.getTransaction(signature);
  if (!tx) { ledger.markPending(signature, user, amountMicro ?? 0); return { status: "pending" as const, credited: false, duplicate: false, micro: amountMicro ?? 0 }; }
  if (tx.meta?.err) { ledger.markFailed(signature); throw new FiatError("That transaction failed on Solana. Nothing was credited.", 402); }
  const deltas = tokenDeltas(tx, cfg.mint);
  const treasuries = new Set([cfg.treasury, ...(cfg.legacy ?? [])]);
  const received = deltas.filter((d) => treasuries.has(d.owner)).reduce((n, d) => n + d.delta, 0n);
  const sent = deltas.filter((d) => d.owner === user).reduce((n, d) => n - d.delta, 0n);
  if (received <= 0n) { ledger.markFailed(signature); throw new FiatError("That transaction did not pay USDC to the game treasury.", 402); }
  if (sent <= 0n) { ledger.markFailed(signature); throw new FiatError("That payment was not sent from your Pollar wallet.", 403); }
  if (amountMicro !== null && received !== BigInt(amountMicro)) { ledger.markFailed(signature); throw new FiatError(`The treasury received $${microToUsd(received)}, not $${microToUsd(BigInt(amountMicro))}.`, 402); }
  const micro = Number(received);
  const credited = await store.creditDeposit(signature, user, user, micro);   // durable, exactly once
  ledger.markCredited(signature, user, micro);                                 // bookkeeping: the pending/retry record says credited
  return { status: "credited" as const, credited, duplicate: !credited, micro };
}
/** Where deposits are credited: the memory ledger, or a durable MoneyStore. */
export interface DepositStore { depositOf(signature: string): Promise<{ user: string; micro: number } | null>; creditDeposit(signature: string, user: string, wallet: string, micro: number): Promise<boolean> }
/** The memory ledger as a DepositStore (demo mode and tests): money and bookkeeping are the same record. */
export function ledgerStore(ledger: FiatLedger): DepositStore {
  return {
    async depositOf(sig) { const p = ledger.payment(sig); return p?.status === "credited" ? { user: p.user, micro: p.micro } : null; },
    async creditDeposit(sig, user, _w, micro) { return ledger.creditFromPayment(sig, user, micro).credited; },
  };
}
/** Integer micro-USD → "5.00", with no float on the way. */
export function microToUsd(m: bigint | number): string { const n = BigInt(m); const neg = n < 0n; const a = neg ? -n : n; const w = a / 1_000_000n, f = a % 1_000_000n; return `${neg ? "-" : ""}${w}.${(f / 10_000n).toString().padStart(2, "0")}`; }
/** Per token account owner: post − pre balance (base units) for one mint, from the transaction's token balances. */
export function tokenDeltasOf(tx: any, mint: string) { return tokenDeltas(tx, mint); }
function tokenDeltas(tx: any, mint: string): { owner: string; delta: bigint }[] {
  const pre = new Map<number, bigint>(), owners = new Map<number, string>();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === mint) { pre.set(b.accountIndex, BigInt(b.uiTokenAmount?.amount ?? 0)); if (b.owner) owners.set(b.accountIndex, b.owner); }
  const out: { owner: string; delta: bigint }[] = [];
  const seen = new Set<number>();
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === mint) {
    seen.add(b.accountIndex);
    const owner = b.owner ?? owners.get(b.accountIndex);
    if (owner) out.push({ owner, delta: BigInt(b.uiTokenAmount?.amount ?? 0) - (pre.get(b.accountIndex) ?? 0n) });
  }
  for (const [i, p] of pre) if (!seen.has(i) && owners.get(i)) out.push({ owner: owners.get(i)!, delta: -p });   // account closed in this tx
  return out;
}

/**
 * Reconciliation: credit finalized USDC transfers from this player's wallet to the treasury that were never credited
 * (the page's confirm call was refused, or never came). Reads the treasury's token accounts for the mint, their
 * recent signatures, and runs each unknown one through confirmUsdcPayment with no expected amount. Same
 * once-per-signature rule. Returns what was credited this time.
 */
/** What reconciliation learned about a signature, so the next pass does not fetch it again: its USDC sender, or that it is no deposit. */
const seenDeposits = new Map<string, string | null>();
export async function reconcileDeposits(ledger: FiatLedger, rpc: SolanaRpc, cfg: UsdcConfig, session: PollarSession, o: { limit?: number; log?: (line: string) => void; store?: DepositStore } = {}) {
  const credited: { signature: string; micro: number }[] = [];
  if (!session.wallet) return credited;
  const store = o.store ?? ledgerStore(ledger);
  const accounts: string[] = [];
  for (const owner of new Set([cfg.treasury, ...(cfg.legacy ?? [])])) accounts.push(...(await rpc.getTokenAccountsByOwner(owner, cfg.mint)));
  for (const account of accounts) {
    for (const { signature, err } of await rpc.getSignaturesForAddress(account, o.limit ?? 100)) {
      if (err) continue;
      if (await store.depositOf(signature)) continue;                              // once per signature
      if (seenDeposits.has(signature) && seenDeposits.get(signature) !== session.wallet) continue;   // someone else's, or no deposit
      // an earlier refusal (a wrong amount claimed by the page, say) does not stop a real deposit from being credited
      ledger.unmarkFailed(signature);
      try {
        const r = await confirmUsdcPayment(ledger, rpc, cfg, signature, session, null, store);
        if (r.status === "credited" && r.credited) { seenDeposits.set(signature, session.wallet); credited.push({ signature, micro: r.micro }); o.log?.(`[fiat] reconciled ${signature} +$${microToUsd(r.micro)} for wallet ${session.wallet.slice(0, 4)}…`); }
      } catch (e) {
        if (!(e instanceof FiatError)) throw e;
        // 403: a transfer from another wallet (it stays available to its own sender); 402: no USDC to the treasury / failed on chain
        if (e.code === 403) { ledger.unmarkFailed(signature); seenDeposits.set(signature, senderOf(await rpc.getTransaction(signature), cfg.mint)); }
        else if (e.code === 402) seenDeposits.set(signature, null);
      }
    }
  }
  return credited;
}
/** The owner that paid USDC in a transaction (the one whose balance of the mint went down), or null. */
function senderOf(tx: any, mint: string): string | null { return tx ? (tokenDeltas(tx, mint).find((d) => d.delta < 0n)?.owner ?? null) : null; }

/** base58 (Bitcoin alphabet) for a 32-byte pubkey; keeps the server free of wallet libraries. */
export function base58(bytes: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

export function pollarFromEnv(env: NodeJS.ProcessEnv = process.env): PollarGateway {
  if (!env.POLLAR_SECRET_KEY) return new MockPollar();
  return new PollarServerApi({ secretKey: env.POLLAR_SECRET_KEY, baseUrl: env.POLLAR_SERVER_API_URL });
}

/** Demo-credit mode: verify a registered mock payment and credit once. Pending/unknown payments are recorded for retry. */
export async function confirmPayment(ledger: FiatLedger, gw: MockPollar, paymentId: string, user: string) {
  const existing = ledger.payment(paymentId);
  if (existing?.status === "credited") return { status: "credited" as const, credited: false, duplicate: true, micro: existing.micro };
  const p = await gw.lookupPayment(paymentId);
  if (p.status === "paid" && p.micro !== undefined) {
    if (p.user && p.user !== user) throw new FiatError("payment belongs to another user", 403);
    const r = ledger.creditFromPayment(paymentId, user, p.micro);
    return { status: "credited" as const, ...r, micro: p.micro };
  }
  if (p.status === "failed") { ledger.markFailed(paymentId); return { status: "failed" as const, credited: false, duplicate: false, micro: 0 }; }
  ledger.markPending(paymentId, user, p.micro ?? 0);
  return { status: "pending" as const, credited: false, duplicate: false, micro: p.micro ?? 0 };
}
