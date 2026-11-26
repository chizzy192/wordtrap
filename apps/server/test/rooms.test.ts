// Rooms and seats: items 1–9 of the "rooms and rules" audit. Real runs, no fixtures, DEMO unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { startCrowd } from "../src/crowd.ts";
import { Room, IDLE_TURNS } from "../src/rooms.ts";

const hdr = (user: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-user": user, ...extra });
const salt = new Uint8Array(32).fill(3);
async function boot(opts: Record<string, unknown> = {}) {
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 3 }, spectateDelay: 0, ...opts });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const startRun = async (callsign = "Oly") => {
    const r = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign }) }).then((r) => r.json());
    return { ...r, auth: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` } };
  };
  return { app, base, startRun };
}
const seat = (base: string, runId: string, user: string, action = "take") => fetch(`${base}/runs/${runId}/seat`, { method: "POST", headers: hdr(user), body: JSON.stringify({ action }) });
async function treasuryKey(base: string) { return Uint8Array.from(Buffer.from((await fetch(`${base}/api/v1/treasury`).then((r) => r.json())).pubkeyHex, "hex")); }

test("1+3: four seats, taking one returns a number and a token, the fifth person gets 409, leaving frees the seat", async () => {
  const { app, base, startRun } = await boot();
  const { runId } = await startRun();
  const tokens: Record<string, string> = {};
  for (let i = 1; i <= 4; i++) {
    const r = await seat(base, runId, `guest-SEAT000${i}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.seat, i); assert.match(j.token, /^[0-9a-f]{32}$/);
    tokens[`guest-SEAT000${i}`] = j.token;
  }
  const fifth = await seat(base, runId, "guest-SEAT0005");
  assert.equal(fifth.status, 409);
  assert.equal((await fifth.json()).error, "All four seats are taken. You can still back Byte.");
  // taking again returns the same seat, not a new one
  assert.equal((await seat(base, runId, "guest-SEAT0002").then((r) => r.json())).seat, 2);
  // leaving frees it and the fifth person gets it
  await seat(base, runId, "guest-SEAT0002", "leave");
  const now = await seat(base, runId, "guest-SEAT0005").then((r) => r.json());
  assert.equal(now.seat, 2);
  const feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.ok(feed.events.some((e: any) => e.type === "seat" && e.action === "leave" && e.seat === 2));
  assert.ok(feed.events.some((e: any) => e.type === "seat" && e.action === "take" && e.seat === 2 && e.address === "guest-SEAT0005"));
  await app.close();
});

test("2: plant-fiat is refused without a valid seat token for the caller; back-fiat needs no seat", async () => {
  const { app, base, startRun } = await boot();
  const { runId, state } = await startRun();
  const me = "guest-PLANTER1";
  await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(me), body: JSON.stringify({ amount: 5 }) });
  const key = await treasuryKey(base);
  const word = state.nextHand.hand.find((w: string) => w !== state.nextHand.safe);
  const body = JSON.stringify({ commitmentHex: toHex(commitment(word, salt, key)), stake: 0.5 });
  const noSeat = await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(me), body });
  assert.equal(noSeat.status, 403);
  assert.equal((await noSeat.json()).error, "Take a seat first. Only seated players can plant mines.");
  const { token } = await seat(base, runId, me).then((r) => r.json());
  const badToken = await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(me, { "x-seat-token": "nope" }), body });
  assert.equal(badToken.status, 403);
  // someone else's token does not work for me either
  const other = await seat(base, runId, "guest-OTHERONE").then((r) => r.json());
  assert.equal((await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(me, { "x-seat-token": other.token }), body })).status, 403);
  const ok = await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: hdr(me, { "x-seat-token": token }), body });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).balanceMicro, 4_500_000, "only the valid attempt was debited");
  // the batch route needs the token too
  const batch = await fetch(`${base}/runs/${runId}/plant-fiat-batch`, { method: "POST", headers: hdr(me), body: JSON.stringify({ items: [{ commitmentHex: "ab".repeat(32), stake: 0.1 }] }) });
  assert.equal(batch.status, 403);
  // backing needs no seat
  const back = await fetch(`${base}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr("guest-BACKER01"), body: JSON.stringify({ amount: 1 }) });
  assert.equal(back.status, 402, "no seat check: the only objection is the empty balance");
  await app.close();
});

test("4: a seat with no plant and no authenticated poll for 10 turns is freed and announced", async () => {
  const { app, base, startRun } = await boot();
  const { runId, auth } = await startRun();
  const quiet = "guest-QUIETONE", active = "guest-ACTIVE01";
  await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: hdr(quiet), body: JSON.stringify({ name: "ada" }) });
  await seat(base, runId, quiet); await seat(base, runId, active);
  for (let t = 0; t < IDLE_TURNS; t++) {
    await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
    await fetch(`${base}/runs/${runId}/spectate`, { headers: hdr(active) });        // the active player keeps polling with identity
  }
  const feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  const freed = feed.events.find((e: any) => e.type === "seat" && e.action === "idle");
  assert.ok(freed, "idle seat announced");
  assert.equal(freed.detail, "ada's seat was freed after 10 quiet turns.");
  assert.equal(freed.address, quiet);
  assert.equal(feed.state.seats[0].kind, "open");
  assert.equal(feed.state.seats[1].kind, "human");
  assert.equal(feed.state.seats[1].address, active);
  await app.close();
});

test("5: bots fill the empty seats: 4 minus humans, one stops when a person sits, returns when they leave; CROWD off means none", async () => {
  const { app, base, startRun } = await boot({ crowd: true });
  const { runId } = await startRun();
  const run = app.runs.get(runId)!;
  assert.equal(run.room.botCount(), 4);
  let feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.deepEqual(feed.state.seats.map((s: any) => s.kind), ["bot", "bot", "bot", "bot"]);
  await seat(base, runId, "guest-HUMAN001");
  assert.equal(run.room.botCount(), 3);
  feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.deepEqual(feed.state.seats.map((s: any) => s.kind), ["human", "bot", "bot", "bot"]);
  await seat(base, runId, "guest-HUMAN001", "leave");
  assert.equal(run.room.botCount(), 4);
  // the crowd plants with exactly the bot count
  const chain = run.chain as MockChain;
  const planted: string[] = [];
  const real = chain.plantTrap.bind(chain);
  chain.plantTrap = async (a) => { planted.push(a.setter); return real(a); };
  let r: Room = run.room;
  startCrowd(run.match, chain, { aggression: 1, rnd: () => 0.5, setterCount: () => r.botCount() });
  await run.match.act("pass_turn");
  assert.equal(new Set(planted).size, 4);
  planted.length = 0; await seat(base, runId, "guest-HUMAN001"); await seat(base, runId, "guest-HUMAN002");
  await run.match.act("pass_turn");
  assert.equal(new Set(planted).size, 2, "two people seated, two bots plant");
  chain.plantTrap = real;
  await app.close();
  const off = await boot({ crowd: false });
  const r2 = await off.startRun();
  assert.equal(off.app.runs.get(r2.runId)!.room.botCount(), 0);
  assert.deepEqual((await fetch(`${off.base}/runs/${r2.runId}/spectate`).then((x) => x.json())).state.seats.map((s: any) => s.kind), ["open", "open", "open", "open"]);
  await off.app.close();
});

test("6+7+8: quick play prefers the room with most people then the newest, skips private rooms, and the rooms list describes live public rooms", async () => {
  const { app, base, startRun } = await boot();
  const a = await startRun("Oly"); await new Promise((r) => setTimeout(r, 5));
  const b = await startRun("Mira"); await new Promise((r) => setTimeout(r, 5));
  const c = await startRun("Zed");
  await seat(base, b.runId, "guest-INROOMB1");                               // b has 1 person
  const list = await fetch(`${base}/api/v1/rooms`).then((r) => r.json());
  assert.deepEqual(list.map((r: any) => r.byte), ["Mira", "Zed", "Oly"], "most people first, then newest");
  assert.deepEqual(Object.keys(list[0]).sort(), ["byte", "code", "fuse", "fuseTotal", "people", "runId", "seats", "turn"]);
  assert.deepEqual(list[0].seats, ["human", "open", "open", "open"]);
  const q = await fetch(`${base}/api/v1/rooms/quick`, { method: "POST", headers: hdr("guest-QUICK001"), body: "{}" }).then((r) => r.json());
  assert.equal(q.runId, b.runId); assert.equal(q.seat, 2); assert.match(q.token, /^[0-9a-f]{32}$/);
  // host of b makes it private: hidden from the list and from quick play
  const priv = await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: hdr("guest-INROOMB1"), body: JSON.stringify({ private: true }) });
  assert.equal(priv.status, 200);
  assert.equal((await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: hdr("guest-QUICK001"), body: JSON.stringify({ private: true }) })).status, 403, "only the host");
  const list2 = await fetch(`${base}/api/v1/rooms`).then((r) => r.json());
  assert.deepEqual(list2.map((r: any) => r.runId), [c.runId, a.runId]);
  const q2 = await fetch(`${base}/api/v1/rooms/quick`, { method: "POST", headers: hdr("guest-QUICK002"), body: "{}" }).then((r) => r.json());
  assert.equal(q2.runId, c.runId, "newest public room");
  const feed = await fetch(`${base}/runs/${b.runId}/spectate`, { headers: hdr("guest-INROOMB1") }).then((r) => r.json());
  assert.equal(feed.state.private, true); assert.equal(feed.state.host, "guest-INROOMB1"); assert.equal(feed.state.room.host, true);
  // no room with a free seat → a clear sentence
  for (const run of [a, c]) for (let i = 0; i < 4; i++) await seat(base, run.runId, `guest-FILL${run.runId.slice(0, 4)}${i}`);
  const none = await fetch(`${base}/api/v1/rooms/quick`, { method: "POST", headers: hdr("guest-QUICK003"), body: "{}" });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, "No room has a free seat right now. A room opens when a Byte agent starts a run.");
  await app.close();
});

test("9: the spectate state carries seats (player address or bot or open), host and private, with `you` for the viewer", async () => {
  const { app, base, startRun } = await boot({ crowd: true });
  const { runId } = await startRun();
  await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: hdr("guest-NAMEDONE"), body: JSON.stringify({ name: "chizzy" }) });
  await seat(base, runId, "guest-NAMEDONE");
  const mine = await fetch(`${base}/runs/${runId}/spectate`, { headers: hdr("guest-NAMEDONE") }).then((r) => r.json());
  assert.deepEqual(mine.state.seats[0], { kind: "human", no: 1, address: "guest-NAMEDONE", name: "chizzy", you: true });
  assert.deepEqual(mine.state.seats[1], { kind: "bot", no: 2, name: "Bot" });
  assert.equal(mine.state.host, "guest-NAMEDONE"); assert.equal(mine.state.private, false);
  const anon = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.equal(anon.state.seats[0].you, false);
  await app.close();
});

test("10: the private flag is undelayed and sticky: the host sets it and it holds across five delayed polls; a non-host is refused with the reason; the room leaves the list and quick play", async () => {
  const { app, base, startRun } = await boot({ spectateDelay: 4 });   // the board snapshot is 4 s behind; the room must not be
  const a = await startRun("Oly"); await new Promise((r) => setTimeout(r, 5));
  const b = await startRun("Mira");
  const host = "guest-HOSTROOM", other = "guest-NOTHOST1";
  const took = await seat(base, b.runId, host).then((r) => r.json());
  assert.equal(took.host, true); assert.equal(took.room.you.host, true); assert.equal(took.room.private, false);
  assert.equal((await seat(base, b.runId, other).then((r) => r.json())).room.you.host, false);
  const set = await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: hdr(host), body: JSON.stringify({ private: true }) });
  assert.equal(set.status, 200);
  const sj = await set.json();
  assert.equal(sj.private, true); assert.deepEqual(sj.room.you, { host: true, seat: 1 });
  for (let i = 1; i <= 5; i++) {
    const feed = await fetch(`${base}/runs/${b.runId}/spectate?paced=1`, { headers: hdr(host) }).then((r) => r.json());
    assert.equal(feed.room.private, true, `poll ${i}: top-level room`); assert.equal(feed.room.you.host, true);
    assert.equal(feed.state.private, true, `poll ${i}: state copy`); assert.equal(feed.state.room.host, true);
    for (const e of feed.events) if (e.state) assert.equal("private" in e.state, false, "event snapshots carry no room fields");
  }
  const refused = await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: hdr(other), body: JSON.stringify({ private: false }) });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "Only the host can make the room private.");
  assert.equal((await fetch(`${base}/runs/${b.runId}/spectate`, { headers: hdr(other) }).then((r) => r.json())).room.private, true, "still private");
  // an unidentified request (what the page used to send) is refused too, and changes nothing
  assert.equal((await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ private: false }) })).status, 400);
  const list = await fetch(`${base}/api/v1/rooms`).then((r) => r.json());
  assert.deepEqual(list.map((r: any) => r.runId), [a.runId], "the private room is not listed");
  const quick = await fetch(`${base}/api/v1/rooms/quick`, { method: "POST", headers: hdr("guest-QUICK009"), body: "{}" }).then((r) => r.json());
  assert.equal(quick.runId, a.runId, "quick play skips the private room");
  // the host opens it again: back in the list at once
  await fetch(`${base}/runs/${b.runId}/room`, { method: "POST", headers: hdr(host), body: JSON.stringify({ private: false }) });
  assert.ok((await fetch(`${base}/api/v1/rooms`).then((r) => r.json())).some((r: any) => r.runId === b.runId));
  await app.close();
});
