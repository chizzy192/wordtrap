// In-memory mirror of programs/wordtrap. Same rules, same hashes — used for sim mode and tests.
import { EventEmitter } from "node:events";
import { commitment, fromHex, toHex, trapFired, bountyFor, proRata, NO_CHALLENGE, isMineable } from "@wordtrap/shared";
import type { Chain, ChainTrap, PlantArgs, RevealArgs, TrapFiredEvent } from "./types.ts";

const USDC = 1_000_000; // 6 decimals

/** Mock "pubkeys" are any string; we hash them to 32 bytes so commitments stay well-formed. */
import { sha256 } from "@noble/hashes/sha2.js";
export function mockKey(name: string): Uint8Array { return sha256(new TextEncoder().encode("mockkey:" + name)); }
/** The treasury the mock chain reports. Defaults to a derived key; with a real treasury keypair on the server
 *  (TREASURY_KEYPAIR, for USDC deposits and cash-outs) it is that keypair's public key, so the address viewers hash
 *  commitments with, pay into, and are paid from is one and the same. */
let TREASURY_PUBKEY: Uint8Array = mockKey("treasury");
export function setMockTreasury(pubkey: Uint8Array) { TREASURY_PUBKEY = pubkey; }

interface MTrap extends ChainTrap { commitment: string; stakeRaw: bigint }

export class MockChain implements Chain {
  readonly kind = "mock" as const;
  status: "open" | "live" | "ended" | "finalized" = "open";
  turn = 0;
  multiplierBps = 30_000; // trigger pays stake + 2x bounty
  minStake = 0.05;
  backers = new Map<string, bigint>();
  backerTotal = 0n;
  bountyBudget = 0n;
  vault = 0n;
  traps = new Map<string, MTrap>();
  words = new Map<string, { turns: Set<number>; challenged: number }>();
  private ev = new EventEmitter();
  private sigN = 0;

  async initMatch() { this.status = "open"; }
  async startMatch() { this.status = "live"; this.turn = 1; }
  async advanceTurn() { this.turn += 1; return this.turn; }

  async recordWords(ws: string[], kind: "spoken" | "challenged") {
    if (this.status !== "live") throw new Error("not live");
    for (const w of ws) {
      const e = this.words.get(w) ?? { turns: new Set<number>(), challenged: NO_CHALLENGE };
      if (kind === "spoken") e.turns.add(this.turn);
      else if (e.challenged === NO_CHALLENGE) e.challenged = this.turn;
      this.words.set(w, e);
    }
    return `mock-sig-${++this.sigN}`;
  }

  async endMatch() { this.status = "ended"; }

  async backByte(user: string, amount: number) {
    if (this.status !== "open" && this.status !== "live") throw new Error("closed");
    const raw = BigInt(Math.round(amount * USDC));
    this.backers.set(user, (this.backers.get(user) ?? 0n) + raw);
    this.backerTotal += raw; this.bountyBudget += raw; this.vault += raw;
  }

  async plantTrap(a: PlantArgs): Promise<ChainTrap> {
    if (this.status !== "open" && this.status !== "live") throw new Error("closed");
    if (a.stake < this.minStake) throw new Error("stake too small");
    if (this.traps.has(a.commitmentHex)) throw new Error("duplicate commitment");
    const raw = BigInt(Math.round(a.stake * USDC));
    const t: MTrap = { id: a.commitmentHex.slice(0, 16), commitment: a.commitmentHex, setter: a.setter, stake: a.stake, stakeRaw: raw, armedTurn: this.turn + 1, status: "armed" };
    this.traps.set(t.id, t);
    this.vault += raw;
    const view = this.view(t);
    this.ev.emit("planted", view);
    return view;
  }

  async revealTrap(a: RevealArgs): Promise<TrapFiredEvent> {
    const t = this.traps.get(a.trapId);
    if (!t || t.status !== "armed") throw new Error("trap not armed");
    if (t.setter !== a.setter) throw new Error("not your trap");
    if (!isMineable(a.word)) throw new Error("bad word");
    if (toHex(commitment(a.word, fromHex(a.saltHex), mockKey(a.setter))) !== t.commitment) throw new Error("bad reveal");
    const w = this.words.get(a.word);
    if (!w || !trapFired(w.turns, w.challenged, t.armedTurn)) throw new Error("not triggered");
    const bounty = bountyFor(t.stakeRaw, this.multiplierBps, this.bountyBudget);
    this.bountyBudget -= bounty;
    const payout = t.stakeRaw + bounty;
    this.vault -= payout;
    t.status = "fired"; t.word = a.word;
    const e: TrapFiredEvent = { trap: this.view(t), word: a.word, payout: Number(payout) / USDC, turn: this.turn };
    this.ev.emit("fired", e);
    return e;
  }

  /** After reveal window: what each backer takes home. */
  finalize(): Map<string, number> {
    this.status = "finalized";
    const out = new Map<string, number>();
    for (const [u, amt] of this.backers) out.set(u, Number(proRata(this.vault, amt, this.backerTotal)) / USDC);
    return out;
  }

  /** Mock treasury: the name "treasury", hashed like every other mock key. */
  treasury() { return { setter: "treasury", pubkey: TREASURY_PUBKEY }; }
  trapCommitment(trapId: string) { return this.traps.get(trapId)?.commitment; }

  onTrapFired(cb: (e: TrapFiredEvent) => void) { this.ev.on("fired", cb); }
  onTrapPlanted(cb: (t: ChainTrap) => void) { this.ev.on("planted", cb); }

  snapshot() {
    return {
      turn: this.turn,
      backerTotal: Number(this.backerTotal) / USDC,
      backerCount: [...this.backers.keys()].filter((u) => u !== "treasury").length,   // fiat backers are counted by the server ledger
      trapTotal: [...this.traps.values()].reduce((n, t) => n + t.stake, 0),
      traps: [...this.traps.values()].map((t) => this.view(t)),
    };
  }

  private view(t: MTrap): ChainTrap {
    return { id: t.id, setter: t.setter, stake: t.stake, armedTurn: t.armedTurn, status: t.status, word: t.word };
  }
}
