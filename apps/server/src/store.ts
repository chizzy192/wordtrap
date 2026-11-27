// Durable money for signed-in Pollar players. Every movement of their balance goes through a MoneyStore:
// the in-memory/file ledger (tests, demo mode, guests' test funds) or Supabase (SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY, server only). Supabase holds players(user_id, wallet, display_name),
// balances(user_id, micro), deposits(signature, user_id, wallet, micro) and ledger(id, user_id, kind, micro, ref),
// with credit_deposit(p_signature, p_user, p_wallet, p_micro) -> boolean and
// apply_delta(p_user, p_delta, p_kind, p_ref) -> new balance (raises 'insufficient funds'; a repeated
// (user, kind, ref) is a no-op). Amounts are bigint micro-dollars; refs are stable ids so a retry never pays twice.
import { createRequire } from "node:module";
import { FiatError, type FiatLedger, type LedgerEntry } from "./fiat.ts";

export const OUTAGE = "We can't reach our records right now. Try again in a minute.";
export const INSUFFICIENT = "Not enough funds. Add funds to play.";
export interface Player { userId: string; wallet: string | null; name: string | null }
export interface StakeRow { user: string; kind: string; micro: number; ref: string }

export interface MoneyStore {
  readonly kind: "memory" | "supabase";
  balance(user: string): Promise<number>;
  /** Exactly-once deposit credit; false when the signature was already credited. */
  creditDeposit(signature: string, user: string, wallet: string, micro: number): Promise<boolean>;
  depositOf(signature: string): Promise<{ user: string; micro: number } | null>;
  /** Signatures credited to this user. */
  depositsOf(user: string): Promise<string[]>;
  /** One movement, once per (user, kind, ref). FiatError 402 when funds are short, 503 when the store is unreachable. */
  applyDelta(user: string, delta: number, kind: string, ref: string): Promise<number>;
  history(user: string, n: number): Promise<LedgerEntry[]>;
  /** Stake rows (plant, back) and the rows that close them (bounty, payout, settle, refund). */
  stakeRows(): Promise<StakeRow[]>;
  /** Ledger rows of the given kinds, oldest first. */
  rows(kinds: string[]): Promise<StakeRow[]>;
  player(wallet: string): Promise<Player | null>;
  playerByUser(userId: string): Promise<Player | null>;
  upsertPlayer(p: { userId: string; wallet?: string | null; name?: string | null }): Promise<Player>;
  names(wallets: Iterable<string>): Promise<Record<string, string>>;
  ping(): Promise<boolean>;
}

/** The in-memory / file ledger as a MoneyStore (demo mode, guests, tests). */
export class MemoryMoneyStore implements MoneyStore {
  readonly kind = "memory" as const;
  private readonly players = new Map<string, Player>();   // userId → player
  readonly ledger: FiatLedger;
  constructor(ledger: FiatLedger) { this.ledger = ledger; }
  async balance(user: string) { return this.ledger.balance(user); }
  async creditDeposit(signature: string, user: string, _wallet: string, micro: number) { return this.ledger.creditFromPayment(signature, user, micro).credited; }
  async depositOf(signature: string) { const p = this.ledger.payment(signature); return p?.status === "credited" ? { user: p.user, micro: p.micro } : null; }
  async depositsOf(user: string) { return this.ledger.creditedSignatures(user); }
  async applyDelta(user: string, delta: number, kind: string, ref: string) { return this.ledger.apply(user, delta, kind, ref); }
  async history(user: string, n: number) { return this.ledger.history(user, n); }
  async stakeRows() { return this.rows(["plant", "back", "bounty", "payout", "settle", "refund"]); }
  async rows(kinds: string[]) { return this.ledger.history(undefined, 100_000).filter((h) => h.ref && kinds.includes(h.reason)).map((h) => ({ user: h.user, kind: h.reason, micro: h.delta, ref: h.ref! })); }
  async player(wallet: string) { for (const p of this.players.values()) if (p.wallet === wallet) return p; return null; }
  async playerByUser(userId: string) { return this.players.get(userId) ?? null; }
  async upsertPlayer(p: { userId: string; wallet?: string | null; name?: string | null }) {
    const cur = this.players.get(p.userId) ?? { userId: p.userId, wallet: null, name: null };
    const next = { ...cur, wallet: p.wallet === undefined ? cur.wallet : p.wallet, name: p.name === undefined ? cur.name : p.name };
    this.players.set(p.userId, next); return next;
  }
  async names(wallets: Iterable<string>) { const out: Record<string, string> = {}; for (const w of wallets) { const p = await this.player(w); if (p?.name) out[w] = p.name; } return out; }
  async ping() { return true; }
}

/** The subset of @supabase/supabase-js this store uses (so tests can hand in a fake). */
export interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
  from(table: string): any;
}
const isOutage = (e: any) => { const m = String(e?.message ?? e ?? ""); return /fetch failed|ECONN|ENOTFOUND|timeout|aborted|network|unreachable|503|502|504/i.test(m); };

/** Supabase with the service-role key. Every error that is not an application rule becomes the outage sentence. */
export class SupabaseMoneyStore implements MoneyStore {
  readonly kind = "supabase" as const;
  readonly db: SupabaseLike;
  constructor(db: SupabaseLike) { this.db = db; }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseMoneyStore | null {
    const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    // loaded lazily so a memory-only server never evaluates the client; the key is never logged or sent anywhere else
    const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input: any, init: any) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) } });
    return new SupabaseMoneyStore(client as unknown as SupabaseLike);
  }
  private async q<T>(run: () => PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
    let r: { data: T; error: { message: string } | null };
    try { r = await run(); } catch (e) { throw new FiatError(OUTAGE, 503); }
    if (r.error) {
      if (/insufficient/i.test(r.error.message)) throw new FiatError(INSUFFICIENT, 402);
      throw new FiatError(OUTAGE, 503);
    }
    return r.data;
  }
  async balance(user: string) { const d: any = await this.q(() => this.db.from("balances").select("micro").eq("user_id", user).maybeSingle()); return Number(d?.micro ?? 0); }
  async creditDeposit(signature: string, user: string, wallet: string, micro: number) { return !!(await this.q(() => this.db.rpc("credit_deposit", { p_signature: signature, p_user: user, p_wallet: wallet, p_micro: micro }))); }
  async depositOf(signature: string) { const d: any = await this.q(() => this.db.from("deposits").select("user_id, micro").eq("signature", signature).maybeSingle()); return d ? { user: String(d.user_id), micro: Number(d.micro) } : null; }
  async depositsOf(user: string) { const d: any[] = (await this.q(() => this.db.from("deposits").select("signature").eq("user_id", user))) ?? []; return d.map((r) => String(r.signature)); }
  async applyDelta(user: string, delta: number, kind: string, ref: string) { return Number(await this.q(() => this.db.rpc("apply_delta", { p_user: user, p_delta: delta, p_kind: kind, p_ref: ref }))); }
  async history(user: string, n: number) {
    const rows: any[] = (await this.q(() => this.db.from("ledger").select("id, user_id, kind, micro, ref").eq("user_id", user).order("id", { ascending: false }).limit(n))) ?? [];
    return rows.reverse().map((r) => ({ ts: 0, user: String(r.user_id), delta: Number(r.micro), reason: String(r.kind), ref: r.ref == null ? undefined : String(r.ref) }));
  }
  async stakeRows() { return this.rows(["plant", "back", "bounty", "payout", "settle", "refund"]); }
  async rows(kinds: string[]) {
    const rows: any[] = (await this.q(() => this.db.from("ledger").select("user_id, kind, micro, ref").in("kind", kinds).order("id", { ascending: true }))) ?? [];
    return rows.map((r) => ({ user: String(r.user_id), kind: String(r.kind), micro: Number(r.micro), ref: String(r.ref ?? "") }));
  }
  private row(d: any): Player | null { return d ? { userId: String(d.user_id), wallet: d.wallet == null ? null : String(d.wallet), name: d.display_name == null ? null : String(d.display_name) } : null; }
  async player(wallet: string) { return this.row(await this.q(() => this.db.from("players").select("user_id, wallet, display_name").eq("wallet", wallet).maybeSingle())); }
  async playerByUser(userId: string) { return this.row(await this.q(() => this.db.from("players").select("user_id, wallet, display_name").eq("user_id", userId).maybeSingle())); }
  async upsertPlayer(p: { userId: string; wallet?: string | null; name?: string | null }) {
    const cur = await this.playerByUser(p.userId);
    const row = { user_id: p.userId, wallet: p.wallet === undefined ? cur?.wallet ?? null : p.wallet, display_name: p.name === undefined ? cur?.name ?? null : p.name };
    await this.q(() => this.db.from("players").upsert(row, { onConflict: "user_id" }));
    return { userId: p.userId, wallet: row.wallet, name: row.display_name };
  }
  async names(wallets: Iterable<string>) {
    const list = [...wallets].filter(Boolean); if (!list.length) return {};
    const rows: any[] = (await this.q(() => this.db.from("players").select("wallet, display_name").in("wallet", list))) ?? [];
    const out: Record<string, string> = {}; for (const r of rows) if (r.display_name) out[String(r.wallet)] = String(r.display_name); return out;
  }
  async ping() { try { await this.q(() => this.db.from("balances").select("user_id").limit(1)); return true; } catch { return false; } }
}

/** Bind a Pollar user to one wallet, once: one wallet per user, one user per wallet, never changed here. */
export async function bindWallet(store: MoneyStore, userId: string, wallet: string): Promise<string> {
  const mine = await store.playerByUser(userId);
  if (mine?.wallet) { if (mine.wallet !== wallet) throw new FiatError("This Pollar account is already linked to a different wallet.", 409); return mine.wallet; }
  const owner = await store.player(wallet);
  if (owner && owner.userId !== userId) throw new FiatError("That wallet is already linked to another Pollar account.", 409);
  await store.upsertPlayer({ userId, wallet });
  return wallet;
}

/**
 * Open positions after a restart: stake rows (plant, back) whose run never settled (no bounty/payout/settle row that
 * closes them) are refunded with kind 'refund', ref 'refund:<original ref>', so running this twice refunds once.
 * Returns the refunds made; the caller logs one line per refund with the amount.
 */
export async function refundOrphans(store: MoneyStore, liveRunIds: Set<string> = new Set()): Promise<{ user: string; micro: number; ref: string }[]> {
  const rows = await store.stakeRows();
  const closed = new Set<string>();      // refs closed by a bounty / payout / settle / refund
  for (const r of rows) {
    if (r.kind === "refund") closed.add(r.ref.replace(/^refund:/, ""));
    if (r.kind === "bounty") closed.add(r.ref.replace(":bounty:", ":plant:"));
    if (r.kind === "payout" || r.kind === "settle") { const [runId] = r.ref.split(":"); closed.add(`${runId}:*:${r.user}`); }
  }
  const out: { user: string; micro: number; ref: string }[] = [];
  for (const r of rows) {
    if (r.kind !== "plant" && r.kind !== "back") continue;
    const [runId] = r.ref.split(":");
    if (liveRunIds.has(runId) || closed.has(r.ref) || closed.has(`${runId}:*:${r.user}`)) continue;
    const micro = Math.abs(r.micro);
    await store.applyDelta(r.user, micro, "refund", `refund:${r.ref}`);
    out.push({ user: r.user, micro, ref: r.ref });
  }
  return out;
}

/** First start with Supabase: copy credited signatures and balances of wallet players from the old ledger file, once. */
export async function migrateLedger(ledger: FiatLedger, store: MoneyStore): Promise<{ deposits: number; balances: number }> {
  let deposits = 0, balances = 0;
  const isWallet = (u: string) => !u.startsWith("guest-") && u.length >= 32;
  const perUser = new Map<string, number>();
  for (const [sig, p] of Object.entries(ledger.payments())) {
    if (p.status !== "credited" || !isWallet(p.user)) continue;
    perUser.set(p.user, (perUser.get(p.user) ?? 0) + p.micro);
    if (await store.creditDeposit(sig, p.user, p.user, p.micro)) deposits++;
  }
  for (const [user, micro] of Object.entries(ledger.balances())) {
    if (!isWallet(user)) continue;
    const rest = micro - (perUser.get(user) ?? 0);     // what the deposits do not explain (stakes spent, bounties won)
    if (rest === 0) continue;
    const before = await store.balance(user);
    await store.applyDelta(user, rest, "migrate", `migrate:${user}`);
    if ((await store.balance(user)) !== before) balances++;
  }
  return { deposits, balances };
}
