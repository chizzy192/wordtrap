// Fiat staking (Pollar). Viewers who sign in with Google (or an external wallet) hold a ledger
// balance in INTEGER micro-USD; the server's treasury keypair is the on-chain setter/backer for
// all of their mines and backs. Invariants (docs/ARCHITECTURE.md "Fiat staking"):
//   I1 treasury is the on-chain setter  I2 salt+word stay in the browser until played
//   I3 integer micro-USD                I4 every change is persisted atomically
//   I5 credits need SERVER-SIDE verification of the Pollar payment, exactly once per payment id
//   I6 viewer identity is validated server-side (Pollar session) — mock mode: plain {user}
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
  pendingPayments(): { id: string; user: string }[] {
    return Object.entries(this.d.payments).filter(([, p]) => p.status === "pending").map(([id, p]) => ({ id, user: p.user }));
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

// ---------------------------------------------------------------- Pollar gateway (I5, I6)

export interface PaymentLookup { status: "paid" | "pending" | "failed" | "unknown"; micro?: number; user?: string }
export interface PollarGateway {
  readonly kind: "mock" | "pollar";
  /** Look a payment / funding / ramp order up by id with the SECRET key. Client callbacks are hints, not money. */
  lookupPayment(paymentId: string): Promise<PaymentLookup>;
  /** Validate a viewer session token and return the Pollar user id. */
  verifySession(token: string): Promise<{ userId: string } | null>;
}

/** Demo-credit mode: no Pollar keys. Payments are registered by POST /dev/credit; sessions are plain user names. */
export class MockPollar implements PollarGateway {
  readonly kind = "mock" as const;
  readonly payments = new Map<string, PaymentLookup>();
  register(paymentId: string, user: string, micro: number, status: PaymentLookup["status"] = "paid") { this.payments.set(paymentId, { status, micro, user }); }
  async lookupPayment(id: string): Promise<PaymentLookup> { return this.payments.get(id) ?? { status: "unknown" }; }
  async verifySession(token: string) { const m = /^mock:(.+)$/.exec(token); return m ? { userId: m[1] } : null; }
}

/**
 * Real gateway: Pollar Server API v3 with the secret key (server env only).
 * STATUS (Nov 25): docs.pollar.xyz was unreachable and the open-source SDK repo documents no
 * server-side payment lookup or session verification endpoint, so the two paths below are
 * CONFIGURABLE and must be confirmed against the docs before mainnet:
 *   POLLAR_PAYMENT_PATH  default /payments/{id}      (GET, Authorization: Bearer <secret>)
 *   POLLAR_SESSION_PATH  default /auth/session       (POST {token}, Authorization: Bearer <secret>)
 * Unverifiable payments stay "pending" and are retried; they are never credited.
 */
export class PollarHttp implements PollarGateway {
  readonly kind = "pollar" as const;
  private readonly base: string; private readonly secret: string; private readonly paymentPath: string; private readonly sessionPath: string;
  constructor(o: { secretKey: string; baseUrl?: string; paymentPath?: string; sessionPath?: string }) {
    this.secret = o.secretKey;
    this.base = (o.baseUrl ?? "https://sdk.api.pollar.xyz/v3").replace(/\/$/, "");
    this.paymentPath = o.paymentPath ?? "/payments/{id}";
    this.sessionPath = o.sessionPath ?? "/auth/session";
  }
  private headers() { return { authorization: `Bearer ${this.secret}`, "content-type": "application/json", accept: "application/json" }; }

  async lookupPayment(id: string): Promise<PaymentLookup> {
    const r = await fetch(this.base + this.paymentPath.replace("{id}", encodeURIComponent(id)), { headers: this.headers() });
    if (r.status === 404) return { status: "unknown" };
    if (!r.ok) return { status: "pending" };                         // 5xx / 429: retry later, never credit
    const p: any = await r.json();
    const raw = String(p.status ?? p.state ?? "").toUpperCase();
    const status: PaymentLookup["status"] =
      ["SUCCESS", "CREDITED", "PAID", "COMPLETED", "SETTLED", "MINTED"].includes(raw) ? "paid"
      : ["FAILED", "CANCELLED", "CANCELED", "EXPIRED", "REJECTED"].includes(raw) ? "failed" : "pending";
    const cur = String(p.currency ?? p.fiat ?? p.asset ?? "USD").toUpperCase();
    const usd = Number(p.amount_usd ?? p.amountUsd ?? (cur === "USD" || cur === "USDC" ? p.amount : NaN));
    const micro = Number.isFinite(usd) ? Math.round(usd * MICRO) : undefined;
    const user = p.user_id ?? p.userId ?? p.user?.id ?? p.owner ?? undefined;
    return status === "paid" && micro === undefined ? { status: "pending", user } : { status, micro, user };
  }

  async verifySession(token: string) {
    const r = await fetch(this.base + this.sessionPath, { method: "POST", headers: this.headers(), body: JSON.stringify({ token }) });
    if (!r.ok) return null;
    const p: any = await r.json();
    const userId = p.user_id ?? p.userId ?? p.sub ?? p.user?.id ?? p.id;
    return userId ? { userId: String(userId) } : null;
  }
}

export function pollarFromEnv(env: NodeJS.ProcessEnv = process.env): PollarGateway {
  if (!env.POLLAR_SECRET_KEY) return new MockPollar();
  return new PollarHttp({ secretKey: env.POLLAR_SECRET_KEY, baseUrl: env.POLLAR_API_URL, paymentPath: env.POLLAR_PAYMENT_PATH, sessionPath: env.POLLAR_SESSION_PATH });
}

/** Verify + credit once. Pending/unknown payments are recorded for retry, never credited. */
export async function confirmPayment(ledger: FiatLedger, gw: PollarGateway, paymentId: string, user: string) {
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
