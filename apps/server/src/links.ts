// Proof-of-control wallet linking, for a Pollar account whose Solana address Pollar's server side will not give us.
// The page asks the user to pay a one-time amount ($1 plus a random 1–9999 micro-dollar tail, e.g. 1.004217 USDC)
// from the wallet they claim. Only a finalized transfer of exactly that amount, from that address, to the treasury,
// inside the 10-minute window, binds the address to the verified Pollar userId (one address per user, one user per
// address, permanent) and credits the full amount as a normal deposit. A claim alone never binds.
import { FiatError, tokenDeltasOf, type SolanaRpc, type UsdcConfig, isSolanaAddress, microToUsd } from "./fiat.ts";
import type { MoneyStore } from "./store.ts";

export const LINK_BASE_MICRO = 1_000_000, LINK_WINDOW_MS = 10 * 60_000;
export const LINK_WORDING = (amountText: string) => `One-time wallet check: confirm a payment of $${amountText}. It is added to your game balance.`;
export interface OpenLink { userId: string; amountMicro: number; createdAt: number; expiresAt: number }
export type LinkResult =
  | { status: "linked"; wallet: string; credited: number; signature: string }
  | { status: "pending"; reason: string }
  | { status: "refused"; reason: string };

export class WalletLinks {
  private readonly open = new Map<string, OpenLink>();          // userId → the one open link
  private readonly rpc: SolanaRpc; private readonly cfg: () => Promise<UsdcConfig>; private readonly players: MoneyStore;
  private readonly storeFor: (user: string) => MoneyStore; private readonly log: (line: string) => void; private readonly now: () => number;
  private readonly random: () => number;
  constructor(o: { rpc: SolanaRpc; cfg: () => Promise<UsdcConfig>; players: MoneyStore; storeFor: (user: string) => MoneyStore; log?: (line: string) => void; now?: () => number; random?: () => number }) {
    this.rpc = o.rpc; this.cfg = o.cfg; this.players = o.players; this.storeFor = o.storeFor; this.log = o.log ?? (() => {}); this.now = o.now ?? Date.now; this.random = o.random ?? Math.random;
  }
  /** A one-time amount for this user, valid 10 minutes, unique among open links. Asking again returns the same open one. */
  start(userId: string): OpenLink & { amountText: string; wording: string } {
    this.sweep();
    let link = this.open.get(userId);
    if (!link) {
      const taken = new Set([...this.open.values()].map((l) => l.amountMicro));
      let amountMicro = 0;
      for (let i = 0; i < 100 && (!amountMicro || taken.has(amountMicro)); i++) amountMicro = LINK_BASE_MICRO + 1 + Math.floor(this.random() * 9999);
      if (taken.has(amountMicro)) throw new FiatError("Too many wallet checks are open right now. Try again in a few minutes.", 503);
      link = { userId, amountMicro, createdAt: this.now(), expiresAt: this.now() + LINK_WINDOW_MS };
      this.open.set(userId, link);
    }
    const amountText = microToUsd6(link.amountMicro);
    return { ...link, amountText, wording: LINK_WORDING(amountText) };
  }
  openFor(userId: string): OpenLink | null { this.sweep(); return this.open.get(userId) ?? null; }
  private sweep() { const t = this.now(); for (const [u, l] of this.open) if (l.expiresAt + 5 * 60_000 < t) this.open.delete(u); }   // kept a little past expiry so a late payment can be explained

  /**
   * Prove control: the signature (or, without one, a scan of the treasury's recent transfers) must show a finalized
   * transfer of exactly the link amount from `address` to the treasury, sent inside the window.
   */
  async confirm(userId: string, address: string, signature: string | null): Promise<LinkResult> {
    if (!isSolanaAddress(address)) return { status: "refused", reason: "That is not a Solana wallet address." };
    const link = this.openFor(userId);
    if (!link) return { status: "refused", reason: "No wallet check is open. Start one and pay the exact amount within 10 minutes." };
    const cfg = await this.cfg();
    const treasuries = new Set([cfg.treasury, ...(cfg.legacy ?? [])]);
    const candidates = signature ? [signature] : await this.recentFrom(address, cfg);
    let seenTransfer = false;
    for (const sig of candidates) {
      const tx = await this.rpc.getTransaction(sig);
      if (!tx) continue;
      if (tx.meta?.err) continue;
      const deltas = tokenDeltasOf(tx, cfg.mint);
      const received = deltas.filter((d) => treasuries.has(d.owner)).reduce((n, d) => n + d.delta, 0n);
      const sent = deltas.filter((d) => d.owner === address).reduce((n, d) => n - d.delta, 0n);
      if (received <= 0n || sent <= 0n) continue;
      seenTransfer = true;
      if (received !== BigInt(link.amountMicro)) return { status: "refused", reason: `That payment was $${microToUsd6(Number(received))}, not the one-time amount of $${microToUsd6(link.amountMicro)}. Nothing was linked.` };
      const at = typeof tx.blockTime === "number" ? tx.blockTime * 1000 : this.now();
      if (at > link.expiresAt) return { status: "refused", reason: "That payment arrived after the 10-minute window. Nothing was linked; start a new wallet check." };
      // binding rules: one address per user, one user per address, permanent; checked again right before writing
      const mine = await this.players.playerByUser(userId);
      if (mine?.wallet && mine.wallet !== address) return { status: "refused", reason: "This Pollar account is already linked to a different wallet." };
      const owner = await this.players.player(address);
      if (owner && owner.userId !== userId) return { status: "refused", reason: "That wallet is already linked to another Pollar account." };
      if (await this.storeFor(address).depositOf(sig)) return { status: "refused", reason: "That payment was already used. Start a new wallet check." };
      await this.players.upsertPlayer({ userId, wallet: address });
      const credited = await this.storeFor(address).creditDeposit(sig, address, address, link.amountMicro);
      this.open.delete(userId);
      this.log(`[fiat] wallet linked by proof of control for Pollar user ${userId.slice(0, 6)}… (+$${microToUsd6(link.amountMicro)} credited${credited ? "" : ", already"})`);
      return { status: "linked", wallet: address, credited: link.amountMicro, signature: sig };
    }
    if (signature && !seenTransfer) return { status: "pending", reason: "Waiting for Solana to finalize your payment." };
    return { status: "pending", reason: "No payment of the one-time amount from that wallet has reached the treasury yet." };
  }
  /** Signatures touching the treasury's token accounts, newest first (used when the page has no signature). */
  private async recentFrom(_address: string, cfg: UsdcConfig): Promise<string[]> {
    const out: string[] = [];
    for (const owner of new Set([cfg.treasury, ...(cfg.legacy ?? [])])) {
      for (const account of await this.rpc.getTokenAccountsByOwner(owner, cfg.mint)) for (const s of await this.rpc.getSignaturesForAddress(account, 50)) if (!s.err) out.push(s.signature);
    }
    return out;
  }
}
/** 1004217 → "1.004217" (six decimals, no float). */
export function microToUsd6(micro: number): string { const n = BigInt(micro); return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`; }
