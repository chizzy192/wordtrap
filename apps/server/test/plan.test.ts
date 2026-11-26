import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";

const hdr = (user: string) => ({ "content-type": "application/json", "x-user": user });
/** Planting needs a seat: take one for the user and return headers carrying the seat token. */
async function seated(base: string, runId: string, user: string) {
  const seat = await fetch(`${base}/runs/${runId}/seat`, { method: "POST", headers: hdr(user), body: JSON.stringify({ action: "take" }) }).then((r) => r.json());
  return { ...hdr(user), "x-seat-token": String(seat.token ?? "") };
}
const salt = new Uint8Array(32).fill(7);
async function boot(delay = 0) {
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 3 }, spectateDelay: delay });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}
async function treasuryKey(base: string) { return Uint8Array.from(Buffer.from((await fetch(`${base}/api/v1/treasury`).then((r) => r.json())).pubkeyHex, "hex")); }

test("a mine planted on a nextHand card is armed before Byte can play it, and the dealt hand equals the preview", async () => {
  const { app, base } = await boot();
  const guest = "guest-PLANAHEAD";
  await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(guest), body: JSON.stringify({ amount: 5 }) });
  const { runId, apiKey, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  assert.ok(state.nextHand && state.nextHand.hand.length >= 8, "the next tile's hand is visible");
  assert.ok(state.laterHand && state.laterHand.hand.length >= 8, "and the one after");
  assert.ok(state.nextHand.safe && state.nextHand.hand.includes(state.nextHand.safe));
  assert.ok(state.safe && state.hand.includes(state.safe));
  const target = state.nextHand.hand.find((w: string) => w !== state.nextHand.safe && !state.hand.includes(w));
  const c = toHex(commitment(target, salt, await treasuryKey(base)));
  const planted = await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: await seated(base, runId, guest), body: JSON.stringify({ commitmentHex: c, stake: 1 }) }).then((r) => r.json());
  assert.equal(planted.turn, 1);
  assert.equal(planted.trap.armedTurn, 2, "live from turn 2, Byte is on turn 1");
  // Byte clears the first tile (needs >= 2 plays) → it reaches the next tile no earlier than turn 3, after the mine is live
  let s = state;
  while (s.position === 0 && s.status === "live") s = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: s.hand.find((w: string) => w !== target) }) }).then((r) => r.json());
  assert.equal(s.position, 1);
  assert.ok(s.turn >= 3);
  assert.deepEqual(s.hand, state.nextHand.hand, "what was previewed is what got dealt");
  assert.equal(s.safe, state.nextHand.safe);
  assert.ok(s.hand.includes(target));
  s = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: target }) }).then((r) => r.json());
  const revealed = await fetch(`${base}/runs/${runId}/reveal-fiat`, { method: "POST", headers: hdr(guest), body: JSON.stringify({ trapId: planted.trap.id, word: target, saltHex: toHex(salt) }) }).then((r) => r.json());
  assert.equal(revealed.status, "paid", "the mine was live when Byte got there");
  assert.equal(revealed.payoutMicro, 3_000_000);
  // the safe card cannot pay out
  const safeC = toHex(commitment(s.safe, salt, await treasuryKey(base)));
  const sp = await fetch(`${base}/runs/${runId}/plant-fiat`, { method: "POST", headers: await seated(base, runId, guest), body: JSON.stringify({ commitmentHex: safeC, stake: 0.5 }) }).then((r) => r.json());
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: s.safe }) });
  const refused = await fetch(`${base}/runs/${runId}/reveal-fiat`, { method: "POST", headers: hdr(guest), body: JSON.stringify({ trapId: sp.trap.id, word: s.safe, saltHex: toHex(salt) }) });
  assert.equal(refused.status, 400);
  // "safe card" while the tile is still open; if that play cleared the tile, the chain answers "not triggered" (a safe-card play is never recorded as spoken)
  assert.match((await refused.json()).error, /safe card|not triggered/);
  await app.close();
});

test("the undelayed picker shows which cards exist and nothing the delayed board has not shown", async () => {
  const { app, base } = await boot(10);                                   // the board is 10 s behind
  const { runId, apiKey, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  await fetch(`${base}/api/v1/runs/${runId}/hint`, { method: "POST", headers: auth, body: "{}" });
  const played = state.hand[0];
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: played }) });
  const board = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.equal(board.state.turn, 1, "the delayed board still shows turn 1");
  const pick = await fetch(`${base}/runs/${runId}/picker`).then((r) => r.json());
  assert.equal(pick.turn, 3, "the picker is live");
  assert.deepEqual(Object.keys(pick).sort(), ["current", "laterHand", "nextHand", "position", "status", "turn"]);
  assert.deepEqual(pick.current.hand, state.hand, "all cards that exist on this tile, including the one already played");
  assert.deepEqual(Object.keys(pick.current).sort(), ["hand", "prompt", "safe"]);
  const text = JSON.stringify(pick);
  for (const leak of ["played", "spoken", "hint", "traps", "fired", "score", "fuse"]) assert.ok(!text.includes(`"${leak}"`), `picker must not carry ${leak}`);
  await app.close();
});

test("arming three cards in one action creates three mines, each debited from the identity", async () => {
  const { app, base } = await boot();
  const guest = "guest-THREEMINE";
  await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(guest), body: JSON.stringify({ amount: 2 }) });
  const { runId, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  const key = await treasuryKey(base);
  const next = state.nextHand.hand.filter((w: string) => w !== state.nextHand.safe);
  const later = state.laterHand.hand.filter((w: string) => w !== state.laterHand.safe && !next.includes(w));
  const words = [next[0], next[1], later[0]];
  assert.equal(words.length, 3);
  const items = words.map((w, i) => ({ commitmentHex: toHex(commitment(w, new Uint8Array(32).fill(i + 1), key)), stake: 0.5 }));
  const r = await fetch(`${base}/runs/${runId}/plant-fiat-batch`, { method: "POST", headers: await seated(base, runId, guest), body: JSON.stringify({ items }) }).then((r) => r.json());
  assert.equal(r.results.filter((x: any) => x.ok).length, 3);
  assert.equal(r.balanceMicro, 500_000);
  assert.equal(r.turn, 1);
  const feed = await fetch(`${base}/runs/${runId}/spectate?delay=0`).then((r) => r.json());
  assert.equal(feed.state.traps.length, 3);
  assert.ok(feed.state.traps.every((t: any) => t.armedTurn === 2 && t.setter === "treasury"));
  // a fourth with no balance left is refused without touching the others
  const again = await fetch(`${base}/runs/${runId}/plant-fiat-batch`, { method: "POST", headers: await seated(base, runId, guest), body: JSON.stringify({ items: [{ commitmentHex: "ab".repeat(32), stake: 1 }] }) }).then((r) => r.json());
  assert.equal(again.results[0].ok, false);
  assert.match(again.results[0].error, /insufficient/);
  await app.close();
});
