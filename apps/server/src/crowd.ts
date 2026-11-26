// Simulated viewers (mock chain only). Behaves like the mobile app: picks a word, keeps the salt
// locally, commits the hash, and reveals the moment Byte PLAYS the word (never before it is armed).
// Viewers can see Byte's hand — that is the point: the obvious cards are the tempting ones.
//
// Drama over spread: each turn most setters stack onto the SAME 1–2 most obvious cards of the
// current tile (several mines on one word = one MULTI-BOOM). A quarter of plants go sideways:
// a random hand card, a word Byte keeps playing (habit punishment), or a word Byte just
// challenged (the counter-mine mind game — a challenge only disarms what is already live).
import { randomBytes } from "node:crypto";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain, mockKey } from "./chain/mock.ts";
import type { Match } from "./match.ts";

export interface CrowdOptions {
  setters: number;
  /** Probability that each setter plants on a given turn. */
  aggression: number;
  /** Share of plants that go to the 1–2 focus (most obvious) cards; the rest spread. */
  focus: number;
  /** Total USDC the mock backers put behind Byte (spread across the setters). */
  backerUsd: number;
  rnd?: () => number;
  /** How many bots plant this turn (one per empty seat). Defaults to `setters`. */
  setterCount?: () => number;
}
// Tuned with scripts/trace.ts over 100 seeds (tune this, never the fuse costs):
// survival 25–40%, mean detonations ≥ 2, zero-boom runs ≤ 10%.
// Nov 25, 100 seeds × 2 seed sets at 0.11: survival 26–30%, 2.6–2.7 detonations/run, 5–8% zero-boom;
// with NO_BLURT (smart Byte): survival 56–66%, 1.4–1.5 detonations/run, 16–27% zero-boom.
// Nov 26, 100 seeds under the safe-card, single-penalty and shield rules at 0.14: survival 36%, 2.7 detonations/run, 2% zero-boom.
export const CROWD_DEFAULTS: CrowdOptions = { setters: 4, aggression: 0.14, focus: 0.75, backerUsd: 20 };   // four seats, one bot per empty seat

/** CROWD_SETTERS / CROWD_AGGRESSION / CROWD_BACKER_USD env, falling back to the tuned defaults. */
export function crowdFromEnv(env: NodeJS.ProcessEnv = process.env): CrowdOptions {
  const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    ...CROWD_DEFAULTS,
    setters: Math.max(0, Math.floor(num("CROWD_SETTERS", CROWD_DEFAULTS.setters))),
    aggression: Math.min(1, Math.max(0, num("CROWD_AGGRESSION", CROWD_DEFAULTS.aggression))),
    backerUsd: Math.max(0, num("CROWD_BACKER_USD", CROWD_DEFAULTS.backerUsd)),
  };
}

export function startCrowd(match: Match, chain: MockChain, opts: Partial<CrowdOptions> = {}) {
  const o = { ...CROWD_DEFAULTS, ...opts };
  const rnd = o.rnd ?? Math.random;
  const secrets = new Map<string, { word: string; salt: Uint8Array; setter: string; armedTurn: number }>();
  const names = Array.from({ length: o.setters }, (_, i) => `viewer${i + 1}`);
  const backers = Math.max(1, o.setters);
  // not awaited by design (fire-and-forget at attach time), so the rejection must be caught here or it is unhandled
  for (let i = 0; i < backers; i++) chain.backByte(`backer${i + 1}`, +((o.backerUsd / backers) * (0.6 + (0.8 * i) / Math.max(1, backers - 1))).toFixed(2)).catch((e) => console.error("[crowd] backer seed failed:", (e as Error).message));

  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

  // Plant between Byte's calls (pre-start and after every turn advance).
  match.turnHooks.push(async (state) => {
    if (state.status !== "live" || !state.hand.length) return;
    const hand = state.hand;
    const obvious = match.currentTile().obvious.filter((w) => hand.includes(w));
    const focus = obvious.slice(0, 2);
    // The scatter share targets the "safe-looking" cards a cautious Byte retreats to.
    const sideways = hand.filter((w) => !obvious.includes(w));
    const scatter = sideways.length ? sideways : hand;
    const plays = new Map<string, number>();
    for (const s of state.spoken) plays.set(s.word, (plays.get(s.word) ?? 0) + 1);
    const habits = hand.filter((w) => (plays.get(w) ?? 0) >= 2);
    const justChallenged = state.challenged.filter((c) => c.turn >= state.turn - 1 && hand.includes(c.word)).map((c) => c.word);

    // Bots plan ahead too: a third of their plants go on the next tile's hand, a few on the one after.
    const ahead = [...(state.nextHand?.hand ?? []).filter((w) => w !== state.nextHand?.safe), ...(state.laterHand?.hand ?? []).filter((w) => w !== state.laterHand?.safe)];
    const notSafe = (w: string) => w !== state.safe;
    // bots fill the empty seats: when a person sits, one bot stops planting; when they leave, it returns
    const active = names.slice(0, Math.max(0, Math.min(names.length, o.setterCount ? o.setterCount() : names.length)));
    for (const setter of active) {
      if (rnd() > o.aggression) continue;
      let word: string;
      const r = rnd();
      if (ahead.length && r < 0.35) word = pick(ahead);                                     // mine the coming tiles
      else if (focus.filter(notSafe).length && r < 0.35 + o.focus * 0.65) word = pick(focus.filter(notSafe));   // stack the obvious card
      else if (justChallenged.length && rnd() < 0.5) word = pick(justChallenged.filter(notSafe)); // counter-mine after a challenge
      else if (habits.length && rnd() < 0.5) word = pick(habits.filter(notSafe));                 // punish a habit
      else word = pick(scatter.filter(notSafe));                                                   // scatter onto sideways cards
      if (!word) continue;
      const salt = randomBytes(32);
      const c = toHex(commitment(word, salt, mockKey(setter)));
      try {
        const t = await chain.plantTrap({ commitmentHex: c, stake: +(0.1 + rnd() * 0.9).toFixed(2), setter });
        secrets.set(t.id, { word, salt, setter, armedTurn: t.armedTurn });
      } catch { /* duplicate commitment etc. */ }
    }
  });

  // Reveal synchronously when a secret word is played on an armed turn, so Byte sees the
  // detonation(s) in the same response. Several mines on one word fire in one wave.
  match.afterWords.push(async (words) => {
    for (const [id, s] of secrets) {
      if (match.isShielded()) return;                         // two detonations on this tile already: no more until it clears
      if (!words.includes(s.word) || chain.turn < s.armedTurn) continue;
      try {
        await chain.revealTrap({ trapId: id, word: s.word, saltHex: toHex(s.salt), setter: s.setter });
        secrets.delete(id);
      } catch { /* challenged / duplicate — keep waiting */ }
    }
  });
  const everMined: string[] = [];
  const origSet = secrets.set.bind(secrets);
  secrets.set = (k, v) => { everMined.push(v.word); return origSet(k, v); };
  /** For tests and tuning: every word the bots have mined so far (the bots' own secrets, never served to clients). */
  return { mined: () => [...everMined] };
}
