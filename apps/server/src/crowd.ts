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
}
// Tuned with scripts/trace.ts over 100 seeds (tune this, never the fuse costs):
// survival 25–40%, mean detonations ≥ 2, zero-boom runs ≤ 10%.
// Nov 25, 100 seeds × 2 seed sets at 0.11: survival 26–30%, 2.6–2.7 detonations/run, 5–8% zero-boom;
// with NO_BLURT (smart Byte): survival 56–66%, 1.4–1.5 detonations/run, 16–27% zero-boom.
export const CROWD_DEFAULTS: CrowdOptions = { setters: 5, aggression: 0.11, focus: 0.75, backerUsd: 20 };

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
  for (let i = 0; i < backers; i++) chain.backByte(`backer${i + 1}`, +((o.backerUsd / backers) * (0.6 + (0.8 * i) / Math.max(1, backers - 1))).toFixed(2));

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

    for (const setter of names) {
      if (rnd() > o.aggression) continue;
      let word: string;
      if (focus.length && rnd() < o.focus) word = pick(focus);                    // stack the obvious card
      else if (justChallenged.length && rnd() < 0.5) word = pick(justChallenged); // counter-mine after a challenge
      else if (habits.length && rnd() < 0.5) word = pick(habits);                 // punish a habit
      else word = pick(scatter);                                                   // scatter onto sideways cards
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
      if (!words.includes(s.word) || chain.turn < s.armedTurn) continue;
      try {
        await chain.revealTrap({ trapId: id, word: s.word, saltHex: toHex(s.salt), setter: s.setter });
        secrets.delete(id);
      } catch { /* challenged / duplicate — keep waiting */ }
    }
  });
}
