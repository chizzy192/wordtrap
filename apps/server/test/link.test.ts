// Finding a Pollar user's Solana wallet (q by id, by email, by Stellar key, by paging; a row without a Solana wallet),
// the readiness gate the funds page asks before any payment, and proof-of-control linking with its rules (exact
// amount, window, one address per user, one user per address, two users racing, a claim alone never binds) followed by
// reconciliation of earlier transfers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, USDC_MINTS, base58, MICRO } from "../src/fiat.ts";
import { LINK_WORDING, microToUsd6 } from "../src/links.ts";
import { fakeSupabase } from "./fake-supabase.ts";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL2 = "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde";
const STELLAR = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR2 = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;

/** Mocked Pollar: verify per token; GET /users mirrors the live service (q matches email, name and wallet, NOT the id) with paging. */
async function mockPollar(o: { users: any[]; qMatchesId?: boolean; verify?: Record<string, any> }) {
  const hits: string[] = []; const log: string[] = [];
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-pollar-api-key"] !== SECRET) return reply(403, { code: "API_KEY_TYPE_NOT_ALLOWED", success: false });
      const url = new URL(req.url!, "http://x");
      if (req.method === "POST" && url.pathname === "/v3/tokens/verify") {
        const token = JSON.parse(raw || "{}").token ?? "";
        const v = o.verify?.[token] ?? { userId: "usr_1", wallet: STELLAR, profile: { mail: "one@example.com" } };
        return reply(200, { code: "SERVER_TOKEN_VERIFIED", success: true, content: { applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", authProvider: "google", ...v } });
      }
      if (req.method === "GET" && url.pathname === "/v3/users") {
        hits.push(url.search);
        const q = url.searchParams.get("q"); const page = Number(url.searchParams.get("page") ?? 1); const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 20));
        let rows = o.users;
        if (q) rows = rows.filter((u) => [u.email, u.name, u.wallet_public_key, ...(u.wallets ?? []).map((w: any) => w.public_key), ...(o.qMatchesId ? [u.id] : [])].some((f) => String(f ?? "").toLowerCase().includes(q.toLowerCase())));
        const total = rows.length; const items = rows.slice((page - 1) * limit, page * limit);
        return reply(200, { code: "SERVER_USERS_LIST", success: true, content: { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } });
      }
      reply(404, { code: "NOT_FOUND", success: false });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const gw = new PollarServerApi({ secretKey: SECRET, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v3`, log: (l) => log.push(l) });
  return { gw, hits, log, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const me = (extra: Record<string, unknown> = {}) => ({ id: "usr_1", name: "One", email: "one@example.com", wallet_public_key: STELLAR, wallets: [{ network: "stellar", public_key: STELLAR }, { network: "solana", public_key: SOL }], ...extra });
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `usr_f${i}`, name: `Filler ${i}`, email: `f${i}@example.com`, wallet_public_key: STELLAR2, wallets: [{ network: "stellar", public_key: STELLAR2 }] }));

test("users lookup: q=id when the service matches ids; q=email; q=Stellar key; paging through GET /users; a row whose id differs is never accepted; cached per user", async () => {
  // (a) the service matches q on the id
  let m = await mockPollar({ users: [...filler(3), me()], qMatchesId: true });
  try { const s = await m.gw.verifySession("t"); assert.equal(s.wallet, SOL); assert.equal(s.lookup, "q=id"); assert.ok(m.log.some((l) => l === "[fiat] users lookup found the row via q=id")); } finally { await m.close(); }
  // (b) q does not match the id (the live behaviour): email finds it
  m = await mockPollar({ users: [...filler(3), me()] });
  try {
    const s = await m.gw.verifySession("t"); assert.equal(s.wallet, SOL); assert.equal(s.lookup, "q=email");
    assert.deepEqual(m.hits.slice(0, 2).map((h) => decodeURIComponent(h)), ["?q=usr_1&limit=50", "?q=one@example.com&limit=50"]);
    assert.ok(!m.log.some((l) => l.includes("one@example.com") || l.includes(SOL)), "no values in the log");
    // cached: a second fresh verify of another token for the same user makes no new users request
    const n = m.hits.length; await m.gw.verifySession("t2"); assert.equal(m.hits.length, n);
  } finally { await m.close(); }
  // (b2) no email in the verify content: the Stellar key finds it
  m = await mockPollar({ users: [...filler(2), me({ email: "hidden@example.com" })], verify: { t: { userId: "usr_1", wallet: STELLAR } } });
  try { const s = await m.gw.verifySession("t"); assert.equal(s.wallet, SOL); assert.equal(s.lookup, "q=stellar"); } finally { await m.close(); }
  // (c) nothing matches q at all (no email, a different key): paging finds the row by exact id on page 3
  m = await mockPollar({ users: [...filler(450), me({ email: "", wallet_public_key: STELLAR2 })], verify: { t: { userId: "usr_1", wallet: "GXXX" } } });
  try {
    const s = await m.gw.verifySession("t"); assert.equal(s.wallet, SOL); assert.equal(s.lookup, "pages (page 3)");
    assert.ok(m.hits.some((h) => h.includes("page=3&limit=200")));
  } finally { await m.close(); }
  // a row with an email that matches but a different id is never accepted; beyond 20 pages the lookup gives up
  m = await mockPollar({ users: [...filler(4100), { ...me(), id: "usr_other" }] });
  try {
    const s = await m.gw.verifySession("t"); assert.equal(s.wallet, null); assert.equal(s.lookup, "none");
    assert.equal(m.hits.filter((h) => h.includes("page=")).length, 20, "capped at 20 pages");
    assert.ok(m.log.some((l) => l.startsWith("[fiat] users lookup found no row with this id")));
  } finally { await m.close(); }
});

function rpcFor(treasury: string) {
  const txs = new Map<string, any>(); const sigs: { signature: string; err: null }[] = [];
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  const transfer = (sig: string, from: string, micro: number, blockTime = Math.floor(Date.now() / 1000)) => { txs.set(sig, { blockTime, meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(0) }], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO - micro) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(micro) }] } }); sigs.unshift({ signature: sig, err: null }); };
  return { rpc: { getTransaction: async (s: string) => txs.get(s) ?? null, getGenesisHash: async () => DEVNET_GENESIS, getSignaturesForAddress: async () => sigs, getTokenAccountsByOwner: async (o: string) => (o === treasury ? ["ata"] : []) }, transfer };
}
const hdr = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

/** Two Pollar users whose rows exist but carry no Solana wallet yet (the live case): everything must go through the link. */
async function bootNoWallet(opts: Record<string, unknown> = {}) {
  const pol = await mockPollar({ users: [{ ...me(), wallets: [{ network: "stellar", public_key: STELLAR }] }, { id: "usr_2", email: "two@example.com", wallet_public_key: STELLAR2, wallets: [{ network: "stellar", public_key: STELLAR2 }] }], verify: { one: { userId: "usr_1", wallet: STELLAR, profile: { mail: "one@example.com" } }, two: { userId: "usr_2", wallet: STELLAR2, profile: { mail: "two@example.com" } } } });
  const chain = new MockChain(); const treasury = base58(chain.treasury().pubkey);
  const r = rpcFor(treasury);
  const fake = fakeSupabase();
  let now = Date.now(); let rnd = 0.4216;
  const lines: string[] = []; const orig = console.log; console.log = (...a: any[]) => lines.push(a.join(" "));
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: r.rpc, supabase: fake.client, linkNow: () => now, linkRandom: () => rnd, ...opts });
  const port = await app.listen(0); console.log = orig;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, token: string, body?: unknown) => { const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: hdr(token), body: body === undefined ? undefined : JSON.stringify(body) }); const j = await res.json(); return { http: res.status, ...j }; };
  return { app, base, api, rpc: r, fake, pol, lines, setNow: (t: number) => { now = t; }, setRnd: (x: number) => { rnd = x; }, close: async () => { await app.close(); await pol.close(); } };
}

test("ready: false with the link sentence while the wallet is unknown; false when the paying address differs; true otherwise; row found but no Solana wallet falls through to the link", async () => {
  const t = await bootNoWallet();
  try {
    const r = await t.api(`/api/v1/fiat/ready?address=${SOL}`, "one");
    assert.equal(r.http, 200); assert.equal(r.ready, false); assert.equal(r.link, true); assert.equal(r.lookup, "q=email");
    assert.equal(r.reason, "We couldn't find your Solana wallet with Pollar. Do the one-time wallet check below to link it.");
    assert.ok(t.pol.log.some((l) => l.startsWith("[fiat] users row found via q=email but it has no Solana wallet yet")));
    assert.equal((await t.api("/api/v1/fiat/balance", "one")).http, 428, "money calls still answer 428 meanwhile");
    assert.equal((await fetch(`${t.base}/api/v1/fiat/ready`)).status, 401);
  } finally { await t.close(); }
  // with a known wallet: ready only for that address
  const pol = await mockPollar({ users: [me()] });
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: rpcFor("x").rpc, supabase: null });
  const port = await app.listen(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/v1/fiat/ready?address=${SOL}`, { headers: hdr("t") }).then((r) => r.json());
    assert.deepEqual(ok, { ready: true, wallet: SOL, lookup: "q=email" });
    const other = await fetch(`http://127.0.0.1:${port}/api/v1/fiat/ready?address=${SOL2}`, { headers: hdr("t") }).then((r) => r.json());
    assert.equal(other.ready, false); assert.equal(other.link, false); assert.match(other.reason, /is not the one Pollar gave us for your account/);
  } finally { await app.close(); await pol.close(); }
});

test("link: start gives $1 + a 1–9999 micro tail valid 10 minutes, unique among open links; the exact finalized payment binds and credits once; wrong amount, late, taken address, and a claim alone never bind; the race goes to the first proof; earlier transfers are then reconciled", async () => {
  const t = await bootNoWallet();
  try {
    const s = await t.api("/api/v1/fiat/link/start", "one", {});
    assert.equal(s.http, 200); assert.equal(s.amountMicro, 1_000_000 + 1 + Math.floor(0.4216 * 9999)); assert.equal(s.amountText, microToUsd6(s.amountMicro));
    assert.equal(s.wording, LINK_WORDING(s.amountText)); assert.equal(s.wording, `One-time wallet check: confirm a payment of $${s.amountText}. It is added to your game balance.`);
    assert.ok(s.amountMicro > 1_000_000 && s.amountMicro <= 1_009_999);
    const again = await t.api("/api/v1/fiat/link/start", "one", {}); assert.equal(again.amountMicro, s.amountMicro, "the open link is returned again");
    const other = await t.api("/api/v1/fiat/link/start", "two", {}); assert.notEqual(other.amountMicro, s.amountMicro, "unique among open links (same random tail re-rolled)");
    // a claim alone binds nothing
    const claim = await t.api("/api/v1/fiat/link/confirm", "one", { address: SOL });
    assert.equal(claim.http, 202); assert.equal(claim.status, "pending"); assert.equal(t.fake.tables.players.find((p) => p.user_id === "usr_1")?.wallet ?? null, null);
    // wrong amount: refused, nothing bound
    t.rpc.transfer(SIG(1), SOL, 1_000_000);
    const wrong = await t.api("/api/v1/fiat/link/confirm", "one", { address: SOL, signature: SIG(1) });
    assert.equal(wrong.http, 409); assert.equal(wrong.reason, `That payment was $1.000000, not the one-time amount of $${s.amountText}. Nothing was linked.`);
    // an earlier transfer from this wallet that was never credited (to be reconciled after the link)
    t.rpc.transfer(SIG(2), SOL, 3 * MICRO);
    // the exact amount from the claimed address: linked, credited once, then reconciliation credits the earlier $3
    t.rpc.transfer(SIG(3), SOL, s.amountMicro);
    const linked = await t.api("/api/v1/fiat/link/confirm", "one", { address: SOL, signature: SIG(3) });
    assert.equal(linked.http, 200); assert.equal(linked.status, "linked"); assert.equal(linked.wallet, SOL); assert.equal(linked.credited, s.amountMicro);
    // every earlier transfer from the now-known wallet is credited once, the mis-amount $1.00 included (it is real money that arrived)
    assert.deepEqual(linked.reconciled.map((c: any) => [c.signature, c.micro]).sort(), [[SIG(1), 1 * MICRO], [SIG(2), 3 * MICRO]], "earlier transfers credited once by reconciliation");
    assert.equal(linked.balanceMicro, s.amountMicro + 4 * MICRO);
    assert.equal(t.fake.tables.players.find((p) => p.user_id === "usr_1")?.wallet, SOL);
    assert.ok(t.lines.some((l) => l.startsWith("[fiat] wallet linked by proof of control for Pollar user usr_1")) && !t.lines.some((l) => l.includes(SOL)));
    // from now on the session knows the wallet: ready, balance, deposits all work; a second confirm changes nothing
    const ready = await t.api(`/api/v1/fiat/ready?address=${SOL}`, "one"); assert.equal(ready.ready, true); assert.equal(ready.lookup, "linked");
    assert.equal((await t.api("/api/v1/fiat/balance", "one")).balanceMicro, s.amountMicro + 4 * MICRO);
    assert.equal(t.fake.tables.deposits.length, 3);
    // user two tries to claim the same address with their own exact payment: refused, the address belongs to user one
    const s2 = await t.api("/api/v1/fiat/link/start", "two", {});
    t.rpc.transfer(SIG(4), SOL, s2.amountMicro);
    const taken = await t.api("/api/v1/fiat/link/confirm", "two", { address: SOL, signature: SIG(4) });
    assert.equal(taken.http, 409); assert.equal(taken.reason, "That wallet is already linked to another Pollar account.");
    assert.equal(t.fake.tables.players.find((p) => p.user_id === "usr_2")?.wallet ?? null, null);
    assert.equal(t.fake.tables.deposits.length, 3, "a refused link credits nothing (that payment belongs to wallet SOL and is picked up by SOL's own reconciliation, never by user two)");
    // late: a payment after the window never binds
    t.setNow(Date.now() + 11 * 60_000);
    const s3 = await t.api("/api/v1/fiat/link/start", "two", {});
    t.rpc.transfer(SIG(5), SOL2, s3.amountMicro, Math.floor((Date.now() + 25 * 60_000) / 1000));
    const late = await t.api("/api/v1/fiat/link/confirm", "two", { address: SOL2, signature: SIG(5) });
    assert.equal(late.http, 409); assert.match(late.reason, /after the 10-minute window/);
  } finally { await t.close(); }
});

test("link: two users racing for one address, the first finalized proof wins; the loser's payment is not credited to anyone's game balance", async () => {
  const t = await bootNoWallet();
  try {
    const a = await t.api("/api/v1/fiat/link/start", "one", {}); t.setRnd(0.9); const b = await t.api("/api/v1/fiat/link/start", "two", {});
    assert.notEqual(a.amountMicro, b.amountMicro);
    t.rpc.transfer(SIG(6), SOL, a.amountMicro); t.rpc.transfer(SIG(7), SOL, b.amountMicro);
    const [ra, rb] = await Promise.all([t.api("/api/v1/fiat/link/confirm", "one", { address: SOL, signature: SIG(6) }), t.api("/api/v1/fiat/link/confirm", "two", { address: SOL, signature: SIG(7) })]);
    const winners = [ra, rb].filter((r) => r.status === "linked"); const losers = [ra, rb].filter((r) => r.status === "refused");
    assert.equal(winners.length, 1); assert.equal(losers.length, 1);
    assert.equal(losers[0].reason, "That wallet is already linked to another Pollar account.");
    const rows = t.fake.tables.players.filter((p) => p.wallet === SOL); assert.equal(rows.length, 1, "one user per address");
    // both payments came from wallet SOL, so both land in that wallet's game balance (the winner's identity); the loser's account gets nothing
    assert.deepEqual(t.fake.tables.deposits.map((d) => d.user_id), [SOL, SOL]); assert.equal(t.fake.tables.balances.find((b) => b.user_id === SOL)?.micro, a.amountMicro + b.amountMicro);
    assert.equal(t.fake.tables.players.filter((p) => p.wallet).length, 1, "the loser's account has no wallet");
  } finally { await t.close(); }
});

test("page: the add button cannot send before readiness; the link flow is wired", () => {
  const app = readFileSync(new URL("../../stake/src/App.tsx", import.meta.url), "utf8");
  const i = app.indexOf("const gate = await checkReady(paying);"); const j = app.indexOf("await id.sendUsdc(fresh.address", i);
  assert.ok(i > 0 && j > i, "readiness is asked right before the send");
  assert.ok(app.includes('if (!gate.ready) throw new Error(gate.reason || "Payments are paused. Nothing was sent.");'));
  assert.ok(app.includes('(mode !== "pollar" || ready.ready)'), "the button is disabled when not ready");
  assert.ok(app.includes('"/api/v1/fiat/link/start"') && app.includes('"/api/v1/fiat/link/confirm"') && app.includes("Start the wallet check"));
  assert.ok(!app.includes('"/api/v1/fiat/wallet"'), "the page never claims an address by itself");
});
