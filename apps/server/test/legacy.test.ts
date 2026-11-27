// TREASURY_KEYPAIR never crashes startup; LEGACY_TREASURY_ADDRESSES deposits still credit once but are never a
// destination; the funds page reads the treasury right before each payment and refuses when it is not configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, USDC_MINTS, base58, MICRO } from "../src/fiat.ts";
import { SolanaTreasury, parseSecretKey } from "../src/treasury.ts";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const LEGACY = "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde";
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;

test("TREASURY_KEYPAIR: every bad value is reported in one line without the value, and startup goes on with withdrawals off", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.generate();
  const dir = mkdtempSync(join(tmpdir(), "wt-kp-"));
  const good = join(dir, "good.json"); writeFileSync(good, JSON.stringify([...kp.secretKey]));
  const junkFile = join(dir, "junk.json"); writeFileSync(junkFile, "not json at all");
  const short = join(dir, "short.json"); writeFileSync(short, JSON.stringify([1, 2, 3]));
  const cases: [string, string | null][] = [
    [kp.publicKey.toBase58(), "a public address"],
    [join(dir, "nope.json"), "a missing file"],
    [junkFile, "neither a JSON array nor base58"],
    [short, "a JSON array that is not 64 bytes"],
    ["[1,2,3]", "a JSON array that is not 64 bytes"],
    ["{\"secret\": 1}", "neither a JSON array, a base58 secret key nor a file path"],
    ["hello world", "neither a JSON array, a base58 secret key nor a file path"],
  ];
  for (const [value, reason] of cases) {
    const lines: string[] = [];
    const t = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: value } as any, MINT, (l) => lines.push(l));
    assert.equal(t, null, value);
    assert.equal(lines.length, 1); assert.equal(lines[0], `TREASURY_KEYPAIR is not a secret key (it looks like ${reason}). Withdrawals are off.`);
    assert.ok(!lines[0].includes(value.slice(0, 12)), "the value is not printed");
  }
  // the three accepted forms
  const inline = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: JSON.stringify([...kp.secretKey]) } as any, MINT)!;
  const file = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: good } as any, MINT)!;
  const b58 = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: base58(kp.secretKey) } as any, MINT)!;
  for (const t of [inline, file, b58]) assert.equal(t.address, kp.publicKey.toBase58());
  assert.deepEqual(parseSecretKey("   "), { error: "neither a JSON array, a base58 secret key nor a file path" });
  // and the server still starts with a bad value in the environment
  const prev = process.env.TREASURY_KEYPAIR; process.env.TREASURY_KEYPAIR = kp.publicKey.toBase58();
  const warned: string[] = []; const origWarn = console.warn; console.warn = (...a: any[]) => warned.push(a.join(" "));
  try {
    const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 } });
    const port = await app.listen(0);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json())).withdrawals, "not configured");
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/treasury`).then((r) => r.json())).address, base58((new MockChain()).treasury().pubkey), "previous treasury behaviour kept");
    } finally { await app.close(); }
    assert.ok(warned.some((l) => l.startsWith("TREASURY_KEYPAIR is not a secret key (it looks like a public address). Withdrawals are off.")));
  } finally { console.warn = origWarn; if (prev === undefined) delete process.env.TREASURY_KEYPAIR; else process.env.TREASURY_KEYPAIR = prev; }
});

async function mockPollar() {
  const srv = createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_1", applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", wallet: { address: SOL, chain: "SOLANA" } } })); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { gw: new PollarServerApi({ secretKey: SECRET, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v3`, log: () => {} }), close: () => new Promise<void>((r) => srv.close(() => r())) };
}
function rpcFor(treasuries: string[]) {
  const txs = new Map<string, any>(); const sigs = new Map<string, { signature: string; err: null }[]>();
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  const transfer = (sig: string, from: string, to: string, micro: number) => {
    txs.set(sig, { meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO) }, { accountIndex: 2, mint: MINT, owner: to, uiTokenAmount: ui(0) }], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO - micro) }, { accountIndex: 2, mint: MINT, owner: to, uiTokenAmount: ui(micro) }] } });
    const list = sigs.get(`ata:${to}`) ?? []; list.unshift({ signature: sig, err: null }); sigs.set(`ata:${to}`, list);
  };
  const calls: string[] = [];
  return { rpc: { getTransaction: async (s: string) => txs.get(s) ?? null, getGenesisHash: async () => DEVNET_GENESIS, getSignaturesForAddress: async (a: string) => sigs.get(a) ?? [], getTokenAccountsByOwner: async (o: string) => { calls.push(o); return treasuries.includes(o) ? [`ata:${o}`] : []; } }, transfer, calls };
}
const hdr = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

test("LEGACY_TREASURY_ADDRESSES: a finalized transfer to an earlier treasury credits once (confirm and reconcile); new payments only ever name the current treasury", async () => {
  const pol = await mockPollar();
  const current = base58(new MockChain().treasury().pubkey);
  const m = rpcFor([current, LEGACY]);
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: m.rpc, supabase: null, legacyTreasuries: [LEGACY, "not-an-address"] });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    // confirm: a deposit that went to the old address
    m.transfer(SIG(1), SOL, LEGACY, 5 * MICRO);
    const a = await fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: SIG(1), amount: 5 }) }).then((r) => r.json());
    assert.equal(a.status, "credited"); assert.equal(a.balanceMicro, 5 * MICRO);
    const again = await fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: SIG(1), amount: 5 }) }).then((r) => r.json());
    assert.equal(again.duplicate, true); assert.equal(again.balanceMicro, 5 * MICRO, "once");
    // reconcile: an uncredited deposit to the old address, and one to the current one
    m.transfer(SIG(2), SOL, LEGACY, 2 * MICRO); m.transfer(SIG(3), SOL, current, 1 * MICRO);
    const rec = await fetch(`${base}/api/v1/fiat/reconcile`, { method: "POST", headers: hdr("tok") }).then((r) => r.json());
    assert.deepEqual(rec.credited.map((c: any) => [c.signature, c.micro]).sort(), [[SIG(2), 2 * MICRO], [SIG(3), 1 * MICRO]]);
    assert.ok(m.calls.includes(LEGACY) && m.calls.includes(current), "both treasuries' token accounts are scanned");
    assert.equal(rec.balanceMicro, 8 * MICRO);
    assert.deepEqual((await fetch(`${base}/api/v1/fiat/reconcile`, { method: "POST", headers: hdr("tok") }).then((r) => r.json())).credited, [], "once");
    // a transfer to some other address is still refused
    m.transfer(SIG(4), SOL, "SomeoneElse111111111111111111111111111111111", 3 * MICRO);
    const other = await fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: SIG(4), amount: 3 }) });
    assert.equal(other.status, 402);
    // new payments: the treasury endpoint names only the current address, and says withdrawals are not configured
    const t = await fetch(`${base}/api/v1/treasury`).then((r) => r.json());
    assert.equal(t.address, current); assert.ok(!JSON.stringify(t).includes(LEGACY)); assert.equal(t.withdrawals, "not configured");
  } finally { await app.close(); await pol.close(); }
});

test("funds page: the treasury is read from the server right before each payment, and the send is refused when it is not configured", () => {
  const app = readFileSync(fileURLToPath(new URL("../../stake/src/App.tsx", import.meta.url)), "utf8");
  const i = app.indexOf('await fetch(SERVER + "/api/v1/treasury", { cache: "no-store" })'); const j = app.indexOf("await id.sendUsdc(fresh.address");
  assert.ok(i > 0 && j > i, "a fresh read precedes the send");
  assert.ok(app.slice(i, j).includes('fresh.withdrawals !== "ready"') && app.slice(i, j).includes("adding funds is paused. Nothing was sent."), "refuses when not configured");
  assert.ok(!app.slice(i, j + 60).includes("treasury.address"), "no cached address on the send path");
});
