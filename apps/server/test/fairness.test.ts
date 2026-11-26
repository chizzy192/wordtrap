// Fairness rules: items 11–15 of the "rooms and rules" audit. Real runs, no fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain, mockKey } from "../src/chain/mock.ts";
import { Match } from "../src/match.ts";
import { SimWallet } from "../src/wallet.ts";
import { startCrowd } from "../src/crowd.ts";
import { TILE_DECK } from "../src/content.ts";
import { createApp } from "../src/main.ts";

const salt = new Uint8Array(32).fill(8);
const plant = (c: MockChain, word: string, setter: string, stake = 1) => c.plantTrap({ commitmentHex: toHex(commitment(word, salt, mockKey(setter))), stake, setter });
const reveal = (c: MockChain, id: string, word: string, setter: string) => c.revealTrap({ trapId: id, word, saltHex: toHex(salt), setter });
function newMatch(chain: MockChain) { return new Match({ matchId: "fair", chain, wallet: new SimWallet(), oracleUrl: "http://127.0.0.1:1/x", deck: TILE_DECK, seed: 11, cfg: { tiles: 3 } }); }

test("11: exactly one safe card per hand; playing it is not recorded as spoken, still counts, and a challenge on it is refused", async () => {
  const chain = new MockChain(); await chain.backByte("alice", 10);
  const m = newMatch(chain);
  let s = await m.start();
  assert.ok(s.safeCard && s.hand.includes(s.safeCard));
  assert.equal(s.hand.filter((w) => w === s.safeCard).length, 1);
  assert.equal(s.safe, s.safeCard, "older alias kept");
  // a mine on the safe card never fires: the word is never written on-chain
  const t = await plant(chain, s.safeCard!, "bob");
  m.afterWords.push(async (words) => { if (words.includes(s.safeCard!)) await reveal(chain, t.id, s.safeCard!, "bob"); });
  s = await m.act("pass_turn");
  await assert.rejects(m.act("challenge_word", { word: s.safeCard! }), /safe card/);
  const before = s.fuse;
  s = await m.act("play_word", { word: s.safeCard! });
  assert.equal(s.fuse, before - 5, "no detonation");
  assert.equal(s.tiles[0].played.length, 1, "it counts toward the tile");
  assert.ok(!s.spoken.some((x) => x.word === s.safeCard), "not recorded as spoken");
  assert.equal(chain.words.has(s.safeCard!), false, "nothing on-chain");
  assert.equal(s.traps[0].status, "armed");
  // every later hand also has exactly one safe card
  for (const h of [s.nextHand, s.laterHand]) { assert.ok(h && h.safe && h.hand.includes(h.safe)); }
  assert.equal(s.nextSafeCard, s.nextHand!.safe);
  assert.equal(s.nextPrompt, s.nextHand!.prompt);
});

test("12: one fuse penalty per played word however many mines fire on it; every setter is still paid", async () => {
  const chain = new MockChain(); await chain.backByte("alice", 20);
  const m = newMatch(chain);
  let s = await m.start();
  const word = s.hand.find((w) => w !== s.safeCard)!;
  const traps = await Promise.all(["bob", "carol", "dave"].map((who) => plant(chain, word, who, 1)));
  m.afterWords.push(async (words) => { if (words.includes(word)) for (const [i, who] of ["bob", "carol", "dave"].entries()) await reveal(chain, traps[i].id, word, who); });
  s = await m.act("pass_turn");
  const before = s.fuse;
  s = await m.act("play_word", { word });
  assert.equal(s.fuse, before - 5 - 22, "22 once, not 66");
  assert.equal(s.traps.filter((t) => t.status === "fired").length, 3, "all three setters paid");
  assert.equal(s.bonusesPaid, 6);
});

test("13: at most two detonations per tile, then the tile is shielded until it is cleared", async () => {
  const chain = new MockChain(); await chain.backByte("alice", 20);
  const m = newMatch(chain);
  let s = await m.start();
  const [w1, w2, w3] = s.hand.filter((w) => w !== s.safeCard);
  const ids: Record<string, string> = {};
  for (const [w, who] of [[w1, "bob"], [w2, "carol"], [w3, "dave"]] as const) ids[w] = (await plant(chain, w, who)).id;
  m.afterWords.push(async (words) => {
    if (m.isShielded()) return;                                  // what every revealer (server route, bot) must do
    for (const [w, who] of [[w1, "bob"], [w2, "carol"], [w3, "dave"]] as const) if (words.includes(w)) await reveal(chain, ids[w], w, who);
  });
  s = await m.act("pass_turn");
  s = await m.act("play_word", { word: w1 }); assert.equal(s.shielded, false);
  s = await m.act("play_word", { word: w2 }); assert.equal(s.shielded, true, "two detonations shield the tile");
  const fuse = s.fuse;
  s = await m.act("play_word", { word: w3 });                     // clears the tile (needed 3) but no third detonation
  assert.equal(s.fuse, fuse - 5, "the third mine did not fire");
  assert.equal(s.traps.find((t) => t.id === ids[w3])!.status, "armed");
  assert.equal(s.position, 1);
  assert.equal(s.shielded, false, "a cleared tile lifts the shield");
});

test("13b: over HTTP, a reveal on a shielded tile is refused with 409 and the mine stays armed", async () => {
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 20); return c; }, ledgerPath: null, cfg: { tiles: 2 }, spectateDelay: 0 });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const { runId, apiKey, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  const chain = app.runs.get(runId)!.chain as MockChain;
  const [w1, w2] = state.hand.filter((w: string) => w !== state.safeCard);
  // two mines on w1 (two setters) and one on w2: the third reveal lands on an already-shielded tile
  const a = await plant(chain, w1, "v0"), b = await plant(chain, w2, "v1"), c = await plant(chain, w1, "v2");
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  const rev = (t: any, w: string, who: string) => fetch(`${base}/runs/${runId}/reveal`, { method: "POST", body: JSON.stringify({ trapId: t.id, word: w, saltHex: toHex(salt), setter: who }) });
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: w1 }) });
  assert.equal((await rev(a, w1, "v0")).status, 200, "detonation 1");
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: w2 }) });
  assert.equal((await rev(b, w2, "v1")).status, 200, "detonation 2");
  const s = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.equal(s.shielded, true);
  const third = await rev(c, w1, "v2");
  assert.equal(third.status, 409); assert.match((await third.json()).error, /shielded/);
  assert.equal((await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json())).traps.find((t: any) => t.id === c.id).status, "armed");
  await app.close();
});

test("14: nextHand, nextSafeCard and nextPrompt are sent, nextHand becomes hand when the tile clears, and Byte cannot play from it", async () => {
  const chain = new MockChain();
  const m = newMatch(chain);
  let s = await m.start();
  assert.ok(s.nextHand && s.nextPrompt && s.nextSafeCard);
  assert.equal(s.nextPrompt, s.tiles[1].prompt);
  const fromNext = s.nextHand!.hand.find((w) => !s.hand.includes(w))!;
  await assert.rejects(m.act("play_word", { word: fromNext }), /not in your hand/);
  const planned = s.nextHand!;
  while (s.position === 0) s = await m.act("play_word", { word: s.hand[0] });
  assert.deepEqual(s.hand, planned.hand);
  assert.equal(s.safeCard, planned.safe);
});

test("15: bots never mine a safe card and split their plants between hand and nextHand", async () => {
  const chain = new MockChain();
  const m = newMatch(chain);
  let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const crowd = startCrowd(m, chain, { aggression: 1, rnd, setterCount: () => 4 });
  let s = await m.start();
  const hand = new Set(s.hand), next = new Set(s.nextHand!.hand), later = new Set(s.laterHand!.hand);
  const safeCards = new Set([s.safeCard, s.nextHand!.safe, s.laterHand!.safe]);
  for (let i = 0; i < 8 && s.status === "live" && s.position === 0; i++) s = await m.act("pass_turn");
  const mined = crowd.mined();
  assert.ok(mined.length >= 20, `bots planted (${mined.length})`);
  for (const w of mined) assert.ok(!safeCards.has(w), `bots must never mine a safe card: ${w}`);
  const onHand = mined.filter((w) => hand.has(w)).length;
  const ahead = mined.filter((w) => next.has(w) || later.has(w)).length;
  assert.ok(onHand > 0 && ahead > 0, `plants split between hand (${onHand}) and the coming hands (${ahead})`);
  assert.ok(ahead / mined.length >= 0.2 && ahead / mined.length <= 0.6, `about a third ahead, got ${(ahead / mined.length).toFixed(2)}`);
});
