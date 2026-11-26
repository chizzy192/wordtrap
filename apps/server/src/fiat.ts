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
export const toMicro = (usd: number): number => {
  const m = Math.round(Number(usd) * MICRO);
  if (!Number.isFinite(m) || m < 0) throw new FiatError(`bad amount ${usd}`, 400);
  return m;
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
export interface LedgerFile {
  version: 1;
  balances: Record<string, number>;                                  // user -> micro-USD
  payments: Record<string, { user: string; micro: number; status: PaymentStatus; ts: number; tries: number }>;
  traps: Record<string, TrapOwnership>;                              // on-chain trapId -> owner
  backers: Record<string, Record<string, number>>;                   // runId -> user -> micro-USD backed
  settled: Record<string, { ts: number; paid: Record<string, number> }>;
  history: LedgerEntry[];
}
const EMPTY = (): LedgerFile => ({ version: 1, balances: {}, payments: {}, traps: {}, backers: {}, settled: {}, history: [] });
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
  pendingPayments(): { id: string; user: string; micro: number }[] {
    return Object.entries(this.d.payments).filter(([, p]) => p.status === "pending").map(([id, p]) => ({ id, user: p.user, micro: p.micro }));
  }

  ownTrap(trapId: string, o: Omit<TrapOwnership, "status">) { this.d.traps[trapId] = { ...o, status: "armed" }; this.save(); }
  trapOwner(trapId: string): TrapOwnership | undefined { return this.d.traps[trapId]; }
  trapsOf(user: string, runId?: string): (TrapOwnership & { trapId: string })[] {
    return Object.entries(this.d.traps).filter(([, t]) => t.user === user && (!runId || t.runId === runId)).map(([trapId, t]) => ({ trapId, ...t }));
  }
  /** Pay the owner of a fired fiat mine. Idempotent per trap. */
  payTrap(trapId: string, payoutMicro: number): boolean {
    const t = this.d.traps[trapId];
    if (!t || t.status !== "armed") return false;
    t.status = "paid"; t.payout = payoutMicro;
    this.credit(t.user, payoutMicro, "mine fired", trapId);   // saves
    return true;
  }

  recordBacker(runId: string, user: string, micro: number) {
    const b = (this.d.backers[runId] ??= {});
    b[user] = (b[user] ?? 0) + micro;
    this.save();
  }
  backersOf(runId: string): Record<string, number> { return this.d.backers[runId] ?? {}; }
  /** Split the treasury's on-chain backer payout among the fiat backers of a run, pro-rata, once. */
  settleBackers(runId: string, treasuryPayoutMicro: number): Record<string, number> {
    if (this.d.settled[runId]) return this.d.settled[runId].paid;
    const backers = this.backersOf(runId);
    const total = Object.values(backers).reduce((n, x) => n + x, 0);
    const paid: Record<string, number> = {};
    for (const [user, micro] of Object.entries(backers)) {
      const share = Number(proRata(BigInt(treasuryPayoutMicro), BigInt(micro), BigInt(total)));
      paid[user] = share;
      if (share > 0) this.credit(user, share, "backer settlement", runId);
    }
    this.d.settled[runId] = { ts: Date.now(), paid };
    this.save();
    return paid;
  }
  settled(runId: string) { return this.d.settled[runId]; }

  history(user: string, n = 50): LedgerEntry[] { return this.d.history.filter((h) => h.user === user).slice(-n); }

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
  /** The player's identity: the Solana wallet address (content.wallet). */
  wallet: string;
  /** Pollar network of the application: "testnet" (Solana devnet) or "mainnet". */
  network: "testnet" | "mainnet" | string;
  /** Unix ms when the token stops being valid. */
  expiresAt: number;
  authProvider?: string;
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

/**
 * Real gateway: Pollar Server API v3 (`https://server.api.pollar.xyz/v3`), secret key in `x-pollar-api-key`.
 * `POST /tokens/verify { token }` → `{ code: "SERVER_TOKEN_VERIFIED", content: { userId, applicationId, expiresAt,
 * network, wallet, profile, authProvider } }`. Verified tokens are cached until `expiresAt`.
 */
export class PollarServerApi implements PollarGateway {
  readonly kind = "pollar" as const;
  private readonly base: string; private readonly secret: string;
  private readonly cache = new Map<string, PollarSession>();
  constructor(o: { secretKey: string; baseUrl?: string }) {
    this.secret = o.secretKey;
    this.base = (o.baseUrl ?? "https://server.api.pollar.xyz/v3").replace(/\/$/, "");
  }
  async verifySession(token: string): Promise<PollarSession> {
    const hit = this.cache.get(token);
    if (hit && hit.expiresAt > Date.now()) return hit;
    this.cache.delete(token);
    let r: Response;
    try {
      r = await fetch(`${this.base}/tokens/verify`, { method: "POST", headers: { "x-pollar-api-key": this.secret, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new FiatError("Pollar is not answering. Try again in a moment.", 503); }
    const p: any = await r.json().catch(() => ({}));
    const code = String(p.code ?? "");
    if (!r.ok || code !== "SERVER_TOKEN_VERIFIED") {
      const known = POLLAR_ERRORS[code];
      if (known) throw new FiatError(known.msg, known.code);
      if (r.status >= 500 || r.status === 429) throw new FiatError("Pollar is not answering. Try again in a moment.", 503);
      throw new FiatError("Pollar could not verify that sign-in. Sign in again.", 401);
    }
    const c = p.content ?? {};
    const wallet = walletAddress(c.wallet, c.wallets);
    if (!wallet) throw new FiatError("Your Pollar account has no Solana wallet yet. Open the wallet page once, then try again.", 403);
    const expiresAt = toMs(c.expiresAt);
    const s: PollarSession = { userId: String(c.userId ?? ""), wallet, network: String(c.network ?? ""), expiresAt, authProvider: c.authProvider ? String(c.authProvider) : undefined };
    if (expiresAt > Date.now()) this.cache.set(token, s);
    if (this.cache.size > 5000) for (const [k, v] of this.cache) if (v.expiresAt <= Date.now()) this.cache.delete(k);
    return s;
  }
}
/** content.wallet is documented as the wallet; accept a bare address, a wallet object, or a list with a SOLANA entry. */
function walletAddress(w: any, ws?: any): string | null {
  const pick = (x: any): string | null => {
    if (!x) return null;
    if (typeof x === "string") return x;
    if (Array.isArray(x)) { const sol = x.find((e) => String(e?.chain ?? "").toUpperCase() === "SOLANA") ?? x[0]; return pick(sol); }
    if (x.chain && String(x.chain).toUpperCase() !== "SOLANA" && Array.isArray(ws)) { const sol = ws.find((e: any) => String(e?.chain ?? "").toUpperCase() === "SOLANA"); if (sol) return pick(sol); }
    return typeof x.address === "string" ? x.address : typeof x.publicKey === "string" ? x.publicKey : null;
  };
  return pick(w) ?? pick(ws);
}
const toMs = (x: any): number => { if (typeof x === "number") return x < 1e12 ? x * 1000 : x; const t = Date.parse(String(x ?? "")); return Number.isFinite(t) ? t : 0; };

// ---------------------------------------------------------------- Solana: confirm a USDC transfer over RPC

export interface SolanaRpc {
  /** `getTransaction(sig, { encoding: "jsonParsed", commitment: "finalized" })`; null when not finalized / unknown. */
  getTransaction(signature: string): Promise<any | null>;
  /** The cluster's genesis hash, which says which network RPC_URL points at. */
  getGenesisHash(): Promise<string>;
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
  /** Treasury wallet address (base58). Its USDC token account is the destination. */
  treasury: string;
  /** USDC mint on the cluster RPC_URL points at. */
  mint: string;
}

/**
 * Confirm one USDC payment on-chain and credit it exactly once per signature.
 * Refuses (and marks failed) when the sender is not the player's wallet, the treasury did not receive
 * the mint, or the amount differs. Not yet finalized → pending (retried), never credited.
 */
export async function confirmUsdcPayment(ledger: FiatLedger, rpc: SolanaRpc, cfg: UsdcConfig, signature: string, session: PollarSession, amountMicro: number) {
  const user = session.wallet;
  const existing = ledger.payment(signature);
  if (existing?.status === "credited") return { status: "credited" as const, credited: false, duplicate: true, micro: existing.micro };
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) throw new FiatError("That is not a Solana transaction signature.", 400);
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new FiatError("Say how much USDC the payment was.", 400);
  // the player's Pollar app and this server must be on the same Solana network
  const cluster = GENESIS[await rpc.getGenesisHash()] ?? "unknown";
  const theirs = pollarCluster(session.network);
  if (theirs && theirs !== cluster) throw new FiatError(`Your Pollar wallet is on Solana ${theirs}, but this server settles on Solana ${cluster}. That payment cannot be credited here.`, 409);
  const tx = await rpc.getTransaction(signature);
  if (!tx) { ledger.markPending(signature, user, amountMicro); return { status: "pending" as const, credited: false, duplicate: false, micro: amountMicro }; }
  if (tx.meta?.err) { ledger.markFailed(signature); throw new FiatError("That transaction failed on Solana. Nothing was credited.", 402); }
  const deltas = tokenDeltas(tx, cfg.mint);
  const received = deltas.filter((d) => d.owner === cfg.treasury).reduce((n, d) => n + d.delta, 0n);
  const sent = deltas.filter((d) => d.owner === user).reduce((n, d) => n - d.delta, 0n);
  if (received <= 0n) { ledger.markFailed(signature); throw new FiatError("That transaction did not pay USDC to the game treasury.", 402); }
  if (sent <= 0n) { ledger.markFailed(signature); throw new FiatError("That payment was not sent from your Pollar wallet.", 403); }
  if (received !== BigInt(amountMicro)) { ledger.markFailed(signature); throw new FiatError(`The treasury received $${(Number(received) / MICRO).toFixed(2)}, not $${(amountMicro / MICRO).toFixed(2)}.`, 402); }
  const r = ledger.creditFromPayment(signature, user, amountMicro);
  return { status: "credited" as const, ...r, micro: amountMicro };
}
/** Per token account owner: post − pre balance (base units) for one mint, from the transaction's token balances. */
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
