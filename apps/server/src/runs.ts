// One Match per Byte run. Byte starts a run with POST /api/v1/runs (no signup), gets back a
// runId + apiKey, and sends every later call with `Authorization: Bearer <apiKey>`.
// Finished runs stay in memory for the session so Byte Arena can keep reading their final state.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BoardState, FeedEvent } from "@wordtrap/shared";
import type { Chain } from "./chain/types.ts";
import type { Tile } from "./content.ts";
import { Match, type MatchConfig, type MatchDump } from "./match.ts";
import { SimWallet, type AgentWallet } from "./wallet.ts";
import { Room, type Seat } from "./rooms.ts";
import { RunSaver, RUN_KEEP_MS, type RunStore, type RunRow } from "./persist.ts";

export interface SeqEvent { seq: number; t: number; e: FeedEvent }
/** The board as it was right after event `seq` (seq 0 = before the first event). */
export interface Snapshot { seq: number; t: number; state: BoardState }
export interface Run { id: string; key: string; match: Match; chain: Chain; room: Room; events: SeqEvent[]; history: Snapshot[]; seq: number; startedAt: number; finishedAt?: number; restored?: boolean }
/** One run as it is saved: the match, chain and room dumps, the feed, and whatever the server keeps beside the run (ledger slices, house flag). */
export interface RunDump { id: string; key: string; startedAt: number; finishedAt?: number; seq: number; events: SeqEvent[]; history: Snapshot[]; match: MatchDump; chain: any; room: any; extra?: any }

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
  /** Today's deck for a new run (chosen before the run exists; the built-in deck when null). */
  pickDeck?: () => Promise<{ tiles: Tile[]; meta: { theme: string; sourceUrl: string; site: string; day: string } } | null>;
  /** Where runs are saved between restarts (null: memory only, as before). */
  store?: RunStore | null;
  /** A chain rebuilt from its dump, or null when that kind of chain cannot be restored (a real cluster). */
  loadChain?: (dump: any) => Chain | null;
  /** What the server keeps beside a run (ledger slices, house flag): dumped with it and handed back on restore. */
  extraDump?: (run: Run) => any;
  extraLoad?: (run: Run, extra: any) => void;
  log?: (line: string) => void;
}

export class RunManager {
  readonly runs = new Map<string, Run>();
  private readonly o: RunManagerOptions;
  readonly saver: RunSaver | null;
  constructor(o: RunManagerOptions) {
    this.o = o;
    this.saver = o.store ? new RunSaver({ store: o.store, dump: (id) => { const r = this.runs.get(id); return r ? { status: r.match.snapshot().status, state: this.dump(r) } : null; }, log: o.log }) : null;
  }
  /** Mark a run changed: it is saved shortly after (write-behind), never in the way of the answer. */
  touch(run: Run) { this.saver?.touch(run.id); }
  /** Save every dirty run now (SIGTERM, close). */
  async flush() { await this.saver?.flush(); }
  dump(run: Run): RunDump {
    return { id: run.id, key: run.key, startedAt: run.startedAt, finishedAt: run.finishedAt, seq: run.seq, events: run.events, history: run.history, match: run.match.dump(), chain: (run.chain as any).dump?.() ?? { kind: run.chain.kind }, room: run.room.dump(), extra: this.o.extraDump?.(run) };
  }
  /** Feed listener: seat sweeps, the event log, snapshots for the delayed feed, the finish time, and the save. */
  private attach(run: Run) {
    run.match.on("feed", (e: FeedEvent) => {
      const t = Date.now();
      // Seats idle for 10 turns (no plant, no authenticated poll) are freed; counted in turns, never wall-clock.
      if (e.type === "action") {
        for (const s of run.room.sweep(e.turn + 1)) {
          queueMicrotask(() => this.announce(run, { type: "seat", action: "idle", seat: s.no, address: s.address, turn: e.turn + 1, detail: `${this.nameOf(s.address)}'s seat was freed after ${10} quiet turns.` }));
        }
      }
      if (e.type === "match_end") run.finishedAt = t;
      if (e.type === "state") {
        // One snapshot per event seq (the last state after that event wins); this is what the delayed feed serves.
        const last = run.history.at(-1);
        if (last && last.seq === run.seq) { last.t = t; last.state = e.state; }
        else run.history.push({ seq: run.seq, t, state: e.state });
        if (run.history.length > MAX_SNAPSHOTS) run.history.splice(0, run.history.length - MAX_SNAPSHOTS);
        this.touch(run);
        return;
      }
      run.events.push({ seq: ++run.seq, t, e });
      if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
      this.touch(run);
    });
  }
  /** Bring back the runs saved in the last two hours. Live ones continue (same id, turn and key); finished ones stay answerable. */
  async restoreAll(now = Date.now()): Promise<{ restored: Run[]; skipped: { runId: string; reason: string }[] }> {
    const restored: Run[] = [], skipped: { runId: string; reason: string }[] = [];
    if (!this.o.store) return { restored, skipped };
    let rows: RunRow[];
    try { rows = await this.o.store.recent(now - RUN_KEEP_MS); }
    catch (e) { this.o.log?.(`[runs] could not read saved runs: ${(e as Error).message}`); return { restored, skipped }; }
    for (const row of rows) {
      if (this.runs.has(row.runId)) continue;
      try {
        const run = this.restore(row.state as RunDump);
        if (run) restored.push(run); else skipped.push({ runId: row.runId, reason: "its chain cannot be rebuilt here" });
      } catch (e) { skipped.push({ runId: row.runId, reason: (e as Error).message }); }
    }
    return { restored, skipped };
  }
  restore(d: RunDump): Run | null {
    const chain = this.o.loadChain?.(d.chain) ?? null;
    if (!chain) return null;
    const match = new Match({
      matchId: d.id, chain, wallet: (this.o.makeWallet ?? (() => new SimWallet()))(), oracleUrl: this.o.oracleUrl(d.id),
      extraBackers: () => this.o.extraBackers?.(d.id) ?? 0, restore: d.match,
    });
    const run: Run = { id: d.id, key: d.key, match, chain, room: Room.load(d.room, this.o.bots ?? false), events: d.events ?? [], history: d.history ?? [], seq: d.seq ?? 0, startedAt: d.startedAt, finishedAt: d.finishedAt, restored: true };
    this.attach(run);
    this.runs.set(d.id, run);
    this.o.extraLoad?.(run, d.extra);
    if (!match.finished()) this.o.onRun?.(run);   // bots, the fiat payout hook
    return run;
  }
  /** Finished runs leave memory two hours after they ended (they stay in the store for the same two hours). */
  evictFinished(now = Date.now()): string[] {
    const gone: string[] = [];
    for (const [id, r] of this.runs) if (r.match.finished() && now - (r.finishedAt ?? r.startedAt) > RUN_KEEP_MS) { this.runs.delete(id); gone.push(id); }
    return gone;
  }

  async start(callsign: string, seed?: number): Promise<{ runId: string; apiKey: string; state: BoardState }> {
    const runId = randomBytes(8).readBigUInt64BE().toString(36);
    const apiKey = randomBytes(16).toString("hex");
    const chain = await this.o.makeChain();
    let picked: Awaited<ReturnType<NonNullable<RunManagerOptions["pickDeck"]>>> = null;
    try { picked = (await this.o.pickDeck?.()) ?? null; } catch { picked = null; }   // a deck problem never stops a run
    const match = new Match({
      matchId: runId, callsign, chain, wallet: (this.o.makeWallet ?? (() => new SimWallet()))(),
      oracleUrl: this.o.oracleUrl(runId), cfg: this.o.cfg, seed, deck: picked?.tiles, deckMeta: picked?.meta,
      extraBackers: () => this.o.extraBackers?.(runId) ?? 0,
    });
    const run: Run = { id: runId, key: apiKey, match, chain, room: new Room(this.o.bots ?? false), events: [], history: [], seq: 0, startedAt: Date.now() };
    this.attach(run);
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
  all(): Run[] { return [...this.runs.values()]; }
  listRooms(): Run[] {
    return [...this.runs.values()]
      .filter((r) => !r.match.finished() && !r.room.private)
      .sort((a, b) => (b.room.humans().length - a.room.humans().length) || (b.startedAt - a.startedAt));
  }
  /** Quick play: the first live public room with a free seat (and, with `ok`, one the player may still sit in). */
  quickPick(ok: (r: Run) => boolean = () => true): Run | undefined { return this.listRooms().find((r) => r.room.freeCount() > 0 && ok(r)); }

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
