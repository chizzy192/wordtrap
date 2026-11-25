// A local stand-in for Byte. Used by SIM mode (through the public HTTP API) and by
// scripts/trace.ts (directly against Match) to rehearse what the real Byte Arena agent will do.
// It only reads BoardState — exactly what Byte gets back from every call.
import type { ActionType, BoardState } from "@wordtrap/shared";
import { TILE_DECK } from "./content.ts";

export interface Move { action: ActionType; word?: string }

const UNKNOWN_RISK = 0.3;

export function decide(state: BoardState): Move {
  const hand = state.hand;
  const armed = state.traps.filter((t) => t.status === "armed").length;
  const tilesLeft = state.tiles.length - state.position;
  const challenged = new Set(state.challenged.map((c) => c.word));
  const risk = (w: string) => (challenged.has(w) ? 0 : state.hint?.[w] ?? UNKNOWN_RISK);

  if (!hand.length) return { action: "pass_turn" };

  if (!state.hint && armed >= 2 && state.fuse > 10) return { action: "buy_hint" };

  if (state.hint) {
    const hottest = [...hand].filter((w) => !challenged.has(w)).sort((a, b) => risk(b) - risk(a))[0];
    if (hottest && risk(hottest) > 0.85 && state.turn % 5 === 0) return { action: "challenge_word", word: hottest };
  }

  if (state.fuse < 35 && state.defusesLeft > 0 && tilesLeft > 1) return { action: "defuse_tile" };

  // Byte must be fallible or the stream is boring: every 4th turn it blurts the most obvious card.
  if (state.turn % 4 === 0) {
    const tile = TILE_DECK.find((t) => t.prompt === state.tiles[state.position]?.prompt);
    const obvious = tile?.obvious.find((w) => hand.includes(w));
    if (obvious) return { action: "play_word", word: obvious };
  }

  const safest = [...hand].sort((a, b) => risk(a) - risk(b))[0];
  if (safest) return { action: "play_word", word: safest };
  return { action: "pass_turn" };
}
