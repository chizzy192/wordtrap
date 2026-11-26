// One Match per Byte run. Byte starts a run with POST /api/v1/runs (no signup), gets back a
// runId + apiKey, and sends every later call with `Authorization: Bearer <apiKey>`.
// Finished runs stay in memory for the session so Byte Arena can keep reading their final state.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BoardState, FeedEvent } from "@wordtrap/shared";
import type { Chain } from "./chain/types.ts";
import { Match, type MatchConfig } from "./match.ts";
import { SimWallet, type AgentWallet } from "./wallet.ts";
import { Room, type Seat } from "./rooms.ts";

export interface SeqEvent { seq: number; t: number; e: FeedEvent }
/** The board as it was right after event `seq` (seq 0 = before the first event). */
export interface Snapshot { seq: number; t: number; state: BoardState }
export interface Run { id: string; key: string; match: Match; chain: Chain; room: Room; events: SeqEvent[]; history: Snapshot[]; seq: number; startedAt: number }

export const MAX_EVENTS = 200;
/** Spectator delay: snapshots kept per run so GET /spectate?delay=N can serve the board as it was N seconds ago. */
export const MAX_SNAPSHOTS = 60;
export const MAX_DELAY_SECONDS = 20;

export interface RunManagerOptions {
  makeChain: () => Promise<Chain>;
  /** Oracle URL for a given run (the oracle needs to know which match it is scoring). */
  oracleUrl: (runId: string) => string;
  makeWallet?: () => AgentWallet;
  cfg?: Partial<MatchConfig>;
  /** Called before the match starts — SIM mode attaches the simulated crowd here. */
  onRun?: (run: Run) => void;
  /** Backers the chain cannot see individually for this run (fiat backers behind the treasury). */
  extraBackers?: (runId: string) => number;
  /** Bots fill the empty seats (CROWD=0 turns them off). */
  bots?: boolean;
  /** Display name for an address (falls back to the short address). */
  nameOf?: (address: string) => string;
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
      extraBackers: () => this.o.extraBackers?.(runId) ?? 0,
    });
    const run: Run = { id: runId, key: apiKey, match, chain, room: new Room(this.o.bots ?? false), events: [], history: [], seq: 0, startedAt: Date.now() };
    match.on("feed", (e: FeedEvent) => {
      const t = Date.now();
      // Seats idle for 10 turns (no plant, no authenticated poll) are freed; counted in turns, never wall-clock.
      if (e.type === "action") {
        for (const s of run.room.sweep(e.turn + 1)) {
          queueMicrotask(() => this.announce(run, { type: "seat", action: "idle", seat: s.no, address: s.address, turn: e.turn + 1, detail: `${this.nameOf(s.address)}'s seat was freed after ${10} quiet turns.` }));
        }
      }
      if (e.type === "state") {
        // One snapshot per event seq (the last state after that event wins); this is what the delayed feed serves.
        const last = run.history.at(-1);
        if (last && last.seq === run.seq) { last.t = t; last.state = e.state; }
        else run.history.push({ seq: run.seq, t, state: e.state });
        if (run.history.length > MAX_SNAPSHOTS) run.history.splice(0, run.history.length - MAX_SNAPSHOTS);
        return;
      }
      run.events.push({ seq: ++run.seq, t, e });
      if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    });
    this.runs.set(runId, run);
    this.o.onRun?.(run);
    const state = await match.start();
    return { runId, apiKey, state };
  }

  get(runId: string): Run | undefined { return this.runs.get(runId); }

  nameOf(address: string): string { return this.o.nameOf?.(address) ?? (address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`); }
  /** Push a server-made event (seat changes) into the run's feed. */
  announce(run: Run, e: FeedEvent) { run.match.emit("feed", e); }

  /** Live public rooms for the lobby, in quick-play order: most people first, then newest. */
  listRooms(): Run[] {
    return [...this.runs.values()]
      .filter((r) => !r.match.finished() && !r.room.private)
      .sort((a, b) => (b.room.humans().length - a.room.humans().length) || (b.startedAt - a.startedAt));
  }
  /** Quick play: the first live public room with a free seat. */
  quickPick(): Run | undefined { return this.listRooms().find((r) => r.room.freeCount() > 0); }

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

  /**
   * Spectator feed. `delaySec` serves events and state as they were that many seconds ago so the
   * board stays in step with Byte's narration; `paced` attaches the board snapshot to every event so
   * the page can replay them one at a time. `seq` is the last event served, so held-back events are
   * delivered on a later poll. The Byte API is never delayed.
   */
  spectate(run: Run, after = 0, delaySec = 0, paced = false): { seq: number; events: (FeedEvent & { state?: BoardState })[]; state: BoardState; delay: number } {
    const delay = Math.min(MAX_DELAY_SECONDS, Math.max(0, Number.isFinite(delaySec) ? delaySec : 0));
    if (delay === 0 && !paced) {
      return { seq: run.seq, events: run.events.filter((x) => x.seq > after).map((x) => x.e), state: run.match.snapshot(), delay };
    }
    const cutoff = Date.now() - delay * 1000;
    const snapAt = (seq: number) => [...run.history].reverse().find((h) => h.seq <= seq) ?? run.history[0];
    const served = run.events.filter((x) => x.seq > after && x.t <= cutoff);
    const latest = [...run.history].reverse().find((h) => h.t <= cutoff) ?? run.history[0];   // oldest kept if the cap dropped older ones
    const state = delay === 0 ? run.match.snapshot() : (latest?.state ?? run.match.snapshot());
    const events = served.map((x) => (paced ? { ...x.e, state: snapAt(x.seq)?.state } : x.e));
    return { seq: served.length ? served[served.length - 1].seq : Math.min(after, run.seq), events, state, delay };
  }
}
