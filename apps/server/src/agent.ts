// Byte's brain. Everything Byte says — answer AND narration — is recorded as spoken, so its
// own paranoid commentary can set off mines. That's the show.
import type { ActionType } from "@wordtrap/shared";
import { tokenize, isMineable } from "@wordtrap/shared";
import type { Tile } from "./content.ts";

export interface AgentView {
  turn: number;
  tile: Tile;
  tilesLeft: number;
  fuseSec: number;
  defusesLeft: number;
  canBuyHint: boolean;
  hintScores?: Record<string, number>;
  firedWords: string[];           // words that already blew up this match
  armedTrapCount: number;
  armedStake: number;
  recentSpoken: string[];
}

export interface Decision {
  action: ActionType;
  answer?: string;                // PLAY_WORD_CARD
  hintWords?: string[];           // BUY_HINT: candidate words to score
  challengeWord?: string;         // CHALLENGE_TRAP
  narration: string;              // spoken aloud (TTS) — also recorded!
}

export interface ByteAgent { decide(v: AgentView): Promise<Decision> }

// ---------------- LLM-backed agent ----------------

const SYSTEM = `You are BYTE, an AI contestant on a live-streamed word survival game, talking out loud.
Viewers secretly mine words with USDC. If you SAY a mined word (in your answer OR your narration), it detonates and burns your fuse.
Reach the exit before the fuse hits zero. Be dramatic, paranoid, funny, and SHORT (narration <= 25 words).
Actions:
- PLAY_WORD_CARD: answer the tile prompt with at least minWords real words. Prefer non-obvious synonyms.
- BUY_HINT: pay ~$0.001 via x402 to score up to 8 candidate words for mine risk (once per turn).
- DEFUSE_TILE: skip the tile without answering (costs fuse, limited uses).
- CHALLENGE_TRAP: name ONE word you think is mined. It's typed, not spoken; if you're right that mine is disarmed for the rest of the match. Costs fuse.
- PASS_TURN: say nothing useful, lose fuse, don't advance.
Never say a word listed in firedWords. Reply ONLY with JSON: {"action":..., "answer"?:..., "hintWords"?:[...], "challengeWord"?:..., "narration":...}`;

export class LlmAgent implements ByteAgent {
  private readonly apiKey: string;
  private readonly model: string;
  constructor(apiKey: string, model = process.env.BYTE_MODEL ?? "claude-haiku-4-5") { this.apiKey = apiKey; this.model = model; }

  async decide(v: AgentView): Promise<Decision> {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(v) }] }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
    const text: string = (await r.json()).content?.[0]?.text ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return sanitize(JSON.parse(json), v);
  }
}

function sanitize(d: Decision, v: AgentView): Decision {
  const ok: ActionType[] = ["PLAY_WORD_CARD", "BUY_HINT", "DEFUSE_TILE", "CHALLENGE_TRAP", "PASS_TURN"];
  if (!ok.includes(d.action)) d.action = "PASS_TURN";
  if (d.action === "BUY_HINT" && !v.canBuyHint) d.action = "PLAY_WORD_CARD";
  if (d.action === "DEFUSE_TILE" && v.defusesLeft <= 0) d.action = "PLAY_WORD_CARD";
  d.narration = String(d.narration ?? "").slice(0, 240);
  return d;
}

// ---------------- Scripted agent (offline demo / LLM fallback) ----------------

const NERVES = [
  "Okay chat, I can feel the stakes on this one. Thinking carefully.",
  "Every obvious word is a landmine. Going sideways.",
  "My circuits are sweating. Choosing weird words on purpose.",
  "Nope, not falling for the obvious answer today.",
  "Fuse is burning, decision time.",
];
const SYNONYMS: Record<string, string[]> = {
  "Name three fruits you'd pack for a picnic": ["lychee", "persimmon", "quince", "kumquat"],
  "Describe the ocean in five words": ["turquoise", "restless", "briny", "immense", "murmuring"],
  "Name a superpower and why you'd want it": ["photosynthesis", "because", "free", "lunch", "forever"],
  "Give a weather forecast for tomorrow": ["drizzly", "breezy", "overcast", "humid", "later"],
  "Pitch a startup in one sentence": ["robots", "that", "fold", "laundry", "while", "sleeping"],
  "Name three animals at a farm": ["llama", "alpaca", "turkey", "rooster"],
  "Describe your morning routine": ["stretch", "journal", "oatmeal", "podcast", "commute"],
  "Name the colors of a rainbow": ["crimson", "amber", "lime", "teal", "lavender"],
  "Explain what a blockchain is to a child": ["shared", "notebook", "everyone", "copies", "nobody", "erases"],
  "Order food at a pizza place": ["margherita", "basil", "thin", "crust", "thanks"],
  "Name three things in a kitchen": ["colander", "whisk", "ladle", "toaster"],
  "Describe a sunset": ["amber", "glowing", "dusk", "lavender", "fading"],
};

export class ScriptedAgent implements ByteAgent {
  private i = 0;
  async decide(v: AgentView): Promise<Decision> {
    const narration = NERVES[this.i++ % NERVES.length];
    const safe = (SYNONYMS[v.tile.prompt] ?? ["mysterious", "words", "only", "today"]).filter((w) => !v.firedWords.includes(w));
    // Buy intel when the crowd is heavily armed and we haven't yet this turn.
    if (v.canBuyHint && v.armedTrapCount >= 2) {
      return { action: "BUY_HINT", hintWords: [...v.tile.obvious.slice(0, 4), ...safe.slice(0, 4)], narration: "Lot of money on the board. Buying intel." };
    }
    if (v.hintScores) {
      const hottest = Object.entries(v.hintScores).sort((a, b) => b[1] - a[1])[0];
      if (hottest && hottest[1] > 0.8 && v.fuseSec > 40 && this.i % 3 === 0) {
        return { action: "CHALLENGE_TRAP", challengeWord: hottest[0], narration: "I am calling that bluff. Typing my guess, not saying it." };
      }
    }
    if (v.fuseSec < 35 && v.defusesLeft > 0 && v.tilesLeft > 1) {
      return { action: "DEFUSE_TILE", narration: "No time. Cutting the wire on this tile." };
    }
    const cool = safe.filter((w) => (v.hintScores?.[w] ?? 0) < 0.5);
    // Byte is fallible: 1 in 4 turns it blurts the obvious answer first.
    const blurt = this.i % 4 === 0 ? [v.tile.obvious[0]] : [];
    const answer = [...blurt, ...cool].slice(0, Math.max(v.tile.minWords, 3)).join(" ");
    return { action: "PLAY_WORD_CARD", answer, narration };
  }
}

/** Words that get written to chain for a decision. */
export function spokenWords(d: Decision): string[] {
  return tokenize(`${d.narration} ${d.answer ?? ""}`).filter(isMineable);
}
