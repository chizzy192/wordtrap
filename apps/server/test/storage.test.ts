// Durable money through the MoneyStore: a fake Supabase (tables + the two SQL functions, with an "offline" switch)
// stands in for the real one. Deposit credited once, stake then payout, insufficient funds, same-ref retry no-op,
// restart keeps balances, orphaned stake refunded on startup, outage sentence, migration from the ledger file,
// profiles in players, guests stay in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, USDC_MINTS, base58, MICRO } from "../src/fiat.ts";
import { SupabaseMoneyStore, refundOrphans, OUTAGE, type SupabaseLike } from "../src/store.ts";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL2 = "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde";
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;
const salt = new Uint8Array(32).fill(7);

/** A fake Supabase: four tables, credit_deposit + apply_delta with the documented rules, and an offline switch. */
export function fakeSupabase() {
  const t = { players: [] as any[], balances: [] as any[], deposits: [] as any[], ledger: [] as any[] };
  let nextId = 1; const state = { offline: false, calls: [] as string[] };
  const fail = () => ({ data: null, error: { message: "TypeError: fetch failed" } });
  const bal = (u: string) => t.balances.find((b) => b.user_id === u);
  const rpc = async (fn: string, a: any) => {
    state.calls.push(fn);
    if (state.offline) return fail();
    if (fn === "credit_deposit") {
      if (t.deposits.some((d) => d.signature === a.p_signature)) return { data: false, error: null };
      t.deposits.push({ signature: a.p_signature, user_id: a.p_user, wallet: a.p_wallet, micro: Number(a.p_micro) });
      const b = bal(a.p_user) ?? (t.balances.push({ user_id: a.p_user, micro: 0 }), bal(a.p_user)!);
      b.micro += Number(a.p_micro);
      t.ledger.push({ id: nextId++, user_id: a.p_user, kind: "deposit", micro: Number(a.p_micro), ref: a.p_signature });
      return { data: true, error: null };
    }
    if (fn === "apply_delta") {
      const b = bal(a.p_user) ?? (t.balances.push({ user_id: a.p_user, micro: 0 }), bal(a.p_user)!);
      if (t.ledger.some((l) => l.user_id === a.p_user && l.kind === a.p_kind && l.ref === a.p_ref)) return { data: b.micro, error: null };
      if (b.micro + Number(a.p_delta) < 0) return { data: null, error: { message: "insufficient funds" } };
      b.micro += Number(a.p_delta);
      t.ledger.push({ id: nextId++, user_id: a.p_user, kind: a.p_kind, micro: Number(a.p_delta), ref: a.p_ref });
      return { data: b.micro, error: null };
    }
    return { data: null, error: { message: `unknown function ${fn}` } };
  };
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []; let cols: string[] | null = null, single = false, lim = Infinity, order: [string, boolean] | null = null, op: "select" | "upsert" = "select", payload: any = null, conflict = "user_id";
    const b: any = {
      select(c: string) { cols = c.split(",").map((x) => x.trim()); return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return b; },
      order(k: string, o: { ascending: boolean }) { order = [k, o.ascending]; return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      upsert(row: any, o: { onConflict: string }) { op = "upsert"; payload = row; conflict = o?.onConflict ?? "user_id"; return b; },
      then(res: any, rej: any) {
        state.calls.push(`${op} ${table}`);
        if (state.offline) return Promise.resolve(fail()).then(res, rej);
        const rows: any[] = (t as any)[table];
        if (op === "upsert") { const i = rows.findIndex((r) => r[conflict] === payload[conflict]); if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload }); return Promise.resolve({ data: null, error: null }).then(res, rej); }
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) { const [k, asc] = order; out = [...out].sort((x, y) => (x[k] > y[k] ? 1 : -1) * (asc ? 1 : -1)); }
        out = out.slice(0, lim).map((r) => cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r);
        return Promise.resolve({ data: single ? out[0] ?? null : out, error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { client: { rpc, from } as SupabaseLike, tables: t, state };
}

async function mockPollar(wallet: string) {
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      const token = JSON.parse(raw || "{}").token ?? "";
      const addr = token.startsWith("other") ? SOL2 : wallet;
      res.end(JSON.stringify({ code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: token.startsWith("other") ? "usr_2" : "usr_1", applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", wallet: { address: addr, chain: "SOLANA" } } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { gw: new PollarServerApi({ secretKey: SECRET, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v3`, log: () => {} }), close: () => new Promise<void>((r) => srv.close(() => r())) };
}
function rpcFor(treasury: string) {
  const txs = new Map<string, any>(); const sigs: { signature: string; err: null }[] = [];
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  const transfer = (sig: string, from: string, micro: number) => { txs.set(sig, { meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(20 * MICRO) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(0) }], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(20 * MICRO - micro) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(micro) }] } }); sigs.unshift({ signature: sig, err: null }); };
  return { rpc: { getTransaction: async (s: string) => txs.get(s) ?? null, getGenesisHash: async () => DEVNET_GENESIS, getSignaturesForAddress: async () => sigs, getTokenAccountsByOwner: async (o: string) => (o === treasury ? ["ata"] : []) }, transfer };
}
const hdr = (token: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", authorization: `Bearer ${token}`, ...extra });

/** A Pollar-mode app on the fake Supabase. */
async function boot(fake: ReturnType<typeof fakeSupabase>, extra: Record<string, unknown> = {}) {
  const pol = await mockPollar(SOL);
  const chain = new MockChain(); const treasury = base58(chain.treasury().pubkey);
  const r = rpcFor(treasury);
  const lines: string[] = []; const orig = console.log; console.log = (...a: any[]) => lines.push(a.join(" "));
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 3 }, pollar: pol.gw, rpc: r.rpc, supabase: fake.client, ...extra });
  const port = await app.listen(0);
  console.log = orig;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, token: string, body?: unknown, extraHdr: Record<string, string> = {}) => { const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: hdr(token, extraHdr), body: body === undefined ? undefined : JSON.stringify(body) }); const j = await res.json(); return { http: res.status, ...j }; };
  const deposit = async (n: number, micro: number, token = "tok") => { r.transfer(SIG(n), SOL, micro); return api("/api/v1/fiat/confirm", token, { signature: SIG(n), amount: micro / MICRO }); };
  const startRun = async () => { const s = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Oly" }) }).then((x) => x.json()); return { ...s, auth: { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` } }; };
  const seat = async (runId: string, token: string) => (await api(`/runs/${runId}/seat`, token, { action: "take" })).token as string;
  const treasuryKey = async () => Uint8Array.from(Buffer.from((await fetch(`${base}/api/v1/treasury`).then((x) => x.json())).pubkeyHex, "hex"));
  return { app, base, api, deposit, startRun, seat, treasuryKey, rpc: r, lines, close: async () => { await app.close(); await pol.close(); } };
}

test("supabase: a deposit is credited once, balances are read from the table, guests stay in memory", async () => {
  const fake = fakeSupabase(); const t = await boot(fake);
  try {
    assert.equal(t.app.store?.kind, "supabase");
    const a = await t.deposit(1, 5 * MICRO); assert.equal(a.http, 200); assert.equal(a.credited, true); assert.equal(a.balanceMicro, 5 * MICRO);
    const b = await t.deposit(1, 5 * MICRO); assert.equal(b.duplicate, true); assert.equal(b.balanceMicro, 5 * MICRO);
    assert.equal(fake.tables.deposits.length, 1); assert.equal(fake.tables.balances.find((x) => x.user_id === SOL)?.micro, 5 * MICRO);
    const bal = await t.api("/api/v1/fiat/balance", "tok");
    assert.equal(bal.balanceMicro, 5 * MICRO); assert.equal(bal.storage, "supabase"); assert.deepEqual(bal.deposits, [SIG(1)]);
    assert.equal(t.app.ledger.balance(SOL), 0, "no memory money for a Supabase player");
    // a guest's test funds never touch Supabase
    const guest = await fetch(`${t.base}/dev/credit`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-ABCDEFGH" }, body: JSON.stringify({ amount: 5 }) });
    assert.equal(guest.status, 403, "dev credits are off in Pollar mode");
    assert.ok(!fake.tables.balances.some((x) => String(x.user_id).startsWith("guest-")) && !fake.state.calls.some((c) => c.includes("guest")));
    const h = await fetch(`${t.base}/healthz`).then((x) => x.json()); assert.equal(h.storage, "supabase");
  } finally { await t.close(); }
});

test("supabase: stake, bounty and backer payout move through apply_delta with stable refs; a retry with the same ref is a no-op; short funds are refused", async () => {
  const fake = fakeSupabase(); const t = await boot(fake);
  try {
    await t.deposit(2, 5 * MICRO);
    const run = await t.startRun();
    const token = await t.seat(run.runId, "tok");
    const word = run.state.hand.find((w: string) => w !== run.state.safe)!;
    const c = toHex(commitment(word, salt, await t.treasuryKey()));
    const planted = await t.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: c, stake: 1 }, { "x-seat-token": token });
    assert.equal(planted.http, 200); assert.equal(planted.balanceMicro, 4 * MICRO);
    assert.deepEqual(fake.tables.ledger.filter((l) => l.kind === "plant").map((l) => [l.micro, l.ref]), [[-MICRO, `${run.runId}:plant:${c.slice(0, 16)}`]]);
    // the same plant again (a retried request) is not charged or planted twice
    const again = await t.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: c, stake: 1 }, { "x-seat-token": token });
    assert.equal(again.duplicate, true); assert.equal(again.balanceMicro, 4 * MICRO); assert.equal(again.trap.id, planted.trap.id);
    // short funds: refused by the function, nothing debited anywhere
    const big = await t.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: "ab".repeat(32), stake: 50 }, { "x-seat-token": token });
    assert.equal(big.http, 402); assert.equal(big.error, "Not enough funds. Add funds to play.");
    assert.equal(fake.tables.balances.find((x) => x.user_id === SOL)?.micro, 4 * MICRO);
    // back Byte: its own ref per back
    const back = await t.api(`/runs/${run.runId}/back-fiat`, "tok", { amount: 1 });
    assert.equal(back.balanceMicro, 3 * MICRO); assert.ok(fake.tables.ledger.some((l) => l.kind === "back" && l.ref === `${run.runId}:back:${SOL}:0`));
    // Byte plays the mined word → the bounty is paid through apply_delta, once
    await fetch(`${t.base}/api/v1/runs/${run.runId}/pass`, { method: "POST", headers: run.auth, body: "{}" });
    await fetch(`${t.base}/api/v1/runs/${run.runId}/play`, { method: "POST", headers: run.auth, body: JSON.stringify({ word }) });
    const rev = await t.api(`/runs/${run.runId}/reveal-fiat`, "tok", { trapId: planted.trap.id, word, saltHex: toHex(salt) });
    assert.equal(rev.http, 200); assert.equal(rev.status, "paid");
    for (let i = 0; i < 40 && !fake.tables.ledger.some((l) => l.kind === "bounty"); i++) await new Promise((r) => setTimeout(r, 25));
    const bounty = fake.tables.ledger.find((l) => l.kind === "bounty");
    assert.ok(bounty && bounty.micro === rev.payoutMicro && bounty.ref === `${run.runId}:bounty:${planted.trap.id}`, "bounty row");
    const afterBounty = (await t.api("/api/v1/fiat/balance", "tok")).balanceMicro;
    assert.equal(afterBounty, 3 * MICRO + rev.payoutMicro);
    // direct retry of the same movement is a no-op
    const store = t.app.store!;
    const b1 = await store.applyDelta(SOL, rev.payoutMicro, "bounty", `${run.runId}:bounty:${planted.trap.id}`);
    assert.equal(b1, afterBounty); assert.equal(fake.tables.ledger.filter((l) => l.kind === "bounty").length, 1);
  } finally { await t.close(); }
});

test("supabase: a restart keeps balances; a stake whose run never settled is refunded once on startup, with a log line", async () => {
  const fake = fakeSupabase();
  const t1 = await boot(fake);
  let runId: string, ref: string;
  try {
    await t1.deposit(3, 5 * MICRO);
    const run = await t1.startRun(); runId = run.runId;
    const token = await t1.seat(run.runId, "tok");
    const word = run.state.hand.find((w: string) => w !== run.state.safe)!;
    const c = toHex(commitment(word, salt, await t1.treasuryKey())); ref = `${run.runId}:plant:${c.slice(0, 16)}`;
    await t1.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: c, stake: 2 }, { "x-seat-token": token });
    await t1.api(`/runs/${run.runId}/back-fiat`, "tok", { amount: 1 });
    assert.equal((await t1.api("/api/v1/fiat/balance", "tok")).balanceMicro, 2 * MICRO);
  } finally { await t1.close(); }
  // "restart": a fresh process with an empty memory ledger and no runs, the same Supabase
  const t2 = await boot(fake);
  try {
    assert.equal((await t2.api("/api/v1/fiat/balance", "tok")).balanceMicro, 5 * MICRO, "balance kept across the restart and the open stake + back refunded");
    const refunds = fake.tables.ledger.filter((l) => l.kind === "refund");
    assert.deepEqual(refunds.map((l) => [l.micro, l.ref]).sort(), [[MICRO, `refund:${runId!}:back:${SOL}:0`], [2 * MICRO, `refund:${ref!}`]]);
    assert.ok(t2.lines.some((l) => l === `[fiat] refunded $2.00 to 7xKX…gAsU for an unfinished run (${ref!})`), "one line per refund");
    assert.ok(!t2.lines.some((l) => l.includes(SECRET)));
    // running startup again refunds nothing more
    const again = await t2.app.startup(); assert.deepEqual(again.refunds, []);
    assert.equal(fake.tables.ledger.filter((l) => l.kind === "refund").length, 2);
    // a settled run is never refunded: payout/settle rows close its stakes
    const store = t2.app.store!;
    await store.applyDelta(SOL, -MICRO, "back", "runX:back:SOL:0"); await store.applyDelta(SOL, 3 * MICRO, "payout", "runX:payout:SOL");
    await store.applyDelta(SOL, -MICRO, "plant", "runX:plant:abc"); await store.applyDelta(SOL, 2 * MICRO, "bounty", "runX:bounty:abc");
    assert.deepEqual(await refundOrphans(store), []);
  } finally { await t2.close(); }
});

test("supabase: when it is unreachable, money actions answer the outage sentence, nothing moves in memory, and /healthz says so", async () => {
  const fake = fakeSupabase(); const t = await boot(fake);
  try {
    await t.deposit(4, 5 * MICRO);
    const run = await t.startRun(); const token = await t.seat(run.runId, "tok");
    fake.state.offline = true;
    const planted = await t.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: "cd".repeat(32), stake: 1 }, { "x-seat-token": token });
    assert.equal(planted.http, 503); assert.equal(planted.error, OUTAGE);
    assert.equal((await t.api("/api/v1/fiat/balance", "tok")).error, OUTAGE);
    assert.equal(t.app.ledger.balance(SOL), 0, "nothing debited or credited in memory instead");
    assert.equal((await fetch(`${t.base}/healthz`).then((x) => x.json())).storage, "supabase-unreachable");
    fake.state.offline = false;
    assert.equal((await t.api("/api/v1/fiat/balance", "tok")).balanceMicro, 5 * MICRO, "untouched");
    assert.equal((await fetch(`${t.base}/healthz`).then((x) => x.json())).storage, "supabase");
  } finally { await t.close(); }
});

test("supabase: the old ledger file is migrated once; display names live in players; memory is used without Supabase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-ledger-"));
  const file = join(dir, "fiat-ledger.json");
  writeFileSync(file, JSON.stringify({ version: 1, balances: { [SOL]: 3 * MICRO, "guest-OLDGUEST": 10 * MICRO }, payments: { [SIG(9)]: { user: SOL, micro: 5 * MICRO, status: "credited", ts: 1, tries: 1 }, "dev-1": { user: "guest-OLDGUEST", micro: 10 * MICRO, status: "credited", ts: 1, tries: 1 } }, traps: {}, backers: {}, settled: {}, history: [] }));
  const fake = fakeSupabase();
  for (let start = 0; start < 2; start++) {
    const t = await boot(fake, { ledgerPath: file });
    try {
      assert.deepEqual(fake.tables.deposits.map((d) => [d.signature, d.user_id, d.micro]), [[SIG(9), SOL, 5 * MICRO]], "credited signature copied once");
      assert.equal(fake.tables.balances.find((x) => x.user_id === SOL)?.micro, 3 * MICRO, "balance copied: 5 deposited, 2 spent");
      assert.ok(!fake.tables.balances.some((x) => String(x.user_id).startsWith("guest-")), "guests never migrate");
      if (start === 0) assert.ok(t.lines.some((l) => l.includes("[fiat] migrated 1 deposits and 1 balances")));
      // profiles: a Pollar player's name goes to players(user_id, wallet, display_name); the server upserts the wallet on sign-in
      await t.api("/api/v1/profile", "tok", { name: "Emmanuel" });
      const row = fake.tables.players.find((p) => p.user_id === "usr_1");
      assert.deepEqual(row, { user_id: "usr_1", wallet: SOL, display_name: "Emmanuel" });
      assert.equal((await t.api("/api/v1/profile", "tok")).name, "Emmanuel");
    } finally { await t.close(); }
  }
  // no Supabase configured: memory store, /healthz says memory
  const pol = await mockPollar(SOL);
  const mem = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, supabase: null, rpc: rpcFor("x").rpc });
  const port = await mem.listen(0);
  try { assert.equal(mem.store, null); assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`).then((x) => x.json())).storage, "memory"); } finally { await mem.close(); await pol.close(); }
});

test("SupabaseMoneyStore maps the client's answers: insufficient → 402 sentence, errors → outage", async () => {
  const fake = fakeSupabase(); const store = new SupabaseMoneyStore(fake.client);
  assert.equal(await store.creditDeposit(SIG(10), SOL, SOL, 100), true); assert.equal(await store.creditDeposit(SIG(10), SOL, SOL, 100), false);
  assert.equal(await store.balance(SOL), 100); assert.deepEqual(await store.depositOf(SIG(10)), { user: SOL, micro: 100 });
  await assert.rejects(() => store.applyDelta(SOL, -101, "plant", "r:plant:1"), (e: any) => e.code === 402 && e.message === "Not enough funds. Add funds to play.");
  fake.state.offline = true;
  await assert.rejects(() => store.balance(SOL), (e: any) => e.code === 503 && e.message === OUTAGE);
  assert.equal(await store.ping(), false);
});
