// Runs survive a restart. Saved write-behind (never in the way of an answer, retried, last write wins, flushed on
// close), restored on startup with the same runId, turn and API key; watchers keep their cursor; stakes of a
// restored run are not refunded; runs older than two hours are not restored and their stakes are; finished runs
// stay answerable; the house Byte and the bots pick up again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { MemoryRunStore, SupabaseRunStore, RUN_KEEP_MS } from "../src/persist.ts";
import { fakeSupabase } from "./fake-supabase.ts";

const hdr = (user: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-user": user, ...extra });
const salt = new Uint8Array(32).fill(5);
const ME = "guest-RESTORE1";

/** An app over a shared run store and a shared ledger file, so a second boot is a restart of the first. */
function boot(store: any, ledgerPath: string, extra: Record<string, unknown> = {}) {
  return createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath, cfg: { tiles: 3 }, spectateDelay: 0, runStore: store, bots: false, ...extra });
}
const startRun = async (base: string) => { const r = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Oly" }) }).then((r) => r.json()); return { ...r, auth: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` } }; };
const act = (base: string, runId: string, auth: Record<string, string>, turn: number, word?: string) =>
  fetch(`${base}/api/v1/runs/${runId}/${word ? "play" : "pass"}`, { method: "POST", headers: auth, body: JSON.stringify({ turn, word }) });
async function treasuryKey(base: string) { return Uint8Array.from(Buffer.from((await fetch(`${base}/api/v1/treasury`).then((r) => r.json())).pubkeyHex, "hex")); }
const balance = async (base: string, user: string) => (await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr(user) }).then((r) => r.json())).balanceMicro as number;

test("restart: three turns, a seat, a mine and a backer; the fourth turn is accepted with the same key, a stale turn is refused, nothing is refunded, the cursor still works", async () => {
  const store = new MemoryRunStore();
  const dir = mkdtempSync(join(tmpdir(), "wt-restore-")); const ledgerPath = join(dir, "ledger.json");
  const a = boot(store, ledgerPath); const portA = await a.listen(0); const baseA = `http://127.0.0.1:${portA}`;
  const { runId, apiKey, auth, state: s0 } = await startRun(baseA);
  await fetch(`${baseA}/dev/credit`, { method: "POST", headers: hdr(ME), body: JSON.stringify({ amount: 10 }) });
  await fetch(`${baseA}/dev/credit`, { method: "POST", headers: hdr("guest-BACKER01"), body: JSON.stringify({ amount: 10 }) });
  const seat = await fetch(`${baseA}/runs/${runId}/seat`, { method: "POST", headers: hdr(ME), body: JSON.stringify({ action: "take" }) }).then((r) => r.json());
  const key = await treasuryKey(baseA);
  const word = s0.nextHand.hand.find((w: string) => w !== s0.nextHand.safe);
  const plant = await fetch(`${baseA}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(ME, { "x-seat-token": seat.token }), body: JSON.stringify({ commitmentHex: toHex(commitment(word, salt, key)), stake: 1 }) }).then((r) => r.json());
  assert.ok(plant.trap, "mine planted");
  const back = await fetch(`${baseA}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr("guest-BACKER01"), body: JSON.stringify({ amount: 2 }) }).then((r) => r.json());
  assert.equal(back.backed, 2_000_000);
  let state = s0;
  for (let t = 1; t <= 3; t++) { const r = await act(baseA, runId, auth, state.turn, state.hand.find((w: string) => w !== state.safe)); assert.equal(r.status, 200); state = await r.json(); }
  assert.equal(state.turn, 4);
  const before = await fetch(`${baseA}/runs/${runId}/spectate`).then((r) => r.json());
  const balMe = await balance(baseA, ME), balBacker = await balance(baseA, "guest-BACKER01");
  assert.equal(balMe, 9_000_000); assert.equal(balBacker, 8_000_000);
  await a.close();                                   // close() flushes every dirty run
  assert.ok(store.rows.has(runId), "the run was saved");
  assert.equal(store.rows.get(runId)!.status, "live");

  // ---- restart: same store, same ledger file ----
  const b = boot(store, ledgerPath); const portB = await b.listen(0); const baseB = `http://127.0.0.1:${portB}`;
  try {
    const run = b.runs.get(runId); assert.ok(run, "the run is back"); assert.ok(run!.restored);
    const st = await fetch(`${baseB}/api/v1/runs/${runId}/state`, { headers: auth });
    assert.equal(st.status, 200, "Byte's key still works");
    const sb = await st.json();
    assert.equal(sb.turn, 4, "same turn"); assert.equal(sb.matchId, runId); assert.equal(sb.position, state.position); assert.deepEqual(sb.hand, state.hand);
    assert.equal(sb.traps.length, state.traps.length, "the mine is still on the board"); assert.equal(sb.backerTotal, state.backerTotal, "the pool figure is back");
    // a stale turn is still rejected, the right turn is accepted
    const stale = await act(baseB, runId, auth, 3); assert.equal(stale.status, 409); assert.match((await stale.json()).error, /stale turn/);
    const ok = await act(baseB, runId, auth, 4, sb.hand.find((w: string) => w !== sb.safe)); assert.equal(ok.status, 200); assert.equal((await ok.json()).turn, 5);
    const bad = await fetch(`${baseB}/api/v1/runs/${runId}/state`, { headers: { authorization: "Bearer " + "0".repeat(32) } }); assert.equal(bad.status, 401);
    // nothing was refunded: the mine and the backing are still open positions of a live run
    assert.equal(await balance(baseB, ME), balMe, "setter's stake not refunded"); assert.equal(await balance(baseB, "guest-BACKER01"), balBacker, "backer's stake not refunded");
    assert.equal(b.ledger.history(ME, 50).filter((h) => h.reason === "refund").length, 0);
    assert.equal(b.ledger.backersOf(runId)["guest-BACKER01"], 2_000_000, "backer slice restored"); assert.equal(b.ledger.trapOwner(plant.trap.id)?.user, ME, "mine owner restored");
    // the seat and its token survive: planting again works without taking the seat again
    const feed = await fetch(`${baseB}/runs/${runId}/spectate`, { headers: hdr(ME) }).then((r) => r.json());
    assert.equal(feed.room.you.seat, seat.seat, "seat kept"); assert.equal(feed.room.host, ME);
    const next = (sb.nextHand ?? sb.laterHand) as { hand: string[]; safe: string | null } | null;
    const w2 = next ? next.hand.find((w: string) => w !== next.safe)! : sb.hand.find((w: string) => w !== sb.safe)!;
    const again = await fetch(`${baseB}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(ME, { "x-seat-token": seat.token }), body: JSON.stringify({ commitmentHex: toHex(commitment(w2, salt, key)), stake: 0.5 }) });
    assert.equal(again.status, 200, "seat token still valid");
    // a watcher's "after" cursor: only events after the last one it saw, and the earlier ones are still there from 0
    const after = await fetch(`${baseB}/runs/${runId}/spectate?after=${before.seq}`).then((r) => r.json());
    assert.ok(after.seq > before.seq); assert.ok(after.events.length >= 1 && after.events.length < before.seq + after.events.length, "only new events");
    assert.ok(after.events.some((e: any) => e.type === "action" && e.turn === 4), "the turn played after the restart is in the feed");
    const all = await fetch(`${baseB}/runs/${runId}/spectate?after=0`).then((r) => r.json());
    assert.equal(all.events.length, after.seq, "the whole log is back from seq 0");
    assert.ok(all.events.some((e: any) => e.type === "seat" && e.address === ME), "the seat event from before the restart");
    assert.ok(all.events.some((e: any) => e.type === "action" && e.turn === 1), "the first turn from before the restart");
  } finally { await b.close(); }
});

test("saving never fails an answer: with the store down the API keeps answering; the save is retried and lands once the store is back", async () => {
  const store = new MemoryRunStore();
  const app = boot(store, null as any); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    store.failing = true;
    const { runId, auth, state } = await startRun(base);
    const r = await act(base, runId, auth, state.turn); assert.equal(r.status, 200, "answered while the store fails");
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(store.rows.has(runId), false);
    store.failing = false;
    await app.flush();
    assert.ok(store.rows.has(runId), "saved once the store was back"); assert.equal(store.rows.get(runId)!.state.match.state.turn, 2);
    // last write wins: ten quick changes, far fewer saves
    const n = store.saves; let s = store.rows.get(runId)!.state.match.state;
    for (let i = 0; i < 6; i++) { const rr = await act(base, runId, auth, s.turn); s = await rr.json(); }
    await app.flush();
    assert.ok(store.saves - n <= 3, `coalesced (${store.saves - n} saves for 6 turns)`); assert.equal(store.rows.get(runId)!.state.match.state.turn, 8);
  } finally { await app.close(); }
});

test("startup: a run saved more than two hours ago is not restored and its stakes are refunded; a finished run stays answerable; the Supabase row shape", async () => {
  const fake = fakeSupabase(); const store = new SupabaseRunStore(fake.client);
  const dir = mkdtempSync(join(tmpdir(), "wt-restore-")); const ledgerPath = join(dir, "ledger.json");
  const a = boot(store, ledgerPath); const portA = await a.listen(0); const baseA = `http://127.0.0.1:${portA}`;
  const old = await startRun(baseA); const fin = await startRun(baseA);
  await fetch(`${baseA}/dev/credit`, { method: "POST", headers: hdr(ME), body: JSON.stringify({ amount: 10 }) });
  await fetch(`${baseA}/runs/${old.runId}/back-fiat`, { method: "POST", headers: hdr(ME), body: JSON.stringify({ amount: 3 }) });
  // finish the second run by passing until the fuse is gone
  let s = fin.state; while (s.status === "live") { s = await act(baseA, fin.runId, fin.auth, s.turn).then((r) => r.json()); }
  await a.close();
  const rows = fake.tables.runs; assert.equal(rows.length, 2);
  const rowOld = rows.find((r) => r.run_id === old.runId)!; assert.equal(rowOld.status, "live"); assert.ok(rowOld.state.match && rowOld.state.room && rowOld.state.chain && rowOld.updated_at, "run_id, status, state jsonb, updated_at");
  assert.equal(rows.find((r) => r.run_id === fin.runId)!.status, "dead");
  rowOld.updated_at = new Date(Date.now() - RUN_KEEP_MS - 60_000).toISOString();   // stale: a run from another day
  const b = boot(store, ledgerPath); await b.listen(0);
  try {
    assert.equal(b.runs.get(old.runId), undefined, "a stale run is not restored");
    assert.equal(b.ledger.balance(ME), 10_000_000, "its backing was refunded");
    const back = b.runs.get(fin.runId); assert.ok(back && back.match.finished(), "a finished run is answerable");
    const st = await fetch(`http://127.0.0.1:${b.port()}/api/v1/runs/${fin.runId}/state`, { headers: fin.auth }); assert.equal(st.status, 200); assert.equal((await st.json()).status, "dead");
    // and it leaves memory two hours after it ended
    assert.deepEqual(b.runs.evictFinished(Date.now() + RUN_KEEP_MS + 1000), [fin.runId]); assert.equal(b.runs.get(fin.runId), undefined);
  } finally { await b.close(); }
});

test("restart: the house Byte and the bots pick up a restored room", async () => {
  const store = new MemoryRunStore();
  const a = boot(store, null as any, { houseDelayMs: 150, crowd: { setters: 4, aggression: 1, focus: 0.75, backerUsd: 0 }, bots: true }); const portA = await a.listen(0); const baseA = `http://127.0.0.1:${portA}`;
  const room = await fetch(`${baseA}/api/v1/rooms`, { method: "POST", headers: hdr(ME), body: JSON.stringify({}) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 900));
  const turnA = (await fetch(`${baseA}/runs/${room.runId}/spectate`, { headers: hdr(ME) }).then((r) => r.json())).state.turn;   // an authenticated poll keeps the seat
  assert.ok(turnA >= 2, `the house Byte played (turn ${turnA})`);
  await a.close();
  const b = boot(store, null as any, { houseDelayMs: 150, crowd: { setters: 4, aggression: 1, focus: 0.75, backerUsd: 0 }, bots: true }); const portB = await b.listen(0); const baseB = `http://127.0.0.1:${portB}`;
  try {
    const first = await fetch(`${baseB}/runs/${room.runId}/spectate`, { headers: hdr(ME) }).then((r) => r.json());
    const s0 = first.state;
    assert.ok(s0.turn >= turnA, "same turn or later, never earlier");
    assert.equal(first.room.you.seat, 1, "the starter still has seat 1 right after the restart");
    await new Promise((r) => setTimeout(r, 1200));
    const s1 = (await fetch(`${baseB}/runs/${room.runId}/spectate`, { headers: hdr(ME) }).then((r) => r.json())).state;
    assert.ok(s1.turn > s0.turn || s1.status !== "live", `the house Byte resumed (turn ${s0.turn} → ${s1.turn})`);
    assert.ok(s1.traps.length > s0.traps.length || s1.status !== "live", `the bots resumed (${s0.traps.length} → ${s1.traps.length} mines)`);
  } finally { await b.close(); }
});
