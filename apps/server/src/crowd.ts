// Simulated trap setters for sim mode. Behaves like the mobile app: picks a word, keeps the
// salt locally, commits the hash, and auto-reveals the instant Byte says the word.
import { randomBytes } from "node:crypto";
import { commitment, toHex, type FeedEvent } from "@wordtrap/shared";
import { MockChain, mockKey } from "./chain/mock.ts";
import type { Game } from "./engine.ts";

const TICS = ["chat", "thinking", "circuits", "obvious", "words", "fuse", "burning", "weird", "nope", "intel", "board"];

export function startCrowd(game: Game, chain: MockChain, opts = { setters: 5, aggression: 0.7 }) {
  const secrets = new Map<string, { word: string; salt: Uint8Array; setter: string }>();
  const names = Array.from({ length: opts.setters }, (_, i) => `viewer${i + 1}`);
  names.forEach((n, i) => chain.backByte(`backer${i + 1}`, 2 + i));

  game.on("feed", async (e: FeedEvent) => {
    if (e.type === "turn_window") {
      const tile = game.currentTile();
      for (const setter of names) {
        if (Math.random() > opts.aggression) continue;
        const pool = Math.random() < 0.75 ? tile.obvious.slice(0, 5) : TICS;
        const word = pool[Math.floor(Math.random() * pool.length)];
        const salt = randomBytes(32);
        const c = toHex(commitment(word, salt, mockKey(setter)));
        try {
          const t = await chain.plantTrap({ commitmentHex: c, stake: +(0.1 + Math.random() * 0.9).toFixed(2), setter });
          secrets.set(t.id, { word, salt, setter });
        } catch { /* duplicate commitment etc. */ }
      }
    }
    if (e.type === "state") {
      const said = new Set(e.state.spoken.map((s) => s.word));
      for (const [id, s] of secrets) {
        if (!said.has(s.word)) continue;
        try {
          await chain.revealTrap({ trapId: id, word: s.word, saltHex: toHex(s.salt), setter: s.setter });
          secrets.delete(id);
        } catch { /* not armed yet when said, or challenged — keep waiting */ }
      }
    }
  });
}
