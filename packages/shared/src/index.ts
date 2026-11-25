// Shared WordTrap rules. Must stay byte-for-byte compatible with programs/wordtrap/src/lib.rs.
import { sha256 } from "@noble/hashes/sha2.js";

export const MAX_TURNS = 128;
export const MAX_WORD_LEN = 32;
export const NO_CHALLENGE = 0xffff;
const enc = new TextEncoder();
const COMMIT_DOMAIN = enc.encode("wordtrap:v1");
const WORD_DOMAIN = enc.encode("wordtrap:word");

export type ActionType = "PLAY_WORD_CARD" | "BUY_HINT" | "DEFUSE_TILE" | "CHALLENGE_TRAP" | "PASS_TURN";
export const ACTIONS: ActionType[] = ["PLAY_WORD_CARD", "BUY_HINT", "DEFUSE_TILE", "CHALLENGE_TRAP", "PASS_TURN"];

/** Lowercase, strip everything that is not a-z. Returns "" if nothing usable. */
export function normalizeWord(raw: string): string {
  const w = raw.toLowerCase().replace(/[^a-z]/g, "");
  return w.length > MAX_WORD_LEN ? "" : w;
}

/** Every distinct normalized word in a chunk of speech, in order of first appearance. */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s\-—–/]+/)) {
    const w = normalizeWord(raw);
    if (w && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

/** Glue words can't be mined (otherwise "the" wins every match) and aren't recorded on-chain. */
export const STOP_WORDS = new Set((
  "a an the and or but if of to in on at by for with from as is am are was were be been it its i im me my we our you your " +
  "he she they them this that these those so not no yes do does did just ok okay oh um uh hmm"
).split(" "));
export const MIN_MINE_LEN = 3;
export function isMineable(w: string): boolean {
  return isValidWord(w) && w.length >= MIN_MINE_LEN && !STOP_WORDS.has(w);
}

export function isValidWord(w: string): boolean {
  return w.length > 0 && w.length <= MAX_WORD_LEN && /^[a-z]+$/.test(w);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function wordHash(word: string): Uint8Array {
  return sha256(concat(WORD_DOMAIN, enc.encode(word)));
}

/** setter = 32-byte public key. salt = 32 random bytes kept secret on the setter's device. */
export function commitment(word: string, salt: Uint8Array, setter: Uint8Array): Uint8Array {
  if (!isValidWord(word)) throw new Error(`invalid word: ${word}`);
  if (salt.length !== 32 || setter.length !== 32) throw new Error("salt and setter must be 32 bytes");
  return sha256(concat(COMMIT_DOMAIN, enc.encode(word), salt, setter));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Mirrors trap_fired() in the program. spokenTurns = set of turns the word was said. */
export function trapFired(spokenTurns: Iterable<number>, challengedTurn: number, armedTurn: number): boolean {
  for (const t of spokenTurns) {
    if (t < armedTurn) continue;
    if (challengedTurn === NO_CHALLENGE || challengedTurn < armedTurn) return true;
    if (t < challengedTurn) return true;
  }
  return false;
}

export function bountyFor(stake: bigint, multiplierBps: number, budget: bigint): bigint {
  const extra = (stake * BigInt(multiplierBps - 10_000)) / 10_000n;
  return extra < budget ? extra : budget;
}

export function proRata(pool: bigint, amount: bigint, total: bigint): bigint {
  return total === 0n ? 0n : (pool * amount) / total;
}

// ---------- live feed types (server -> watch page / mobile) ----------

export interface TrapView { id: string; setter: string; stake: number; armedTurn: number; status: "armed" | "fired" | "refunded"; word?: string }

export interface BoardState {
  matchId: string;
  matchPda?: string;         // on-chain Game account (solana mode)
  status: "open" | "live" | "ended" | "finalized";
  turn: number;
  position: number;          // tile index Byte stands on
  tiles: { prompt: string; cleared: boolean }[];
  fuseMs: number;            // remaining fuse
  fuseTotalMs: number;
  spoken: { word: string; turn: number }[];
  challenged: { word: string; turn: number }[];
  traps: TrapView[];
  backerTotal: number;       // USDC (UI units)
  trapTotal: number;
  defusesLeft: number;
  hintsBought: number;
  hintSpendUsd: number;
  byteSurvived?: boolean;
}

export type FeedEvent =
  | { type: "state"; state: BoardState }
  | { type: "narration"; text: string; turn: number }
  | { type: "action"; action: ActionType; detail: string; turn: number }
  | { type: "hint"; scores: Record<string, number>; costUsd: number; txSig: string }
  | { type: "trap_planted"; trap: TrapView }
  | { type: "trap_fired"; trap: TrapView; payout: number; fuseBurnMs: number }
  | { type: "turn_window"; turn: number; closesInMs: number }
  | { type: "match_end"; byteSurvived: boolean; reason: string };
