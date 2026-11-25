// One Match per Byte run. Byte starts a run with POST /api/v1/runs (no signup), gets back a
// runId + apiKey, and sends every later call with `Authorization: Bearer <apiKey>`.
// Finished runs stay in memory for the session so Byte Arena can keep reading their final state.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BoardState, FeedEvent } from "@wordtrap/shared";
import type { Chain } from "./chain/types.ts";
import { Match, type MatchConfig } from "./match.ts";
import { SimWallet, type AgentWallet } from "./wallet.ts";

export interface SeqEvent { seq: number; e: FeedEvent }
export interface Run { id: string; key: string; match: Match; chain: Chain; events: SeqEvent[]; seq: number; startedAt: number }

export const MAX_EVENTS = 200;

export interface RunManagerOptions {
  makeChain: () => Promise<Chain>;
  /** Oracle URL for a given run (the oracle needs to know which match it is scoring). */
  oracleUrl: (runId: string) => string;
  makeWallet?: () => AgentWallet;
  cfg?: Partial<MatchConfig>;
  /** Called before the match starts — SIM mode attaches the simulated crowd here. */
  onRun?: (run: Run) => void;
}

export class RunManager {
  readonly runs = new Map<string, Run>();
  private readonly o: RunManagerOptions;
  constructor(o: RunManagerOptions) { this.o = o; }

  async start(callsign: string, seed?: number): Promise<{ runId: string; apiKey: string; state: BoardState }> {
    const runId = randomBytes(8).readBigUInt64BE().toString(36);
    const apiKey = randomBytes(16).toString("hex");
    const chain = await this.o.makeChain();
    const match = new Match({
      matchId: runId, callsign, chain, wallet: (this.o.makeWallet ?? (() => new SimWallet()))(),
      oracleUrl: this.o.oracleUrl(runId), cfg: this.o.cfg, seed,
    });
    const run: Run = { id: runId, key: apiKey, match, chain, events: [], seq: 0, startedAt: Date.now() };
    match.on("feed", (e: FeedEvent) => {
      if (e.type === "state") return;                 // state rides along with every spectate reply
      run.events.push({ seq: ++run.seq, e });
      if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    });
    this.runs.set(runId, run);
    this.o.onRun?.(run);
    const state = await match.start();
    return { runId, apiKey, state };
  }

  get(runId: string): Run | undefined { return this.runs.get(runId); }

  /** Constant-time key check against the `Authorization: Bearer …` header. */
  authorized(run: Run, authorization: string | undefined): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!m) return false;
    const a = Buffer.from(m[1].trim()), b = Buffer.from(run.key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Most recent run that is still live (second-screen mobile joins this one). */
  current(): Run | undefined {
    let best: Run | undefined;
    for (const r of this.runs.values()) if (!r.match.finished() && (!best || r.startedAt > best.startedAt)) best = r;
    return best;
  }

  spectate(run: Run, after = 0): { seq: number; events: FeedEvent[]; state: BoardState } {
    return { seq: run.seq, events: run.events.filter((x) => x.seq > after).map((x) => x.e), state: run.match.snapshot() };
  }
}
