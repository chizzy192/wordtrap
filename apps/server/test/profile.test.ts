import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain, mockKey } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { validateName, shortAddress, isAddressLike } from "../src/profiles.ts";

const hdr = (user: string) => ({ "content-type": "application/json", "x-user": user });
async function boot() {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 1 }, spectateDelay: 0 });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

test("a display name is asked for once, saved against the address, and reused after a reload", async () => {
  const { app, base } = await boot();
  const guest = "guest-Ab12Cd34";
  const first = await fetch(`${base}/api/v1/profile`, { headers: hdr(guest) }).then((r) => r.json());
  assert.deepEqual(first, { address: guest, name: null, hasName: false });            // → the page shows the prompt
  const saved = await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: hdr(guest), body: JSON.stringify({ name: "  Red_Fox 4F2 " }) }).then((r) => r.json());
  assert.deepEqual(saved, { address: guest, name: "Red_Fox 4F2", hasName: true });
  const reload = await fetch(`${base}/api/v1/profile`, { headers: hdr(guest) }).then((r) => r.json());
  assert.equal(reload.hasName, true);                                                 // → no prompt the second time
  assert.equal(reload.name, "Red_Fox 4F2");
  await app.close();
});

test("two players with the same name stay distinct by address, and the feed maps names per address", async () => {
  const { app, base } = await boot();
  const a = "guest-AAAAAAAA", b = "guest-BBBBBBBB";
  for (const who of [a, b]) await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: hdr(who), body: JSON.stringify({ name: "Sam" }) });
  const { runId, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  for (const who of [a, b]) await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(who), body: JSON.stringify({ amount: 2 }) });
  await fetch(`${base}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr(a), body: JSON.stringify({ amount: 1 }) });
  await fetch(`${base}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr(b), body: JSON.stringify({ amount: 1 }) });
  const balA = await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr(a) }).then((r) => r.json());
  const balB = await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr(b) }).then((r) => r.json());
  assert.equal(balA.user, a); assert.equal(balB.user, b);
  assert.equal(balA.balanceMicro, 1_000_000); assert.equal(balB.balanceMicro, 1_000_000);
  const feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.deepEqual(feed.players, { [a]: "Sam", [b]: "Sam" });
  assert.equal(state.backerCount, 0);
  assert.equal(feed.state.backerCount, 2);
  await app.close();
});

test("planting works with the identity as the setter and no handle field; the mock key derives from the address", async () => {
  const { app, base } = await boot();
  const guest = "guest-Zz9Yy8Xx";
  const { runId, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
  const word = state.hand[0];
  const salt = new Uint8Array(32).fill(4);
  const c = toHex(commitment(word, salt, mockKey(guest)));                              // what the browser planter computes from the identity
  const t = await fetch(`${base}/runs/${runId}/plant`, { method: "POST", body: JSON.stringify({ commitmentHex: c, stake: 0.25, setter: guest }) }).then((r) => r.json());
  assert.equal(t.setter, guest);
  const feed = await fetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.deepEqual(feed.players, {});                                                     // no name yet → the page shows guest-Zz9…x8Xx
  assert.equal(shortAddress(guest), "gues…y8Xx");
  assert.equal(shortAddress("viewer1"), "viewer1");
  assert.ok(isAddressLike(guest));
  await app.close();
});

test("invalid names get a clear message", async () => {
  const { app, base } = await boot();
  for (const bad of ["", "a", "x".repeat(17), "no-dashes", "<b>hi</b>", "   "]) {
    const r = await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: hdr("guest-Q1W2E3R4"), body: JSON.stringify({ name: bad }) });
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).error, "Names are 2 to 16 characters: letters, numbers, spaces and underscores.");
  }
  assert.deepEqual(validateName("ok name_1"), { ok: true, name: "ok name_1" });
  assert.equal((await fetch(`${base}/api/v1/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sam" }) })).status, 400, "no identity");
  await app.close();
});
