import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitment, toHex, proRata } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp, type App } from "../src/main.ts";
import { FiatLedger, MockPollar, MICRO } from "../src/fiat.ts";

const salt = new Uint8Array(32).fill(5);
/** POST helper. Planting needs a seat, so for plant-fiat the caller is seated first and the seat token sent. */
const post = async (base: string, path: string, body: unknown) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const user = (body as any)?.user;
  if (/plant-fiat/.test(path) && user) {
    const seat = await fetch(base + path.replace(/plant-fiat(-batch)?$/, "seat"), { method: "POST", headers: { ...headers, "x-user": user }, body: JSON.stringify({ action: "take" }) }).then((r) => r.json());
    if (seat.token) headers["x-seat-token"] = seat.token;
  }
  return fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
};

async function boot(o: Parameters<typeof createApp>[0] = {}): Promise<{ app: App; base: string }> {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, ...o });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}
async function startRun(base: string) {
  const r = await post(base, "/api/v1/runs", { callsign: "fiat-test" }).then((x) => x.json());
  return { runId: r.runId as string, auth: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` }, state: r.state };
}
/** The browser's job (I1): commitment with the TREASURY pubkey, salt kept client-side. */
async function treasuryCommitment(base: string, word: string) {
  const t = await fetch(`${base}/api/v1/treasury`).then((r) => r.json());
  assert.equal(t.mode, "demo-credits");
  return toHex(commitment(word, salt, Uint8Array.from(Buffer.from(t.pubkeyHex, "hex"))));
}

test("plant-fiat → Byte plays the word → reveal-fiat credits the owner stake + bounty", async () => {
  const { app, base } = await boot();
  const { runId, auth, state } = await startRun(base);
  assert.equal(state.treasury, (await fetch(`${base}/api/v1/treasury`).then((r) => r.json())).pubkeyHex);

  const dev = await post(base, "/dev/credit", { user: "alice", amount: 5 }).then((r) => r.json());
  assert.equal(dev.balanceMicro, 5 * MICRO);
  // somebody backs Byte so there is a bounty budget
  await post(base, "/dev/credit", { user: "bob", amount: 10 });
  const back = await post(base, `/runs/${runId}/back-fiat`, { user: "bob", amount: 10 }).then((r) => r.json());
  assert.equal(back.balanceMicro, 0);
  assert.equal(back.backerTotal, 10);

  const word = state.hand.find((w: string) => w !== state.safe)!;
  const c = await treasuryCommitment(base, word);
  const planted = await post(base, `/runs/${runId}/plant-fiat`, { user: "alice", commitmentHex: c, stake: 1 }).then((r) => r.json());
  assert.equal(planted.balanceMicro, 4 * MICRO);
  assert.equal(planted.trap.setter, "treasury");
  assert.equal(planted.trap.armedTurn, 2);
  const balance = await fetch(`${base}/api/v1/fiat/balance?user=alice`).then((r) => r.json());
  assert.equal(balance.traps[0].trapId, planted.trap.id);
  assert.equal(balance.traps[0].status, "armed");

  // Byte passes, then plays the mined card
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  const played = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word }) }).then((r) => r.json());
  assert.ok(played.spoken.some((s: any) => s.word === word && s.turn >= 2));

  // too-early reveal is impossible here; the real reveal: browser sends word + salt, server signs as treasury
  const revealed = await post(base, `/runs/${runId}/reveal-fiat`, { user: "alice", trapId: planted.trap.id, word, saltHex: toHex(salt) }).then((r) => r.json());
  assert.equal(revealed.status, "paid");
  assert.equal(revealed.payoutMicro, 3 * MICRO);                 // stake 1 + 2x bounty
  assert.equal(revealed.balanceMicro, 7 * MICRO);
  assert.equal(revealed.fired.trap.status, "fired");
  // Byte saw the detonation on its side too
  const s = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.equal(s.traps.find((t: any) => t.id === planted.trap.id).status, "fired");
  // idempotent: a second reveal call changes nothing
  const again = await post(base, `/runs/${runId}/reveal-fiat`, { user: "alice", trapId: planted.trap.id, word, saltHex: toHex(salt) }).then((r) => r.json());
  assert.equal(again.balanceMicro, 7 * MICRO);
  await app.close();
});

test("reveal-fiat with a wrong salt: legible 400, no credit, trap stays armed; wrong user: 403", async () => {
  const { app, base } = await boot();
  const { runId, auth, state } = await startRun(base);
  await post(base, "/dev/credit", { user: "alice", amount: 2 });
  const word = state.hand.find((w: string) => w !== state.safe)!;
  const planted = await post(base, `/runs/${runId}/plant-fiat`, { user: "alice", commitmentHex: await treasuryCommitment(base, word), stake: 1 }).then((r) => r.json());
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word }) });

  const bad = await post(base, `/runs/${runId}/reveal-fiat`, { user: "alice", trapId: planted.trap.id, word, saltHex: toHex(new Uint8Array(32).fill(6)) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /does not match this mine's commitment/);
  const eve = await post(base, `/runs/${runId}/reveal-fiat`, { user: "eve", trapId: planted.trap.id, word, saltHex: toHex(salt) });
  assert.equal(eve.status, 403);
  const balance = await fetch(`${base}/api/v1/fiat/balance?user=alice`).then((r) => r.json());
  assert.equal(balance.balanceMicro, 1 * MICRO);
  assert.equal(balance.traps[0].status, "armed");
  assert.equal(app.runs.get(runId)!.chain.snapshot().traps[0].status, "armed");
  await app.close();
});

test("duplicate payment confirmation (same paymentId twice) credits exactly once", async () => {
  const { app, base } = await boot();
  const a = await post(base, "/dev/credit", { user: "carol", amount: 3, paymentId: "pay_123" }).then((r) => r.json());
  assert.equal(a.credited, true);
  const b = await post(base, "/dev/credit", { user: "carol", amount: 3, paymentId: "pay_123" }).then((r) => r.json());
  assert.equal(b.credited, false);
  assert.equal(b.duplicate, true);
  const c = await post(base, "/api/v1/fiat/confirm", { user: "carol", paymentId: "pay_123" }).then((r) => r.json());
  assert.equal(c.duplicate, true);
  assert.equal(c.balanceMicro, 3 * MICRO);
  // an unknown / pending payment is never credited, only recorded for retry
  const pending = await post(base, "/api/v1/fiat/confirm", { user: "carol", paymentId: "pay_unknown" });
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).balanceMicro, 3 * MICRO);
  assert.deepEqual(app.ledger.pendingPayments(), [{ id: "pay_unknown", user: "carol", micro: 0 }]);
  // the gateway later says paid → the retry path credits it once
  (app.pollar as MockPollar).register("pay_unknown", "carol", 2 * MICRO);
  const later = await post(base, "/api/v1/fiat/confirm", { user: "carol", paymentId: "pay_unknown" }).then((r) => r.json());
  assert.equal(later.credited, true);
  assert.equal(later.balanceMicro, 5 * MICRO);
  // a payment that belongs to someone else is refused
  (app.pollar as MockPollar).register("pay_dave", "dave", 1 * MICRO);
  assert.equal((await post(base, "/api/v1/fiat/confirm", { user: "carol", paymentId: "pay_dave" })).status, 403);
  await app.close();
});

test("restart: the ledger is rebuilt from data/fiat-ledger.json with balances and trap ownership intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-ledger-"));
  const path = join(dir, "data", "fiat-ledger.json");
  const first = await boot({ ledgerPath: path });
  const { runId, state } = await startRun(first.base);
  await post(first.base, "/dev/credit", { user: "alice", amount: 4, paymentId: "pay_r1" });
  const word = state.hand.filter((w: string) => w !== state.safe)[1];
  const planted = await post(first.base, `/runs/${runId}/plant-fiat`, { user: "alice", commitmentHex: await treasuryCommitment(first.base, word), stake: 1.5 }).then((r) => r.json());
  await first.app.close();
  assert.ok(existsSync(path));
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.balances.alice, 2_500_000);
  assert.equal(onDisk.traps[planted.trap.id].user, "alice");
  assert.ok(!readFileSync(path, "utf8").includes(".tmp"));

  const again = new FiatLedger(path);
  assert.equal(again.balance("alice"), 2_500_000);
  assert.equal(again.trapOwner(planted.trap.id)?.status, "armed");
  assert.equal(again.payment("pay_r1")?.status, "credited");
  assert.equal(again.creditFromPayment("pay_r1", "alice", 4 * MICRO).duplicate, true);

  // the restarted server has no run to settle that mine, so its stake comes back on startup (kind refund, once)
  const second = await boot({ ledgerPath: path });
  const balance = await fetch(`${second.base}/api/v1/fiat/balance?user=alice`).then((r) => r.json());
  assert.equal(balance.balanceMicro, 4_000_000);
  assert.ok(balance.history.some((h: any) => h.reason === "refund" && h.delta === 1_500_000 && h.ref === `refund:${runId}:plant:${planted.trap.commitmentHex?.slice(0, 16) ?? ""}`.replace(/:$/, "")) || balance.history.some((h: any) => h.reason === "refund" && h.delta === 1_500_000), "refund row");
  assert.deepEqual((await second.app.startup()).refunds, [], "refunded once");
  assert.equal(balance.traps[0].trapId, planted.trap.id);
  await second.app.close();
});

test("pick a side: backing works before the cut-off and is refused once Byte clears the first tile", async () => {
  const { app, base } = await boot({ cfg: { tiles: 2 } });
  const { runId, auth, state } = await startRun(base);
  assert.equal(state.backingOpen, true);
  await post(base, "/dev/credit", { user: "alice", amount: 10 });
  const ok = await post(base, `/runs/${runId}/back-fiat`, { user: "alice", amount: 3 });
  assert.equal(ok.status, 200);
  // clear the first tile
  const done = await fetch(`${base}/api/v1/runs/${runId}/defuse`, { method: "POST", headers: auth, body: "{}" }).then((r) => r.json());
  assert.equal(done.position, 1);
  assert.equal(done.backingOpen, false);
  const late = await post(base, `/runs/${runId}/back-fiat`, { user: "alice", amount: 1 });
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, "Backing closed when Byte cleared the first tile.");
  const bal = await fetch(`${base}/api/v1/fiat/balance?user=alice`).then((r) => r.json());
  assert.equal(bal.balanceMicro, 7 * MICRO, "the refused call did not debit");
  await app.close();
});

test("pick a side: backing also closes at turn 6 when the first tile is still open", async () => {
  const { app, base } = await boot({ cfg: { tiles: 2 } });
  const { runId, auth } = await startRun(base);
  for (let i = 0; i < 5; i++) await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  const s = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.equal(s.turn, 6); assert.equal(s.position, 0); assert.equal(s.backingOpen, false);
  await post(base, "/dev/credit", { user: "bob", amount: 2 });
  const late = await post(base, `/runs/${runId}/back-fiat`, { user: "bob", amount: 1 });
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, "Backing closed at turn 6.");
  await app.close();
});

test("pick a side: my-position matches proRata for two backers after one mine fired, and settlement pays what the page showed", async () => {
  const { app, base } = await boot({ cfg: { tiles: 1 } });
  const { runId, auth, state } = await startRun(base);
  await post(base, "/dev/credit", { user: "alice", amount: 6 });
  await post(base, "/dev/credit", { user: "bob", amount: 2 });
  await post(base, "/dev/credit", { user: "carol", amount: 5 });
  await post(base, `/runs/${runId}/back-fiat`, { user: "alice", amount: 6 });
  await post(base, `/runs/${runId}/back-fiat`, { user: "bob", amount: 2 });
  // carol mines a hand word for $1 and Byte plays it: she gets stake + 2x bonus = $3, the pool paid $2
  const word = state.hand.find((w: string) => w !== state.safe)!;
  const planted = await post(base, `/runs/${runId}/plant-fiat`, { user: "carol", commitmentHex: await treasuryCommitment(base, word), stake: 1 }).then((r) => r.json());
  await fetch(`${base}/api/v1/runs/${runId}/pass`, { method: "POST", headers: auth, body: "{}" });
  await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word }) });
  const revealed = await post(base, `/runs/${runId}/reveal-fiat`, { user: "carol", trapId: planted.trap.id, word, saltHex: toHex(salt) }).then((r) => r.json());
  assert.equal(revealed.payoutMicro, 3 * MICRO);
  const live = await fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  assert.equal(live.backerCount, 2);
  assert.equal(live.bonusesPaid, 2);
  assert.equal(live.unfiredStake, 0);
  assert.equal(live.poolNow, 6);                                      // 8 backed - 2 bonus; no unfired stake while live

  const alice = await fetch(`${base}/runs/${runId}/my-position?user=alice`).then((r) => r.json());
  const bob = await fetch(`${base}/runs/${runId}/my-position?user=bob`).then((r) => r.json());
  assert.equal(alice.sharePct, 75); assert.equal(bob.sharePct, 25);
  assert.equal(alice.payoutNowMicro, Number(proRata(6_000_000n, 6_000_000n, 8_000_000n)));
  assert.equal(bob.payoutNowMicro, Number(proRata(6_000_000n, 2_000_000n, 8_000_000n)));
  assert.equal(alice.payoutNowUsd, 4.5); assert.equal(bob.payoutNowUsd, 1.5);

  // a second mine that never fires: its stake joins the pool once the run is over
  await post(base, "/dev/credit", { user: "dave", amount: 1 });
  await post(base, `/runs/${runId}/plant-fiat`, { user: "dave", commitmentHex: await treasuryCommitment(base, "zzzq"), stake: 1 });
  // finish the run (defuse the only tile)
  const end = await fetch(`${base}/api/v1/runs/${runId}/defuse`, { method: "POST", headers: auth, body: "{}" }).then((r) => r.json());
  assert.ok(end.status !== "live");
  assert.equal(end.unfiredStake, 1);
  assert.equal(end.poolNow, 7);
  const shown = await fetch(`${base}/runs/${runId}/my-position?user=alice`).then((r) => r.json());
  assert.equal(shown.payoutNowMicro, Number(proRata(7_000_000n, 6_000_000n, 8_000_000n)));
  const before = (await fetch(`${base}/api/v1/fiat/balance?user=alice`).then((r) => r.json())).balanceMicro;
  const settled = await post(base, `/runs/${runId}/settle`, {}).then((r) => r.json());
  const after = (await fetch(`${base}/api/v1/fiat/balance?user=alice`).then((r) => r.json())).balanceMicro;
  assert.ok(Math.abs(after - before - shown.payoutNowMicro) <= 1, `credited ${after - before}, page showed ${shown.payoutNowMicro}`);
  assert.ok(Math.abs(settled.paid.alice - shown.payoutNowMicro) <= 1);
  await app.close();
});

test("/dev/credit on a non-mock chain is refused with 403", async () => {
  const { app, base } = await boot({ chainKind: "solana" });
  const r = await post(base, "/dev/credit", { user: "alice", amount: 1 });
  assert.equal(r.status, 403);
  await app.close();
});

test("back-fiat + settle: fiat backers are credited pro-rata, matching the on-chain math", async () => {
  const { app, base } = await boot({ cfg: { tiles: 1 } });
  const { runId, auth, state } = await startRun(base);
  await post(base, "/dev/credit", { user: "alice", amount: 3 });
  await post(base, "/dev/credit", { user: "bob", amount: 1 });
  await post(base, `/runs/${runId}/back-fiat`, { user: "alice", amount: 3 });
  await post(base, `/runs/${runId}/back-fiat`, { user: "bob", amount: 1 });
  const chain = app.runs.get(runId)!.chain as MockChain;
  await chain.backByte("whale", 4);                                  // a non-fiat backer shares the vault too
  // a crowd-less run: plant one mine that never fires, so its stake ends up with the backers
  await chain.plantTrap({ commitmentHex: toHex(commitment("zzz", salt, new Uint8Array(32).fill(1))), stake: 2, setter: "someone" });
  // settle is refused while live
  assert.equal((await post(base, `/runs/${runId}/settle`, {})).status, 409);
  // finish the run quickly: defuse the only tile
  const done = await fetch(`${base}/api/v1/runs/${runId}/defuse`, { method: "POST", headers: auth, body: "{}" }).then((r) => r.json());
  assert.equal(done.status, "escaped");

  const treasuryDeposit = chain.backers.get("treasury")!;
  assert.equal(treasuryDeposit, 4_000_000n);
  const expectTreasury = proRata(chain.vault, treasuryDeposit, chain.backerTotal);    // vault = 8 + 2 stake = 10 → 5
  const settled = await post(base, `/runs/${runId}/settle`, {}).then((r) => r.json());
  assert.equal(settled.treasuryPayoutMicro, Number(expectTreasury));
  assert.equal(settled.paid.alice, Number(proRata(expectTreasury, 3_000_000n, 4_000_000n)));
  assert.equal(settled.paid.bob, Number(proRata(expectTreasury, 1_000_000n, 4_000_000n)));
  assert.equal(settled.paid.alice + settled.paid.bob, Number(expectTreasury));
  assert.equal(app.ledger.balance("alice"), settled.paid.alice);
  // idempotent
  const twice = await post(base, `/runs/${runId}/settle`, {}).then((r) => r.json());
  assert.equal(twice.duplicate, true);
  assert.equal(app.ledger.balance("alice"), settled.paid.alice);
  await app.close();
});
