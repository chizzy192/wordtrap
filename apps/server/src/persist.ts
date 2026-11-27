// Runs survive a restart. Every state change marks a run dirty; a write-behind saver turns that into one upsert of the
// run's full serialisable state (match, seats, room, commitments, pool figures, event log, deck, turn counter,
// spectate cursor) into Supabase table runs(run_id primary key, status, state jsonb, updated_at). Saving never sits in
// the way of an API answer: it is coalesced (last write wins), retried on failure, and flushed on SIGTERM. On startup
// every run updated in the last two hours is loaded back; live ones resume with the same runId, turn and API key.
// Without Supabase there is no store and the server behaves as before (runs live in memory only).
import type { SupabaseLike } from "./store.ts";

export interface RunRow { runId: string; status: string; state: any; updatedAt: number }
export interface RunStore {
  readonly kind: "memory" | "supabase";
  save(row: { runId: string; status: string; state: any }): Promise<void>;
  /** Rows updated at or after `since` (unix ms), newest first. */
  recent(since: number): Promise<RunRow[]>;
}

/** Tests: rows in a Map, with a switch to make saves fail. */
export class MemoryRunStore implements RunStore {
  readonly kind = "memory" as const;
  readonly rows = new Map<string, RunRow>();
  failing = false;
  saves = 0;
  async save(row: { runId: string; status: string; state: any }) {
    if (this.failing) throw new Error("TypeError: fetch failed");
    this.saves++;
    this.rows.set(row.runId, { ...row, state: structuredClone(row.state), updatedAt: Date.now() });
  }
  async recent(since: number) { return [...this.rows.values()].filter((r) => r.updatedAt >= since).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => ({ ...r, state: structuredClone(r.state) })); }
}

export class SupabaseRunStore implements RunStore {
  readonly kind = "supabase" as const;
  private readonly db: SupabaseLike;
  constructor(db: SupabaseLike) { this.db = db; }
  async save(row: { runId: string; status: string; state: any }) {
    const r = await this.db.from("runs").upsert({ run_id: row.runId, status: row.status, state: row.state, updated_at: new Date().toISOString() }, { onConflict: "run_id" });
    if (r?.error) throw new Error(r.error.message);
  }
  async recent(since: number) {
    const r = await this.db.from("runs").select("run_id, status, state, updated_at").gte("updated_at", new Date(since).toISOString()).order("updated_at", { ascending: false });
    if (r?.error) throw new Error(r.error.message);
    return ((r?.data ?? []) as any[]).map((d) => ({ runId: String(d.run_id), status: String(d.status), state: d.state, updatedAt: Date.parse(String(d.updated_at)) || 0 }));
  }
}

/** Write-behind: touch(runId) marks a run dirty; its latest dump is saved shortly after, once per burst. */
export class RunSaver {
  private readonly store: RunStore;
  private readonly dump: (runId: string) => { status: string; state: any } | null;
  private readonly log: (line: string) => void;
  private readonly delayMs: number;
  private readonly dirty = new Set<string>();
  private readonly saving = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private failed = new Map<string, number>();   // runId -> failures in a row (retried with backoff, never dropped)
  constructor(o: { store: RunStore; dump: (runId: string) => { status: string; state: any } | null; log?: (line: string) => void; delayMs?: number }) {
    this.store = o.store; this.dump = o.dump; this.log = o.log ?? (() => {}); this.delayMs = o.delayMs ?? 500;
  }
  touch(runId: string) {
    this.dirty.add(runId);
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, this.delayMs); this.timer.unref?.(); }
  }
  pending(): number { return this.dirty.size + this.saving.size; }
  /** Save everything dirty now and wait for it (SIGTERM, tests): a run whose save failed is tried again here. */
  async flush() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      for (const id of this.failed.keys()) this.dirty.add(id);
      await this.drain();
      await Promise.all([...this.saving.values()]);
      if (!this.failed.size) return;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  private async drain() {
    const ids = [...this.dirty]; this.dirty.clear();
    await Promise.all(ids.map((id) => this.saveOne(id)));
  }
  private saveOne(runId: string): Promise<void> {
    const prev = this.saving.get(runId) ?? Promise.resolve();
    const job = prev.then(async () => {
      const row = this.dump(runId);
      if (!row) return;                                   // evicted meanwhile
      try {
        await this.store.save({ runId, ...row });
        this.failed.delete(runId);
      } catch (e) {
        const n = (this.failed.get(runId) ?? 0) + 1; this.failed.set(runId, n);
        this.log(`[runs] save of ${runId} failed (${n}): ${(e as Error).message}`);
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, n - 1));
        const t = setTimeout(() => this.touch(runId), wait); t.unref?.();   // retried; the next dump is the latest state
      }
    }).finally(() => { if (this.saving.get(runId) === job) this.saving.delete(runId); });
    this.saving.set(runId, job);
    return job;
  }
}

/** How long a run stays answerable (and restorable) after its last change. */
export const RUN_KEEP_MS = 2 * 60 * 60 * 1000;
