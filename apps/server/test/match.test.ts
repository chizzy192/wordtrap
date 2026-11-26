import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { commitment, toHex, type FeedEvent } from "@wordtrap/shared";
import { MockChain, mockKey } from "../src/chain/mock.ts";
import { Match, StaleTurnError, InvalidActionError } from "../src/match.ts";
import { decide } from "../src/driver.ts";
import { startCrowd } from "../src/crowd.ts";
import { SimWallet } from "../src/wallet.ts";
import { handleRisk, requirement, simVerifier } from "../src/oracle.ts";
import { TILE_DECK } from "../src/content.ts";

const salt = new Uint8Array(32).fill(9);
const plant = (c: MockChain, word: string, setter: string, stake = 1) =>
  c.plantTrap({ commitmentHex: toHex(commitment(word, salt, mockKey(setter))), stake, setter });
const reveal = (c: MockChain, id: string, word: string, setter: string) =>
  c.revealTrap({ trapId: id, word, saltHex: toHex(salt), setter });

/** A real x402 oracle on an ephemeral port, scoring whatever match is current. */
function oracle(current: () => Match): Promise<{ url: string; srv: Server }> {
  const srv = createServer(async (req, res) => {
    let b = ""; for await (const ch of req) b += ch;
    handleRisk(req, res, b, { verifier: simVerifier, requirement: requirement("r", "pay", "solana-devnet"), ctx: () => current().riskContext() });
  });
  return new Promise((r) => srv.listen(0, () => r({ url: `http://127.0.0.1:${(srv.address() as any).port}`, srv })));
}

function seededMatch(chain: MockChain, oracleUrl = "http://127.0.0.1:1/unreachable", seed = 42) {
  return new Match({ matchId: "m-test", callsign: "tester", chain, wallet: new SimWallet(), oracleUrl, deck: TILE_DECK, seed, cfg: { tiles: 3 } });
}

test("(a) a mine on a hand word detonates when played one turn later: -22-5 fuse, fired, paid", async () => {
  const chain = new MockChain();
  await chain.backByte("alice", 10);
  const m = seededMatch(chain);
  const feed: FeedEvent[] = [];
  m.on("feed", (e: FeedEvent) => feed.push(e));
  let s = await m.start();
  assert.equal(s.turn, 1);
  assert.ok(s.hand.length >= 8 && s.hand.length <= 10);

  const word = s.hand.find((w) => w !== s.safeCard)!;   // the safe card can never be mined
  const t = await plant(chain, word, "bob", 1);           // armed from turn 2
  assert.equal(t.armedTurn, 2);
  // Behaves like the setter's phone / the sim crowd: reveal synchronously once the word is played.
  m.afterWords.push(async (words) => { if (words.includes(word) && chain.turn >= t.armedTurn) await reveal(chain, t.id, word, "bob"); });

  s = await m.act("pass_turn");                           // turn 1 -> 2
  assert.equal(s.turn, 2);
  const before = s.fuse;
  s = await m.act("play_word", { word, turn: 2 });
  assert.equal(s.fuse, before - 5 - 22);
  assert.equal(s.traps.find((x) => x.id === t.id)?.status, "fired");
  assert.equal(s.traps.find((x) => x.id === t.id)?.word, word);
  const fired = feed.find((e) => e.type === "trap_fired") as Extract<FeedEvent, { type: "trap_fired" }>;
  assert.ok(fired, "trap_fired emitted inside act()");
  assert.equal(fired.payout, 3);                          // stake 1 + 2x bounty
  assert.equal(fired.fuseBurn, 22);
  assert.ok(!s.hand.includes(word), "played card leaves the hand");
  assert.deepEqual(s.tiles[0].played, [word]);
});

test("(b) a stale turn is rejected and changes nothing", async () => {
  const chain = new MockChain();
  const m = seededMatch(chain);
  await m.start();
  const before = m.snapshot();
  await assert.rejects(m.act("pass_turn", { turn: 99 }), (e: any) => e instanceof StaleTurnError && /current turn is 1/.test(e.message) && e.state.turn === 1);
  assert.deepEqual(m.snapshot(), before);
  assert.equal(chain.turn, 1);
});

test("a word outside the hand is a legible 400 and changes nothing", async () => {
  const chain = new MockChain();
  const m = seededMatch(chain);
  await m.start();
  const before = m.snapshot();
  await assert.rejects(m.act("play_word", { word: "zebra" }), (e: any) => e instanceof InvalidActionError && /not in your hand/.test(e.message) && e.state.hand.length === before.hand.length);
  await assert.rejects(m.act("teleport"), InvalidActionError);
  assert.deepEqual(m.snapshot(), before);
});

test("(c) challenge then play the same word: no detonation, mine stays dormant", async () => {
  const chain = new MockChain();
  await chain.backByte("alice", 10);
  const m = seededMatch(chain);
  let s = await m.start();
  const word = s.hand[1];
  const t = await plant(chain, word, "bob", 1);           // armed from turn 2
  m.afterWords.push(async (words) => { if (words.includes(word)) { try { await reveal(chain, t.id, word, "bob"); } catch { /* not triggered */ } } });

  s = await m.act("pass_turn");                           // turn 2 — mine is live now
  const before = s.fuse;
  s = await m.act("challenge_word", { word });            // typed, not played
  assert.equal(s.fuse, before - 8);
  assert.deepEqual(s.challenged.map((c) => c.word), [word]);
  s = await m.act("play_word", { word });                 // turn 3: safe now
  assert.equal(s.fuse, before - 8 - 5);
  assert.equal(s.traps.find((x) => x.id === t.id)?.status, "armed");
  await assert.rejects(reveal(chain, t.id, word, "bob"), /not triggered/);
});

test("(d) the local driver plays a full match to the end; a finished run is idempotent", async () => {
  let current!: Match;
  const { url, srv } = await oracle(() => current);
  const chain = new MockChain();
  const m = current = new Match({ matchId: "m-drive", callsign: "driver", chain, wallet: new SimWallet(), oracleUrl: url, seed: 7 });
  const seeded = (seed: number) => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
  startCrowd(m, chain, { rnd: seeded(3) });
  let s = await m.start();
  let calls = 0;
  while (s.status === "live" && calls++ < 400) {
    const mv = decide(s);
    s = await m.act(mv.action, { word: mv.word, turn: s.turn });
  }
  assert.ok(s.status === "escaped" || s.status === "dead", `ended: ${s.status}`);
  assert.ok(s.turn <= 60);
  assert.equal(s.score, s.position * 100 + Math.max(0, s.fuse));
  assert.ok(s.hintsBought >= 1, "driver bought at least one x402 hint");
  const final = m.snapshot();
  assert.deepEqual(await m.act("pass_turn"), final);
  assert.deepEqual(await m.act("play_word", { word: "anything" }), final);
  assert.equal(chain.status, "ended");
  srv.close();
});

test("(e) reading state has zero side effects", async () => {
  const chain = new MockChain();
  const m = seededMatch(chain);
  await m.start();
  const a = m.snapshot();
  const b = m.snapshot();
  assert.deepEqual(a, b);
  a.hand.length = 0; a.fuse = 0; a.turn = 99;             // callers can't reach inside
  assert.deepEqual(m.snapshot(), b);
  assert.equal(chain.turn, 1);
});

test("stacked mines on one word fire in one wave and emit multi_boom", async () => {
  const chain = new MockChain();
  await chain.backByte("alice", 10);
  const m = seededMatch(chain);
  const feed: FeedEvent[] = [];
  m.on("feed", (e: FeedEvent) => feed.push(e));
  let s = await m.start();
  const word = s.hand.find((w) => w !== s.safeCard)!;
  const t1 = await plant(chain, word, "bob", 1);
  const t2 = await plant(chain, word, "carol", 0.5);
  m.afterWords.push(async (words) => {
    if (!words.includes(word) || chain.turn < t1.armedTurn) return;
    await reveal(chain, t1.id, word, "bob");
    await reveal(chain, t2.id, word, "carol");
  });
  s = await m.act("pass_turn");
  const before = s.fuse;
  s = await m.act("play_word", { word });
  assert.equal(s.fuse, before - 5 - 22, "one fuse penalty per played word, however many mines fire");
  const multi = feed.find((e) => e.type === "multi_boom") as Extract<FeedEvent, { type: "multi_boom" }>;
  assert.ok(multi, "multi_boom emitted");
  assert.equal(multi.count, 2);
  assert.equal(multi.fuseBurn, 22);
  assert.equal(multi.payout, 3 + 1.5);
  assert.deepEqual(multi.setters.sort(), ["bob", "carol"]);
  assert.equal(feed.filter((e) => e.type === "trap_fired").length, 2);
  const detail = (feed.filter((e) => e.type === "action").at(-1) as any).detail;
  assert.match(detail, /MULTI-BOOM, 2 mines/);
});

test("buy_hint stores oracle scores into state.hint and survives an oracle outage", async () => {
  let current!: Match;
  const { url, srv } = await oracle(() => current);
  const chain = new MockChain();
  const ok = current = seededMatch(chain, url);
  let s = await ok.start();
  s = await ok.act("buy_hint");
  assert.equal(s.fuse, 180 - 3);
  assert.equal(s.hintsBought, 1);
  assert.equal(s.hintSpendUsd, 0.001);
  assert.deepEqual(Object.keys(s.hint!).sort(), [...s.hand].sort());
  for (const v of Object.values(s.hint!)) assert.ok(v >= 0 && v <= 1);
  srv.close();

  const down = seededMatch(new MockChain(), "http://127.0.0.1:1/down");
  s = await down.start();
  s = await down.act("buy_hint");
  assert.equal(s.fuse, 180 - 3);
  assert.deepEqual(s.hint, {});
  assert.equal(s.status, "live");
});
