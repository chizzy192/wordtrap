// One side per run (server-enforced): a backer never takes a seat in that run, a seated player never backs it, quick
// play never seats a backer in a room they backed, and my-position says which side the viewer is on. Anyone watches
// without signing in. Names: a signed-in player's display name is the one they set, else the Google name Pollar's
// profile carries, so no page ever has to ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MockChain } from "../src/chain/mock.ts";
import { createApp, BACKER_NO_SEAT, SEATED_NO_BACK, nameFromProfile } from "../src/main.ts";
import { PollarServerApi } from "../src/fiat.ts";

const hdr = (user: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-user": user, ...extra });
async function boot(opts: Record<string, unknown> = {}) {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, spectateDelay: 0, bots: false, ...opts });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const startRun = async (callsign = "Oly") => fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign }) }).then((r) => r.json());
  const credit = (user: string, amount = 10) => fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(user), body: JSON.stringify({ amount }) });
  const seat = (runId: string, user: string, action = "take") => fetch(`${base}/runs/${runId}/seat`, { method: "POST", headers: hdr(user), body: JSON.stringify({ action }) });
  const back = (runId: string, user: string, amount = 1) => fetch(`${base}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr(user), body: JSON.stringify({ amount }) });
  const position = (runId: string, user: string) => fetch(`${base}/runs/${runId}/my-position`, { headers: hdr(user) }).then((r) => r.json());
  return { app, base, startRun, credit, seat, back, position };
}

test("one side per run: a seated player cannot back, a backer cannot take a seat, each with a plain sentence; leaving the seat opens backing again", async () => {
  const t = await boot();
  try {
    const { runId } = await t.startRun();
    await t.credit("guest-SETTER01"); await t.credit("guest-BACKER01");
    assert.equal((await t.seat(runId, "guest-SETTER01")).status, 200);
    const noBack = await t.back(runId, "guest-SETTER01");
    assert.equal(noBack.status, 409); assert.equal((await noBack.json()).error, SEATED_NO_BACK);
    assert.equal((await t.back(runId, "guest-BACKER01")).status, 200);
    const noSeat = await t.seat(runId, "guest-BACKER01");
    assert.equal(noSeat.status, 409); assert.equal((await noSeat.json()).error, BACKER_NO_SEAT);
    // my-position tells the pages which side the viewer is on and why the other is closed
    const setter = await t.position(runId, "guest-SETTER01"); assert.equal(setter.side, "setter"); assert.equal(setter.seated, true); assert.equal(setter.cannotBack, SEATED_NO_BACK); assert.equal(setter.cannotSeat, null);
    const backer = await t.position(runId, "guest-BACKER01"); assert.equal(backer.side, "backer"); assert.equal(backer.stakeMicro, 1_000_000); assert.equal(backer.cannotSeat, BACKER_NO_SEAT); assert.equal(backer.cannotBack, null);
    const nobody = await t.position(runId, "guest-WATCHER1"); assert.equal(nobody.side, "none"); assert.equal(nobody.cannotSeat, null);
    // no identity at all (the embed): 200 with a neutral position, never a 401
    const anon = await fetch(`${t.base}/runs/${runId}/my-position`); assert.equal(anon.status, 200);
    const a = await anon.json(); assert.equal(a.side, "none"); assert.equal(a.seated, false); assert.equal(a.stakeMicro, 0); assert.equal(a.canWatch, true); assert.equal(a.user, null); assert.equal(typeof a.maySeat, "boolean"); assert.equal(nobody.cannotBack, null);
    // a backer stays a backer: a second back is fine; leaving a seat makes backing possible again for the setter
    assert.equal((await t.back(runId, "guest-BACKER01")).status, 200);
    await t.seat(runId, "guest-SETTER01", "leave");
    assert.equal((await t.back(runId, "guest-SETTER01")).status, 200);
    assert.equal((await t.seat(runId, "guest-SETTER01")).status, 409, "and now they are a backer, so no seat");
    // the money is untouched by the refusals: one back of $1 for the setter, two for the backer
    assert.equal((await fetch(`${t.base}/api/v1/fiat/balance`, { headers: hdr("guest-SETTER01") }).then((r) => r.json())).balanceMicro, 9_000_000);
    assert.equal((await fetch(`${t.base}/api/v1/fiat/balance`, { headers: hdr("guest-BACKER01") }).then((r) => r.json())).balanceMicro, 8_000_000);
  } finally { await t.app.close(); }
});

test("quick play never seats a backer in a room they backed; anyone watches a public room without signing in", async () => {
  const t = await boot();
  try {
    const a = await t.startRun("Ada"); const b = await t.startRun("Bob");
    await t.credit("guest-BACKER02");
    await t.seat(a.runId, "guest-SOMEONE1");                 // room A has a person, so quick play would pick it first
    assert.equal((await t.back(a.runId, "guest-BACKER02")).status, 200);
    const quick = await fetch(`${t.base}/api/v1/rooms/quick`, { method: "POST", headers: hdr("guest-BACKER02"), body: "{}" }).then((r) => r.json());
    assert.equal(quick.runId, b.runId, "seated in the room they did not back");
    // watching needs no identity at all
    const feed = await fetch(`${t.base}/runs/${a.runId}/spectate`);
    assert.equal(feed.status, 200); const j = await feed.json(); assert.equal(j.state.matchId, a.runId); assert.ok(Array.isArray(j.room.seats));
    assert.equal((await fetch(`${t.base}/watch/${a.runId}`)).status, 200);
  } finally { await t.app.close(); }
});

test("names: a Pollar player's display name is the one they set, else the Google name from Pollar's profile; the feed carries it; no prompt is needed", async () => {
  const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const verify = createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_9", applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", wallet: { address: SOL, chain: "SOLANA" }, profile: { name: "José Álvarez", email: "x@example.com" }, authProvider: "google" } })); }); });
  await new Promise<void>((r) => verify.listen(0, "127.0.0.1", r));
  const gw = new PollarServerApi({ secretKey: "sec_testnet_mock0000000000000000", baseUrl: `http://127.0.0.1:${(verify.address() as any).port}/v3`, log: () => {} });
  const t = await boot({ pollar: gw, supabase: null });
  const auth = { "content-type": "application/json", authorization: "Bearer tok" };
  try {
    const p = await fetch(`${t.base}/api/v1/profile`, { headers: auth }).then((r) => r.json());
    assert.equal(p.name, "Jose Alvarez"); assert.equal(p.hasName, true, "the Google name counts as a name: no page asks for one");
    const { runId } = await t.startRun();
    await fetch(`${t.base}/runs/${runId}/seat`, { method: "POST", headers: auth, body: JSON.stringify({ action: "take" }) });
    const feed = await fetch(`${t.base}/runs/${runId}/spectate`).then((r) => r.json());
    assert.equal(feed.players[SOL], "Jose Alvarez", "the board shows the Google name on the seat");
    // the name they set once wins from then on
    const put = await fetch(`${t.base}/api/v1/profile`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "Chizzy" }) }); assert.equal(put.status, 200);
    assert.equal((await fetch(`${t.base}/api/v1/profile`, { headers: auth }).then((r) => r.json())).name, "Chizzy");
    assert.equal((await fetch(`${t.base}/runs/${runId}/spectate`).then((r) => r.json())).players[SOL], "Chizzy");
  } finally { await t.app.close(); verify.close(); }
  // profile names as display names: accents dropped, punctuation out, 16 characters at most, else the first word
  assert.equal(nameFromProfile("José Álvarez-Núñez"), "Jose");
  assert.equal(nameFromProfile("Emmanuel Ofodile"), "Emmanuel Ofodile");
  assert.equal(nameFromProfile("  Ada   Lovelace  "), "Ada Lovelace");
  assert.equal(nameFromProfile("Mary-Jane O'Neil"), "Mary Jane O Neil");
  assert.equal(nameFromProfile(undefined), "");
});
