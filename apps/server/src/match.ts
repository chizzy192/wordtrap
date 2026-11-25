// Turn-based match. Byte (an external agent calling our HTTP API) sends one action per call.
// Every action burns an integer amount of fuse and advances the turn by exactly 1. There is no
// wall-clock: the game cannot depend on how fast Byte thinks (Byte Arena rule).
//
// Order inside act():
//   1. validate (stale turn → StaleTurnError, bad word → InvalidActionError; state unchanged)
//   2. apply the action, record played/challenged words on-chain
//   3. await reveal hooks (afterWords) so a detonation lands in THIS response
//   4. re-sync from chain, advance the turn (+1, chain.advanceTurn), check end conditions
//   5. await turn hooks (sim crowd planting between Byte's calls), return the full state
import { EventEmitter } from "node:events";
import type { ActionType, BoardState, FeedEvent, MatchStatus } from "@wordtrap/shared";
import { ACTIONS, normalizeWord, isMineable } from "@wordtrap/shared";
import type { Chain, TrapFiredEvent } from "./chain/types.ts";
import type { AgentWallet } from "./wallet.ts";
import { buyRisk, type RiskContext } from "./oracle.ts";
import { dealTiles, handFor, type Tile } from "./content.ts";

export interface MatchConfig {
  tiles: number; fuse: number;
  playCost: number; hintCost: number; defuseCost: number; challengeCost: number; passCost: number;
  fireBurn: number; maxDefuses: number; maxTurns: number; hintUsd: number;
}
export const DEFAULTS: MatchConfig = {
  tiles: 7, fuse: 180,
  playCost: 5, hintCost: 3, defuseCost: 20, challengeCost: 8, passCost: 10,
  fireBurn: 22, maxDefuses: 2, maxTurns: 60, hintUsd: 0.001,
};

/** Byte sent a `turn` that is not the current one (duplicate / replayed request). HTTP 409. */
export class StaleTurnError extends Error {
  readonly state: BoardState;
  constructor(msg: string, state: BoardState) { super(msg); this.name = "StaleTurnError"; this.state = state; }
}
/** The action or its params are not allowed right now. HTTP 400. State is unchanged. */
export class InvalidActionError extends Error {
  readonly state: BoardState;
  constructor(msg: string, state: BoardState) { super(msg); this.name = "InvalidActionError"; this.state = state; }
}

export interface ActParams { word?: string; turn?: number }

export class Match extends EventEmitter {
  readonly state: BoardState;
  readonly tiles: Tile[];
  readonly cfg: MatchConfig;
  /** Reveal hooks: awaited right after words are recorded, before the response is built. */
  readonly afterWords: ((words: string[]) => Promise<void>)[] = [];
  /** Turn hooks: awaited after every turn advance (and once before start) — sim viewers plant here. */
  readonly turnHooks: ((state: BoardState) => Promise<void>)[] = [];
  private readonly chain: Chain;
  private readonly wallet: AgentWallet;
  private readonly oracleUrl: string;
  private readonly seed: number;
  private fired = new Set<string>();
  private windowArmed = { count: 0, stake: 0 };
  private busy = false;

  constructor(o: { matchId: string; callsign?: string; chain: Chain; wallet: AgentWallet; oracleUrl: string; cfg?: Partial<MatchConfig>; seed?: number; deck?: Tile[] }) {
    super();
    this.cfg = { ...DEFAULTS, ...o.cfg };
    this.chain = o.chain; this.wallet = o.wallet; this.oracleUrl = o.oracleUrl;
    this.seed = o.seed ?? (Date.now() >>> 0);
    this.tiles = o.deck ? o.deck.slice(0, this.cfg.tiles) : dealTiles(this.cfg.tiles, this.seed);
    this.state = {
      matchId: o.matchId, callsign: o.callsign, status: "live", turn: 0, position: 0,
      tiles: this.tiles.map((t) => ({ prompt: t.prompt, cleared: false, needed: t.needed, played: [] })),
      hand: [], fuse: this.cfg.fuse, fuseTotal: this.cfg.fuse, hint: null,
      spoken: [], challenged: [], traps: [], backerTotal: 0, trapTotal: 0,
      defusesLeft: this.cfg.maxDefuses, hintsBought: 0, hintSpendUsd: 0, score: 0,
    };
    this.dealHand();
    this.chain.onTrapPlanted((t) => {
      this.windowArmed.count++; this.windowArmed.stake += t.stake;
      this.sync(); this.push({ type: "trap_planted", trap: t });
    });
    this.chain.onTrapFired((e) => this.onFired(e));
  }

  // ---------- read side ----------

  currentTile(): Tile { return this.tiles[Math.min(this.state.position, this.tiles.length - 1)]; }
  finished(): boolean { return this.state.status !== "live"; }

  /** A copy of the full state. Safe to hand to HTTP callers: mutating it changes nothing here. */
  snapshot(): BoardState { return structuredClone(this.state); }

  riskContext(): RiskContext {
    return { tile: this.currentTile(), firedWords: this.fired, armedStakeThisWindow: this.windowArmed.stake, armedCountThisWindow: this.windowArmed.count };
  }

  // ---------- lifecycle ----------

  async start(): Promise<BoardState> {
    await this.chain.initMatch(this.state.matchId);
    this.state.matchPda = this.chain.address?.();
    this.sync();
    // Pre-start: viewers may plant now; those mines arm for turn 1.
    for (const h of this.turnHooks) await h(this.snapshot());
    await this.chain.startMatch();
    this.state.turn = 1;
    this.sync();
    return this.snapshot();
  }

  async act(name: string, params: ActParams = {}): Promise<BoardState> {
    if (this.finished()) return this.snapshot();               // idempotent after the end
    if (this.busy) throw new StaleTurnError(`stale turn: an action for turn ${this.state.turn} is still being applied`, this.snapshot());
    if (params.turn !== undefined && params.turn !== this.state.turn) {
      throw new StaleTurnError(`stale turn: current turn is ${this.state.turn}`, this.snapshot());
    }
    if (!ACTIONS.includes(name as ActionType)) {
      throw new InvalidActionError(`unknown action "${name}"; choose one of ${ACTIONS.join(", ")}`, this.snapshot());
    }
    const action = name as ActionType;
    const turn = this.state.turn;
    this.busy = true;
    try {
      const detail = await this.apply(action, params, turn);
      this.push({ type: "action", action, detail, turn });
      this.sync();
      await this.advance();
      return this.snapshot();
    } finally {
      this.busy = false;
    }
  }

  // ---------- actions ----------

  private async apply(action: ActionType, params: ActParams, turn: number): Promise<string> {
    const tile = this.currentTile();
    switch (action) {
      case "play_word": {
        const w = normalizeWord(params.word ?? "");
        if (!w || !this.state.hand.includes(w)) {
          throw new InvalidActionError(`"${params.word ?? ""}" is not in your hand; play one of: ${this.state.hand.join(", ")}`, this.snapshot());
        }
        this.burn(this.cfg.playCost);
        await this.chain.recordWords([w], "spoken");
        this.state.spoken.push({ word: w, turn });
        const t = this.state.tiles[this.state.position];
        t.played.push(w);
        this.state.hand = this.state.hand.filter((x) => x !== w);
        // Let synchronous revealers (sim crowd, relayers) detonate before we answer.
        for (const h of this.afterWords) await h([w]);
        const boom = this.fired.has(w) ? " — BOOM, it was mined" : "";
        if (t.played.length >= t.needed) { this.clearTile(); return `played "${w}"${boom} · tile cleared`; }
        return `played "${w}"${boom} · ${t.played.length}/${t.needed} on "${tile.prompt}"`;
      }
      case "buy_hint": {
        this.burn(this.cfg.hintCost);
        const words = [...this.state.hand];
        try {
          const { scores, txSig } = await buyRisk(this.oracleUrl, words, this.wallet);
          this.state.hint = scores;
          this.state.hintsBought++; this.state.hintSpendUsd = this.wallet.spentUsd();
          this.push({ type: "hint", scores, costUsd: this.cfg.hintUsd, txSig });
          return `bought risk scores for ${words.length} cards via x402 (${txSig})`;
        } catch (e) {
          this.state.hint = {};
          this.push({ type: "action", action: "buy_hint", detail: `hint failed: ${(e as Error).message}`, turn });
          return `hint failed: ${(e as Error).message}`;
        }
      }
      case "defuse_tile": {
        if (this.state.defusesLeft <= 0) throw new InvalidActionError("no defuses left", this.snapshot());
        this.state.defusesLeft--;
        this.burn(this.cfg.defuseCost);
        this.clearTile();
        return `cut the wire · skipped "${tile.prompt}"`;
      }
      case "challenge_word": {
        const w = normalizeWord(params.word ?? "");
        if (!isMineable(w)) throw new InvalidActionError(`"${params.word ?? ""}" cannot be challenged (3+ letters a-z, not a glue word); try a card from your hand: ${this.state.hand.join(", ")}`, this.snapshot());
        if (this.state.challenged.some((c) => c.word === w)) throw new InvalidActionError(`"${w}" was already challenged`, this.snapshot());
        this.burn(this.cfg.challengeCost);
        await this.chain.recordWords([w], "challenged");
        this.state.challenged.push({ word: w, turn });
        return `challenged "${w}" without playing it · any mine on it is now disarmed`;
      }
      case "pass_turn":
        this.burn(this.cfg.passCost);
        return "passed";
    }
  }

  // ---------- turn / end ----------

  private async advance() {
    this.state.turn++;
    this.windowArmed = { count: 0, stake: 0 };
    await this.chain.advanceTurn();
    const status = this.endStatus();
    if (status) {
      this.state.status = status;
      this.sync();
      await this.chain.endMatch(status === "escaped");
      const reason = status === "escaped" ? "Byte reached the exit" : this.state.fuse <= 0 ? "Fuse burned out" : "Turn limit";
      this.push({ type: "match_end", status, reason });
      return;
    }
    for (const h of this.turnHooks) await h(this.snapshot());
    this.sync();
  }

  private endStatus(): MatchStatus | null {
    if (this.state.position >= this.tiles.length) return "escaped";
    if (this.state.fuse <= 0 || this.state.turn >= this.cfg.maxTurns) return "dead";
    return null;
  }

  private clearTile() {
    this.state.tiles[this.state.position].cleared = true;
    this.state.position++;
    this.state.hint = null;        // scores were for the old hand
    this.dealHand();
  }

  private dealHand() {
    if (this.state.position >= this.tiles.length) { this.state.hand = []; return; }
    const extras = [...this.fired].slice(-2);   // words that already blew up come back as bait
    this.state.hand = handFor(this.currentTile(), extras, this.seed + this.state.position * 7919);
  }

  private burn(n: number) { this.state.fuse = Math.max(0, this.state.fuse - n); }

  private onFired(e: TrapFiredEvent) {
    this.fired.add(e.word);
    this.burn(this.cfg.fireBurn);
    this.sync();
    this.push({ type: "trap_fired", trap: e.trap, payout: e.payout, fuseBurn: this.cfg.fireBurn });
  }

  /** Pull trap/pool totals from the chain, recompute score, broadcast the state. */
  sync() {
    const s = this.chain.snapshot();
    this.state.traps = s.traps; this.state.backerTotal = s.backerTotal; this.state.trapTotal = s.trapTotal;
    this.state.score = this.state.position * 100 + Math.max(0, this.state.fuse);
    this.push({ type: "state", state: this.snapshot() });
  }

  private push(e: FeedEvent) { this.emit("feed", e); }
}
