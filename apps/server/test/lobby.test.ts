// Lobby: "Start a room" opens a run the house Byte plays with the starter seated as host; the rooms list carries
// all-bot rooms; the copy helper and the lobby page states exist as specified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";

const hdr = (user: string) => ({ "content-type": "application/json", "x-user": user });
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("POST /api/v1/rooms: the house Byte plays, the starter hosts seat 1, the room is listed; three at most; identity required", async () => {
  const app = createApp({ sim: false, crowd: true, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 3 }, houseDelayMs: 1000 });   // slow enough that no three-tile house room finishes during the test
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401, "identity required");
    const r = await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: hdr("guest-STARTER1"), body: "{}" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.code, j.runId); assert.equal(j.seat, 1); assert.equal(j.host, true); assert.match(j.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(j.room.seats.map((s: any) => s.kind), ["human", "bot", "bot", "bot"]);
    const list = await fetch(`${base}/api/v1/rooms`).then((x) => x.json());
    const mine = list.find((x: any) => x.runId === j.runId);
    assert.ok(mine, "listed"); assert.equal(mine.byte, "House Byte"); assert.equal(mine.people, 1);
    // the house Byte is playing: the turn advances by itself
    const turnOf = async () => (await fetch(`${base}/runs/${j.runId}/spectate?delay=0`).then((x) => x.json())).state.turn;
    const turn0 = await turnOf(); let turn1 = turn0;
    for (let i = 0; i < 30 && turn1 <= turn0; i++) { await new Promise((res) => setTimeout(res, 100)); turn1 = await turnOf(); }
    assert.ok(turn1 > turn0, `house Byte moved (${turn0} → ${turn1})`);
    // a run started by an agent with nobody seated is an all-bot room and is listed too
    await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Oly" }) });
    const list2 = await fetch(`${base}/api/v1/rooms`).then((x) => x.json());
    assert.ok(list2.some((x: any) => x.byte === "Oly" && x.seats.every((s: string) => s === "bot") && x.people === 0), "all-bot room listed");
    // cap: three house rooms
    for (const u of ["guest-STARTER2", "guest-STARTER3"]) assert.equal((await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: hdr(u), body: "{}" })).status, 200);
    const full = await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: hdr("guest-STARTER4"), body: "{}" });
    assert.equal(full.status, 409);
    assert.equal((await full.json()).error, "Three house rooms are already open. Join one of them instead.");
  } finally { await app.close(); }
});

test("lobby page: Start a room button, list states, copy link per room; copy helper with textarea fallback; links are /play?room=<code>", async () => {
  const play = read("../../watch/play.html");
  assert.ok(play.includes('id="startRoom" type="button">Start a room</button>'), "Start a room button");
  assert.ok(play.includes('No rooms are live right now. A room opens when a Byte agent starts a run.'), "empty state");
  assert.ok(play.includes('<span class="empty err">${failed}</span>'), "error state in the list");
  assert.ok(play.includes('data-copy="${esc(r.code)}"') && play.includes('"Link copied"'), "copy link per room");
  assert.ok(play.includes("setInterval(loadRooms, 5000)") && play.includes("\nloadRooms();"), "list loads at once and refreshes");
  const id = read("../../watch/identity.js");
  assert.ok(id.includes("export async function copyText") && id.includes('document.execCommand("copy")'), "textarea fallback");
  assert.ok(id.includes("`${location.origin}/play?room=${encodeURIComponent(code)}`"), "lobby room link");
  const board = read("../../watch/index.html");
  assert.ok(board.includes("copyText(roomLink(runId))") && !board.includes('"/watch/" + runId'), "board copies the lobby link");
  const side = read("../../stake/src/SidePage.tsx");
  assert.ok(side.includes('{copied ? "Link copied" : "Copy room link"}') && side.includes("copyText(roomLink(runId))"), "side page copy link");
  const { copyText, roomLink } = await import("../../watch/identity.js");
  assert.equal(typeof copyText, "function");
  // roomLink uses the page origin; in node there is no location, so only its shape is checked above
  assert.equal(typeof roomLink, "function");
});
