// The match loop. Per turn:
//   1. TRAP WINDOW  — viewers arm mines (they arm for the turn about to start)
//   2. advance turn — on-chain turn counter ticks; new mines are now live
//   3. BYTE ACTS    — optional BUY_HINT (x402), then one action; everything said is recorded
//   4. REVEAL GRACE — setters' devices auto-reveal mines that were said; each detonation burns fuse
import { EventEmitter } from "node:events";
import type { ActionType, BoardState, FeedEvent } from "@wordtrap/shared";
import { normalizeWord, isMineable } from "@wordtrap/shared";
import type { Chain, TrapFiredEvent } from "./chain/types.ts";
import type { ByteAgent, AgentView, Decision } from "./agent.ts";
import { spokenWords } from "./agent.ts";
import type { AgentWallet } from "./wallet.ts";
import { buyRisk, type RiskContext } from "./oracle.ts";
import { dealTiles, type Tile } from "./content.ts";

export interface EngineConfig {
  tiles: number; fuseMs: number; windowMs: number; revealGraceMs: number;
  fireBurnMs: number; passBurnMs: number; defuseBurnMs: number; challengeBurnMs: number;
  maxDefuses: number; maxTurns: number;
}
export const DEFAULTS: EngineConfig = {
  tiles: 7, fuseMs: 180_000, windowMs: 10_000, revealGraceMs: 3_000,
  fireBurnMs: 22_000, passBurnMs: 10_000, defuseBurnMs: 20_000, challengeBurnMs: 8_000,
  maxDefuses: 2, maxTurns: 40,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Game extends EventEmitter {
  readonly state: BoardState;
  readonly tiles: Tile[];
  private readonly cfg: EngineConfig;
  private readonly chain: Chain;
  private readonly agent: ByteAgent;
  private readonly wallet: AgentWallet;
  private readonly oracleUrl: string;
  private fired = new Set<string>();
  private windowArmed = { count: 0, stake: 0 };
  private hintThisTurn = false;

  constructor(o: { matchId: string; chain: Chain; agent: ByteAgent; wallet: AgentWallet; oracleUrl: string; cfg?: Partial<EngineConfig> }) {
    super();
    this.cfg = { ...DEFAULTS, ...o.cfg };
    this.chain = o.chain; this.agent = o.agent; this.wallet = o.wallet; this.oracleUrl = o.oracleUrl;
    this.tiles = dealTiles(this.cfg.tiles);
    this.state = {
      matchId: o.matchId, status: "open", turn: 0, position: 0,
      tiles: this.tiles.map((t) => ({ prompt: t.prompt, cleared: false })),
      fuseMs: this.cfg.fuseMs, fuseTotalMs: this.cfg.fuseMs,
      spoken: [], challenged: [], traps: [], backerTotal: 0, trapTotal: 0,
      defusesLeft: this.cfg.maxDefuses, hintsBought: 0, hintSpendUsd: 0,
    };
    this.chain.onTrapPlanted((t) => {
      this.windowArmed.count++; this.windowArmed.stake += t.stake;
      this.sync(); this.push({ type: "trap_planted", trap: t });
    });
    this.chain.onTrapFired((e) => this.onFired(e));
  }

  currentTile(): Tile { return this.tiles[Math.min(this.state.position, this.tiles.length - 1)]; }

  riskContext(): RiskContext {
    return { tile: this.currentTile(), firedWords: this.fired, armedStakeThisWindow: this.windowArmed.stake, armedCountThisWindow: this.windowArmed.count };
  }

  async run() {
    await this.chain.initMatch(this.state.matchId);
    this.state.matchPda = this.chain.address?.();
    // Pre-match window: traps planted now arm for turn 1.
    await this.window(0);
    await this.chain.startMatch();
    this.state.status = "live";
    for (let turn = 1; ; turn++) {
      this.state.turn = turn;
      this.sync();
      await this.playTurn(turn);
      await sleep(this.cfg.revealGraceMs);
      if (this.over()) break;
      await this.window(turn);
      if (this.over()) break;
      await this.chain.advanceTurn();
    }
    const survived = this.state.position >= this.tiles.length && this.state.fuseMs > 0;
    this.state.status = "ended"; this.state.byteSurvived = survived;
    await this.chain.endMatch(survived);
    this.sync();
    this.push({ type: "match_end", byteSurvived: survived, reason: survived ? "Byte reached the exit" : this.state.fuseMs <= 0 ? "Fuse burned out" : "Turn limit" });
    return survived;
  }

  private over() {
    return this.state.fuseMs <= 0 || this.state.position >= this.tiles.length || this.state.turn >= this.cfg.maxTurns;
  }

  private async window(turn: number) {
    this.windowArmed = { count: 0, stake: 0 };
    this.push({ type: "turn_window", turn: turn + 1, closesInMs: this.cfg.windowMs });
    await sleep(this.cfg.windowMs);
  }

  private view(): AgentView {
    const tile = this.currentTile();
    const armed = this.state.traps.filter((t) => t.status === "armed");
    return {
      turn: this.state.turn, tile, tilesLeft: this.tiles.length - this.state.position,
      fuseSec: Math.round(this.state.fuseMs / 1000), defusesLeft: this.state.defusesLeft,
      canBuyHint: !this.hintThisTurn, firedWords: [...this.fired],
      armedTrapCount: armed.length, armedStake: armed.reduce((n, t) => n + t.stake, 0),
      recentSpoken: this.state.spoken.slice(-30).map((s) => s.word),
    };
  }

  private async think(v: AgentView): Promise<Decision> {
    const t0 = Date.now();
    try { return await this.agent.decide(v); }
    finally { this.burn(Date.now() - t0); } // thinking burns real fuse — viewers watch it tick
  }

  private async playTurn(turn: number) {
    this.hintThisTurn = false;
    let v = this.view();
    let d = await this.think(v);

    if (d.action === "BUY_HINT") {
      this.hintThisTurn = true;
      await this.say(d.narration, turn, d);
      const words = (d.hintWords ?? []).map(normalizeWord).filter(isMineable).slice(0, 8);
      try {
        const { scores, txSig } = await buyRisk(this.oracleUrl, words, this.wallet);
        this.state.hintsBought++; this.state.hintSpendUsd = this.wallet.spentUsd();
        this.push({ type: "hint", scores, costUsd: 0.001, txSig });
        v = { ...this.view(), hintScores: scores, canBuyHint: false };
      } catch (e) {
        this.push({ type: "action", action: "BUY_HINT", detail: `hint failed: ${(e as Error).message}`, turn });
        v = { ...this.view(), canBuyHint: false };
      }
      d = await this.think(v);
      if (d.action === "BUY_HINT") d = { ...d, action: "PASS_TURN" };
    }

    const tile = this.currentTile();
    let detail = "";
    switch (d.action as ActionType) {
      case "PLAY_WORD_CARD": {
        const words = (d.answer ?? "").split(/\s+/).map(normalizeWord).filter(Boolean);
        if (words.length >= tile.minWords) {
          this.clearTile();
          detail = `"${d.answer}" — tile cleared`;
        } else {
          this.burn(this.cfg.passBurnMs);
          detail = `"${d.answer ?? ""}" — too short (${words.length}/${tile.minWords}), fuse penalty`;
        }
        break;
      }
      case "DEFUSE_TILE":
        if (this.state.defusesLeft > 0) {
          this.state.defusesLeft--; this.burn(this.cfg.defuseBurnMs); this.clearTile();
          detail = "cut the wire, skipped tile";
        } else { this.burn(this.cfg.passBurnMs); detail = "no defuses left"; }
        break;
      case "CHALLENGE_TRAP": {
        const w = normalizeWord(d.challengeWord ?? "");
        this.burn(this.cfg.challengeBurnMs);
        if (isMineable(w)) {
          await this.chain.recordWords([w], "challenged");
          this.state.challenged.push({ word: w, turn });
          detail = `typed suspected mine: ${w.toUpperCase()}`;
        } else detail = "invalid challenge";
        break;
      }
      default:
        this.burn(this.cfg.passBurnMs); detail = "passed";
    }
    this.push({ type: "action", action: d.action, detail, turn });
    await this.say(d.narration, turn, d.action === "PLAY_WORD_CARD" ? d : { ...d, answer: undefined });
  }

  /** Speak (TTS hook) and write every mineable word to chain. */
  private async say(narration: string, turn: number, d: Decision) {
    this.push({ type: "narration", text: d.answer ? `${narration} … ${d.answer}` : narration, turn });
    const words = spokenWords({ ...d, narration });
    if (!words.length) return;
    await this.chain.recordWords(words, "spoken");
    for (const w of words) this.state.spoken.push({ word: w, turn });
    this.sync();
  }

  private clearTile() {
    this.state.tiles[this.state.position].cleared = true;
    this.state.position++;
  }

  private burn(ms: number) { this.state.fuseMs = Math.max(0, this.state.fuseMs - ms); }

  private onFired(e: TrapFiredEvent) {
    this.fired.add(e.word);
    this.burn(this.cfg.fireBurnMs);
    this.sync();
    this.push({ type: "trap_fired", trap: e.trap, payout: e.payout, fuseBurnMs: this.cfg.fireBurnMs });
  }

  sync() {
    const s = this.chain.snapshot();
    this.state.traps = s.traps; this.state.backerTotal = s.backerTotal; this.state.trapTotal = s.trapTotal;
    this.push({ type: "state", state: this.state });
  }

  private push(e: FeedEvent) { this.emit("feed", e); }
}
