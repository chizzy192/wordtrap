import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain, mockKey } from "../src/chain/mock.ts";
import { handleRisk, requirement, simVerifier, buyRisk } from "../src/oracle.ts";
import { SimWallet } from "../src/wallet.ts";
import { TILE_DECK } from "../src/content.ts";

const salt = new Uint8Array(32).fill(9);
const plant = (c: MockChain, word: string, setter: string, stake = 1) =>
  c.plantTrap({ commitmentHex: toHex(commitment(word, salt, mockKey(setter))), stake, setter });
const reveal = (c: MockChain, id: string, word: string, setter: string) =>
  c.revealTrap({ trapId: id, word, saltHex: toHex(salt), setter });

test("trap fires only when spoken after arming, pays stake + 2x bounty", async () => {
  const c = new MockChain();
  await c.backByte("alice", 10);
  await c.startMatch();                          // turn 1
  const t = await plant(c, "banana", "bob");     // armed turn 2
  await c.recordWords(["banana"], "spoken");     // said on turn 1 — too early
  await assert.rejects(reveal(c, t.id, "banana", "bob"), /not triggered/);
  await c.advanceTurn();
  await c.recordWords(["banana"], "spoken");
  const e = await reveal(c, t.id, "banana", "bob");
  assert.equal(e.payout, 3);
});

test("wrong salt / wrong setter cannot claim", async () => {
  const c = new MockChain();
  await c.startMatch();
  const t = await plant(c, "kiwi", "bob");
  await c.advanceTurn();
  await c.recordWords(["kiwi"], "spoken");
  await assert.rejects(c.revealTrap({ trapId: t.id, word: "kiwi", saltHex: toHex(new Uint8Array(32)), setter: "bob" }), /bad reveal/);
  await assert.rejects(reveal(c, t.id, "kiwi", "eve"), /not your trap/);
});

test("challenge defuses, backers sweep unfired stakes pro-rata", async () => {
  const c = new MockChain();
  await c.backByte("alice", 3); await c.backByte("carol", 1);
  await c.startMatch();
  const t = await plant(c, "mango", "bob", 2);
  await c.advanceTurn();
  await c.recordWords(["mango"], "challenged");
  await c.advanceTurn();
  await c.recordWords(["mango"], "spoken");
  await assert.rejects(reveal(c, t.id, "mango", "bob"), /not triggered/);
  const pay = c.finalize();
  assert.equal(pay.get("alice"), 4.5);
  assert.equal(pay.get("carol"), 1.5);
});

test("oracle is x402-gated and Byte's wallet pays", async () => {
  const srv = createServer(async (req, res) => {
    let b = ""; for await (const ch of req) b += ch;
    handleRisk(req, res, b, { verifier: simVerifier, requirement: requirement("r", "pay", "solana-devnet"),
      ctx: () => ({ tile: TILE_DECK[0], firedWords: new Set(), armedStakeThisWindow: 0, armedCountThisWindow: 0 }) });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  const unpaid = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(unpaid.status, 402);
  assert.equal((await unpaid.json()).accepts[0].maxAmountRequired, "1000");
  const w = new SimWallet();
  const { scores } = await buyRisk(url, ["apple", "quince"], w);
  assert.ok(scores.apple > scores.quince);
  assert.equal(w.spentUsd(), 0.001);
  srv.close();
});
