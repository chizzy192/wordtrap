// Cash-out: a signed-in Pollar player moves game balance back to their own Pollar Solana wallet as USDC.
// Order of operations, so money is never sent twice and never lost:
//   1. apply_delta(-amount, 'withdraw', 'withdraw:<requestId>')  — the balance drops first; a repeat is a no-op
//   2. the treasury signs the transfer; the signature is recorded ('withdraw-pending') BEFORE it is broadcast
//   3. finalized → 'withdraw-sent' (same ref); a definite failure → refund 'refund:withdraw:<requestId>'
//   4. unknown outcome (timeout) → stays pending; re-checked every 30 s and on startup, then settled one way or the other
// The destination is always the wallet Pollar verified for the user. Never a client-supplied address.
import { FiatError, toMicro, microToUsd } from "./fiat.ts";
import type { MoneyStore } from "./store.ts";
import { MIN_SOL_LAMPORTS, type TreasuryWallet, type Finality } from "./treasury.ts";

export const MIN_WITHDRAW_MICRO = 1_000_000;
export const PAUSED = "Withdrawals are paused for a moment. Your balance is safe.";
export const NOT_SET_UP = "Withdrawals aren't set up on this server yet.";
export const KINDS = ["withdraw", "withdraw-pending", "withdraw-sent", "refund"] as const;

export type WithdrawResult =
  | { status: "sent"; requestId: string; micro: number; signature: string }
  | { status: "pending"; requestId: string; micro: number; signature: string | null }
  | { status: "refunded"; requestId: string; micro: number; reason: string };

interface Open { user: string; micro: number; requestId: string; pending: { signature: string; lastValidBlockHeight: number } | null }

export class Withdrawals {
  private readonly inflight = new Set<string>();
  private readonly recent = new Map<string, number[]>();     // user → request times (sliding hour)
  private readonly stores: () => MoneyStore[];
  private readonly storeFor: (user: string) => MoneyStore;
  private readonly treasury: () => TreasuryWallet | null;
  private readonly log: (line: string) => void;
  readonly waitMs: number; readonly pollMs: number;
  constructor(o: { storeFor: (user: string) => MoneyStore; stores: () => MoneyStore[]; treasury: () => TreasuryWallet | null; log?: (line: string) => void; waitMs?: number; pollMs?: number }) {
    this.storeFor = o.storeFor; this.stores = o.stores; this.treasury = o.treasury; this.log = o.log ?? (() => {});
    this.waitMs = o.waitMs ?? 45_000; this.pollMs = o.pollMs ?? 2_000;
  }

  /** POST /api/v1/fiat/withdraw for a verified Pollar user; `wallet` is the address Pollar verified. */
  async request(user: string, wallet: string, amountText: unknown, requestIdRaw: unknown): Promise<{ http: number; body: WithdrawResult }> {
    const requestId = String(requestIdRaw ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new FiatError("requestId must be 8 to 64 letters, digits, - or _.", 400);
    const micro = toMicro(String(amountText ?? "").trim());
    const store = this.storeFor(user);
    const ref = `withdraw:${requestId}`;
    // a repeated requestId answers what happened to it; nothing is sent twice
    const known = await this.lookup(store, user, requestId);
    if (known) return known;
    if (micro < MIN_WITHDRAW_MICRO) throw new FiatError("The minimum withdrawal is $1.00.", 400);
    const balance = await store.balance(user);
    if (micro > balance) throw new FiatError(`You can withdraw at most $${microToUsd(balance)}.`, 402);
    if (this.inflight.has(user)) throw new FiatError("A withdrawal is already in progress. Wait for it to finish.", 409);
    const now = Date.now(); const times = (this.recent.get(user) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= 5) throw new FiatError("You've reached five withdrawals this hour. Try again later.", 429);
    const treasury = this.treasury();
    if (!treasury) throw new FiatError(NOT_SET_UP, 503);
    // the treasury must hold the USDC and the SOL for the fee before any balance moves
    const h = await treasury.holdings();
    if (h.usdcMicro < BigInt(micro)) { this.log(`[fiat] withdrawals paused: treasury USDC short (has $${microToUsd(h.usdcMicro)}, needs $${microToUsd(micro)})`); throw new FiatError(PAUSED, 503); }
    if (h.lamports < MIN_SOL_LAMPORTS) { this.log(`[fiat] withdrawals paused: treasury SOL short (has ${h.lamports} lamports, needs ${MIN_SOL_LAMPORTS})`); throw new FiatError(PAUSED, 503); }
    this.inflight.add(user); times.push(now); this.recent.set(user, times);
    try {
      await store.applyDelta(user, -micro, "withdraw", ref);                                  // 1. balance drops first
      const prepared = await treasury.prepare(wallet, BigInt(micro));                       // 2. signed, not yet broadcast
      await store.applyDelta(user, 0, "withdraw-pending", `${ref}:${prepared.signature}:${prepared.lastValidBlockHeight}`);
      const out = await prepared.broadcast();
      if (out.status === "failed") return { http: 502, body: await this.refund(store, user, micro, requestId, out.reason) };
      const fin = await this.waitFinal(treasury, prepared.signature, prepared.lastValidBlockHeight);
      return this.settle(store, user, micro, requestId, prepared.signature, fin);
    } finally { this.inflight.delete(user); }
  }

  /** What a requestId already became, or null when it is new. */
  private async lookup(store: MoneyStore, user: string, requestId: string): Promise<{ http: number; body: WithdrawResult } | null> {
    const ref = `withdraw:${requestId}`;
    const rows = (await store.rows([...KINDS])).filter((r) => r.user === user && (r.ref === ref || r.ref.startsWith(`${ref}:`) || r.ref === `refund:${ref}`));
    const debit = rows.find((r) => r.kind === "withdraw");
    if (!debit) return null;
    const micro = Math.abs(debit.micro);
    const pending = rows.find((r) => r.kind === "withdraw-pending");
    const signature = pending ? pending.ref.split(":")[2] : null;
    if (rows.some((r) => r.kind === "withdraw-sent")) return { http: 200, body: { status: "sent", requestId, micro, signature: signature ?? "" } };
    if (rows.some((r) => r.kind === "refund")) return { http: 200, body: { status: "refunded", requestId, micro, reason: "The transfer did not go through. Your balance was restored." } };
    return { http: 202, body: { status: "pending", requestId, micro, signature } };
  }

  private async refund(store: MoneyStore, user: string, micro: number, requestId: string, reason: string): Promise<WithdrawResult> {
    await store.applyDelta(user, micro, "refund", `refund:withdraw:${requestId}`);
    this.log(`[fiat] withdrawal ${requestId} refunded $${microToUsd(micro)}: ${reason}`);
    return { status: "refunded", requestId, micro, reason: "The transfer did not go through. Your balance was restored." };
  }

  private async waitFinal(treasury: TreasuryWallet, signature: string, lastValidBlockHeight: number): Promise<Finality> {
    const t0 = Date.now();
    for (;;) {
      const f = await treasury.finality(signature, lastValidBlockHeight);
      if (f !== "unknown" || Date.now() - t0 > this.waitMs) return f;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private async settle(store: MoneyStore, user: string, micro: number, requestId: string, signature: string, fin: Finality): Promise<{ http: number; body: WithdrawResult }> {
    if (fin === "finalized") {
      await store.applyDelta(user, 0, "withdraw-sent", `withdraw:${requestId}`);
      this.log(`[fiat] withdrawal ${requestId} sent $${microToUsd(micro)} (${signature})`);
      return { http: 200, body: { status: "sent", requestId, micro, signature } };
    }
    if (fin === "failed" || fin === "expired") return { http: 502, body: await this.refund(store, user, micro, requestId, fin === "failed" ? "failed on chain" : "expired before it was included") };
    return { http: 202, body: { status: "pending", requestId, micro, signature } };   // unknown: never refunded here; the sweep settles it
  }

  /** Every 30 s and on startup: settle withdrawals whose outcome was unknown, and refund debits that were never sent. */
  async sweep(): Promise<{ settled: number; refunded: number }> {
    const treasury = this.treasury();
    let settled = 0, refunded = 0;
    for (const store of this.stores()) {
      let open: Open[];
      try { open = await this.openOnes(store); } catch { continue; }
      for (const w of open) {
        if (this.inflight.has(w.user)) continue;
        try {
          if (!w.pending) { await this.refund(store, w.user, w.micro, w.requestId, "never broadcast"); refunded++; continue; }
          if (!treasury) continue;
          const fin = await treasury.finality(w.pending.signature, w.pending.lastValidBlockHeight);
          if (fin === "unknown") continue;
          const r = await this.settle(store, w.user, w.micro, w.requestId, w.pending.signature, fin);
          if (r.body.status === "sent") settled++; else if (r.body.status === "refunded") refunded++;
        } catch (e) { this.log(`[fiat] withdrawal ${w.requestId} still unsettled: ${(e as Error).message}`); }
      }
    }
    return { settled, refunded };
  }

  private async openOnes(store: MoneyStore): Promise<Open[]> {
    const rows = await store.rows([...KINDS]);
    const out: Open[] = [];
    for (const r of rows) {
      if (r.kind !== "withdraw") continue;
      const requestId = r.ref.slice("withdraw:".length);
      if (rows.some((x) => x.kind === "withdraw-sent" && x.ref === r.ref) || rows.some((x) => x.kind === "refund" && x.ref === `refund:${r.ref}`)) continue;
      const p = rows.find((x) => x.kind === "withdraw-pending" && x.ref.startsWith(`${r.ref}:`));
      const parts = p ? p.ref.split(":") : null;
      out.push({ user: r.user, micro: Math.abs(r.micro), requestId, pending: parts ? { signature: parts[2], lastValidBlockHeight: Number(parts[3]) } : null });
    }
    return out;
  }
}
