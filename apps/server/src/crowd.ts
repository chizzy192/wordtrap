// Simulated viewers for SIM mode. Behaves like the mobile app: picks a word, keeps the salt
// locally, commits the hash, and reveals the moment Byte PLAYS the word (never before it is armed).
// Viewers can see Byte's hand — that is the point: the obvious cards are the tempting ones.
import { randomBytes } from "node:crypto";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain, mockKey } from "./chain/mock.ts";
import type { Match } from "./match.ts";

export interface CrowdOptions { setters: number; aggression: number; obviousBias: number; rnd?: () => number }
// Tuned with scripts/trace.ts so Byte escapes ~25–40% of sims (tune this, never the fuse costs).
export const CROWD_DEFAULTS: CrowdOptions = { setters: 5, aggression: 0.13, obviousBias: 0.75 };

export function startCrowd(match: Match, chain: MockChain, opts: Partial<CrowdOptions> = {}) {
  const o = { ...CROWD_DEFAULTS, ...opts };
  const rnd = o.rnd ?? Math.random;
  const secrets = new Map<string, { word: string; salt: Uint8Array; setter: string; armedTurn: number }>();
  const names = Array.from({ length: o.setters }, (_, i) => `viewer${i + 1}`);
  names.forEach((_, i) => chain.backByte(`backer${i + 1}`, 2 + i));

  // Plant between Byte's calls (pre-start and after every turn advance).
  match.turnHooks.push(async (state) => {
    if (state.status !== "live" || !state.hand.length) return;
    const obvious = match.currentTile().obvious.filter((w) => state.hand.includes(w));
    const mined = new Set([...secrets.values()].map((s) => s.word));
    for (const setter of names) {
      if (rnd() > o.aggression) continue;
      const pool = (rnd() < o.obviousBias && obvious.length ? obvious : state.hand).filter((w) => !mined.has(w));
      if (!pool.length) continue;
      const word = pool[Math.floor(rnd() * pool.length)];
      const salt = randomBytes(32);
      const c = toHex(commitment(word, salt, mockKey(setter)));
      try {
        const t = await chain.plantTrap({ commitmentHex: c, stake: +(0.1 + rnd() * 0.9).toFixed(2), setter });
        secrets.set(t.id, { word, salt, setter, armedTurn: t.armedTurn });
        mined.add(word);
      } catch { /* duplicate commitment etc. */ }
    }
  });

  // Reveal synchronously when a secret word is played on an armed turn, so Byte sees the
  // detonation in the same response.
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
