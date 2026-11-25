import { test } from "node:test";
import assert from "node:assert/strict";
import { MockChain } from "../src/chain/mock.ts";
import { createApp, FRAME_CSP } from "../src/main.ts";
import { decide } from "../src/driver.ts";

const ROUTE: Record<string, string> = { play_word: "play", buy_hint: "hint", defuse_tile: "defuse", challenge_word: "challenge", pass_turn: "pass" };

test("Byte Arena contract over real HTTP: start → state → bad word 400 → play 200 → 401 → 409 → finish", async () => {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), cfg: { tiles: 1 } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, key?: string) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

  // start: the only unauthenticated game call
  const started = await post("/api/v1/runs", { callsign: "Byte" });
  assert.equal(started.status, 200);
  const { runId, apiKey, state } = await started.json();
  assert.ok(runId && /^[0-9a-f]{32}$/.test(apiKey));
  assert.equal(state.status, "live");
  assert.equal(state.turn, 1);
  assert.equal(state.callsign, "Byte");
  assert.ok(state.hand.length >= 8);
  const auth = { authorization: `Bearer ${apiKey}` };

  // state: GET, no side effects
  const s1 = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  const s2 = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.deepEqual(s1, s2);
  assert.deepEqual(s1, state);

  // invalid word: 400 with a legible error AND the full state
  const bad = await post(`/api/v1/runs/${runId}/play`, { word: "zzzz" }, apiKey);
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.match(badBody.error, /not in your hand/);
  assert.equal(badBody.state.turn, 1);
  assert.deepEqual(badBody.state.hand, state.hand);

  // valid word: 200 with the full state, turn advanced by exactly 1
  const word = state.hand[0];
  const ok = await post(`/api/v1/runs/${runId}/play`, { word, turn: 1 }, apiKey);
  assert.equal(ok.status, 200);
  const after = await ok.json();
  assert.equal(after.turn, 2);
  assert.equal(after.fuse, 175);
  assert.deepEqual(after.spoken, [{ word, turn: 1 }]);
  assert.ok(!after.hand.includes(word));

  // wrong / missing bearer
  assert.equal((await fetch(`${base}/api/v1/runs/${runId}/state`)).status, 401);
  assert.equal((await post(`/api/v1/runs/${runId}/pass`, {}, "deadbeef")).status, 401);

  // replaying the same turn: 409 with the state, nothing applied
  const stale = await post(`/api/v1/runs/${runId}/play`, { word: state.hand[1], turn: 1 }, apiKey);
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.match(staleBody.error, /stale turn: current turn is 2/);
  assert.equal(staleBody.state.turn, 2);

  // watch page: text/html + a real frame-ancestors CSP header, deep link per run
  const watch = await fetch(`${base}/watch/${runId}`);
  assert.equal(watch.status, 200);
  assert.match(watch.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(watch.headers.get("content-security-policy"), FRAME_CSP);
  assert.match(await watch.text(), /BYTE'S HAND/);

  // spec + current + spectate are public
  const spec = await fetch(`${base}/api/v1/spec`).then((r) => r.json());
  assert.equal(spec.api.actions.length, 5);
  assert.deepEqual(spec.api.finish, { path: "status", equals: ["escaped", "dead"] });
  assert.equal((await fetch(`${base}/api/v1/current`).then((r) => r.json())).runId, runId);
  const spec1 = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.ok(spec1.seq >= 1 && spec1.events.some((e: any) => e.type === "action"));
  assert.equal(spec1.state.turn, 2);
  const spec2 = await fetch(`${base}/runs/${runId}/spectate?after=${spec1.seq}`).then((r) => r.json());
  assert.deepEqual(spec2.events, []);

  // drive it to the end through the API, then the finished run must keep answering
  let cur = after;
  for (let i = 0; cur.status === "live" && i < 100; i++) {
    const mv = decide(cur);
    const r = await post(`/api/v1/runs/${runId}/${ROUTE[mv.action]}`, { word: mv.word, turn: cur.turn }, apiKey);
    assert.equal(r.status, 200);
    cur = await r.json();
  }
  assert.ok(cur.status === "escaped" || cur.status === "dead");
  const fin = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth });
  assert.equal(fin.status, 200);
  const finBody = await fin.json();
  assert.deepEqual(finBody, cur);
  assert.equal(finBody.score, finBody.position * 100 + Math.max(0, finBody.fuse));
  const again = await post(`/api/v1/runs/${runId}/pass`, {}, apiKey);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), cur);
  assert.equal((await fetch(`${base}/api/v1/current`).then((r) => r.json())).runId, null);
  assert.equal((await fetch(`${base}/api/v1/runs/nope/state`, { headers: auth })).status, 404);

  await app.close();
});

test("mock-mode planter: a browser viewer plants on a hand word and the reveal pays out", async () => {
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { runId, apiKey, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "b" }) }).then((r) => r.json());
  const { commitment, toHex } = await import("@wordtrap/shared");
  const { mockKey } = await import("../src/chain/mock.ts");
  const word = state.hand[0];
  const salt = new Uint8Array(32).fill(1);
  const planted = await fetch(`${base}/runs/${runId}/plant`, { method: "POST", body: JSON.stringify({ commitmentHex: toHex(commitment(word, salt, mockKey("you"))), stake: 0.5, setter: "you" }) }).then((r) => r.json());
  assert.equal(planted.armedTurn, 2);
  const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  const after = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word }) }).then((r) => r.json());
  assert.equal(after.turn, 3);
  const revealed = await fetch(`${base}/runs/${runId}/reveal`, { method: "POST", body: JSON.stringify({ trapId: planted.id, word, saltHex: toHex(salt), setter: "you" }) }).then((r) => r.json());
  assert.equal(revealed.payout, 1.5);
  const s = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.equal(s.fuse, 180 - 10 - 5 - 22);
  assert.equal(s.traps[0].status, "fired");
  await app.close();
});
