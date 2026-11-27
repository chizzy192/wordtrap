// Cash-out: POST /api/v1/fiat/withdraw with a fake treasury (signs, broadcasts and reports finality however the test
// says) over the fake Supabase. Order of operations, idempotency, limits, pause checks, refunds, the unknown→pending
// path settled by the sweep (and on startup), locked stakes, and never sending twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, USDC_MINTS, base58, MICRO } from "../src/fiat.ts";
import { MIN_SOL_LAMPORTS, type TreasuryWallet, type Finality, type SendOutcome } from "../src/treasury.ts";
import { PAUSED, NOT_SET_UP } from "../src/withdrawals.ts";
import { fakeSupabase } from "./fake-supabase.ts";
import { SolanaTreasury } from "../src/treasury.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;
const salt = new Uint8Array(32).fill(9);

/** A treasury that signs instantly; what broadcast and finality answer is scripted per test. */
function fakeTreasury() {
  const t = {
    address: "TreasuryFakeAddress11111111111111111111111",
    usdcMicro: 100n * BigInt(MICRO), lamports: 50_000_000n,
    broadcasts: [] as { signature: string; to: string; micro: bigint }[],
    nextBroadcast: "sent" as "sent" | "failed",
    finalityOf: new Map<string, Finality>(),
    defaultFinality: "finalized" as Finality,
    prepared: 0,
    async holdings() { return { usdcMicro: this.usdcMicro, lamports: this.lamports }; },
    async prepare(to: string, micro: bigint) {
      const signature = SIG(this.prepared++ % 20);
      return { signature, lastValidBlockHeight: 1000, broadcast: async (): Promise<SendOutcome> => { if (this.nextBroadcast === "failed") { this.nextBroadcast = "sent"; return { status: "failed", reason: "Transaction simulation failed: custom program error" }; } this.broadcasts.push({ signature, to, micro }); return { status: "sent", signature, lastValidBlockHeight: 1000 }; } };
    },
    async finality(signature: string) { return this.finalityOf.get(signature) ?? this.defaultFinality; },
  };
  return t as typeof t & TreasuryWallet;
}
async function mockPollar() {
  const srv = createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_1", applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", wallet: { address: SOL, chain: "SOLANA" } } })); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { gw: new PollarServerApi({ secretKey: SECRET, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v3`, log: () => {} }), close: () => new Promise<void>((r) => srv.close(() => r())) };
}
function rpcFor(treasury: string) {
  const txs = new Map<string, any>(); const sigs: { signature: string; err: null }[] = [];
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  const transfer = (sig: string, from: string, micro: number) => { txs.set(sig, { meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(0) }], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(50 * MICRO - micro) }, { accountIndex: 2, mint: MINT, owner: treasury, uiTokenAmount: ui(micro) }] } }); sigs.unshift({ signature: sig, err: null }); };
  return { rpc: { getTransaction: async (s: string) => txs.get(s) ?? null, getGenesisHash: async () => DEVNET_GENESIS, getSignaturesForAddress: async () => sigs, getTokenAccountsByOwner: async (o: string) => (o === treasury ? ["ata"] : []) }, transfer };
}
const hdr = (token: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", authorization: `Bearer ${token}`, ...extra });

async function boot(fake: ReturnType<typeof fakeSupabase>, treasury: TreasuryWallet | null, extra: Record<string, unknown> = {}) {
  const pol = await mockPollar();
  const chain = new MockChain(); const treasuryAddr = base58(chain.treasury().pubkey);
  const r = rpcFor(treasuryAddr);
  const lines: string[] = []; const orig = console.log; console.log = (...a: any[]) => lines.push(a.join(" "));
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 3 }, pollar: pol.gw, rpc: r.rpc, supabase: fake.client, treasury, withdrawWaitMs: 300, ...extra });
  const port = await app.listen(0);
  console.log = orig;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, token: string, body?: unknown, extraHdr: Record<string, string> = {}) => { const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: hdr(token, extraHdr), body: body === undefined ? undefined : JSON.stringify(body) }); const j = await res.json(); return { http: res.status, ...j }; };
  const deposit = async (n: number, micro: number) => { r.transfer(SIG(n + 10), SOL, micro); return api("/api/v1/fiat/confirm", "tok", { signature: SIG(n + 10), amount: micro / MICRO }); };
  const withdraw = (amount: string | number, requestId: string, token = "tok") => api("/api/v1/fiat/withdraw", token, { amount, requestId });
  const balance = async () => (await api("/api/v1/fiat/balance", "tok")).balanceMicro as number;
  const rows = (kind: string) => fake.tables.ledger.filter((l) => l.kind === kind);
  return { app, base, api, deposit, withdraw, balance, rows, lines, close: async () => { await app.close(); await pol.close(); } };
}

test("withdraw: balance drops first, the treasury pays the verified wallet, the signature is recorded before broadcast, a repeated requestId is a no-op", async () => {
  const fake = fakeSupabase(); const tr = fakeTreasury(); const t = await boot(fake, tr);
  try {
    await t.deposit(1, 10 * MICRO);
    const r = await t.withdraw("2.50", "req-00000001");
    assert.equal(r.http, 200); assert.equal(r.status, "sent"); assert.equal(r.micro, 2_500_000); assert.equal(r.balanceMicro, 7_500_000);
    assert.deepEqual(tr.broadcasts.map((b) => [b.to, b.micro]), [[SOL, 2_500_000n]], "paid to the wallet Pollar verified, in base units");
    const kinds = fake.tables.ledger.filter((l) => l.ref.includes("req-00000001")).map((l) => [l.kind, l.micro, l.ref]);
    assert.deepEqual(kinds, [["withdraw", -2_500_000, "withdraw:req-00000001"], ["withdraw-pending", 0, `withdraw:req-00000001:${r.signature}:1000`], ["withdraw-sent", 0, "withdraw:req-00000001"]], "debit, then the signature, then sent");
    // repeat: nothing moves, nothing is sent again, the same answer comes back
    const again = await t.withdraw("2.50", "req-00000001");
    assert.equal(again.status, "sent"); assert.equal(again.signature, r.signature); assert.equal(again.balanceMicro, 7_500_000); assert.equal(tr.broadcasts.length, 1);
    assert.ok(t.lines.length >= 0);
  } finally { await t.close(); }
});

test("withdraw: limits and refusals — guests, minimum, maximum, one in flight, five per hour, decimal text only", async () => {
  const fake = fakeSupabase(); const tr = fakeTreasury(); tr.defaultFinality = "unknown"; const t = await boot(fake, tr);
  try {
    await t.deposit(2, 20 * MICRO);
    const guest = await fetch(`${t.base}/api/v1/fiat/withdraw`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-ABCDEFGH" }, body: JSON.stringify({ amount: "1", requestId: "req-guest-01" }) });
    assert.equal(guest.status, 401); assert.equal((await guest.json()).error, "Sign in with Google to withdraw. Guests play with test funds that cannot be cashed out.");
    assert.equal((await t.withdraw("0.99", "req-min-0001")).error, "The minimum withdrawal is $1.00.");
    assert.equal((await t.withdraw("20.01", "req-max-0001")).error, "You can withdraw at most $20.00.");
    assert.equal((await t.withdraw("abc", "req-bad-0001")).http, 400);
    assert.equal((await t.withdraw("1", "short")).http, 400);
    assert.equal(await t.balance(), 20 * MICRO, "nothing debited by refusals");
    // one in flight: the first waits on an unknown finality; the second is refused meanwhile
    const first = t.withdraw("1", "req-inflight-1");
    await new Promise((r) => setTimeout(r, 60));
    const second = await t.withdraw("1", "req-inflight-2");
    assert.equal(second.http, 409); assert.equal(second.error, "A withdrawal is already in progress. Wait for it to finish.");
    const f = await first; assert.equal(f.http, 202); assert.equal(f.status, "pending");
    tr.defaultFinality = "finalized";
    // five per hour (the pending one counts)
    for (let i = 2; i <= 5; i++) assert.equal((await t.withdraw("1", `req-hour-000${i}`)).status, "sent");
    const sixth = await t.withdraw("1", "req-hour-0006");
    assert.equal(sixth.http, 429); assert.equal(sixth.error, "You've reached five withdrawals this hour. Try again later.");
  } finally { await t.close(); }
});

test("withdraw: paused before any debit when the treasury is short of USDC or SOL, with a log line naming which; not set up without a treasury", async () => {
  const fake = fakeSupabase(); const tr = fakeTreasury(); const t = await boot(fake, tr);
  try {
    await t.deposit(3, 5 * MICRO);
    tr.usdcMicro = 1_000_000n;
    const a = await t.withdraw("2", "req-paused-01"); assert.equal(a.http, 503); assert.equal(a.error, PAUSED);
    tr.usdcMicro = 100n * BigInt(MICRO); tr.lamports = MIN_SOL_LAMPORTS - 1n;
    const b = await t.withdraw("2", "req-paused-02"); assert.equal(b.http, 503); assert.equal(b.error, PAUSED);
    assert.equal(await t.balance(), 5 * MICRO, "nothing debited"); assert.equal(t.rows("withdraw").length, 0);
    assert.ok(t.lines.some((l) => l.startsWith("[fiat] withdrawals paused: treasury USDC short")) && t.lines.some((l) => l.startsWith("[fiat] withdrawals paused: treasury SOL short")));
    assert.ok(!t.lines.some((l) => /secret|keypair|\[\d+,\s*\d+/i.test(l)), "no key material in logs");
  } finally { await t.close(); }
  const none = await boot(fakeSupabase(), null);
  try { await none.deposit(4, 5 * MICRO); const r = await none.withdraw("2", "req-nosetup-1"); assert.equal(r.http, 503); assert.equal(r.error, NOT_SET_UP); assert.equal((await fetch(`${none.base}/healthz`).then((x) => x.json())).withdrawals, "not configured"); } finally { await none.close(); }
});

test("withdraw: a definite failure refunds; an unknown outcome stays pending (no refund), then the sweep settles it as sent or refunds it when expired; a restart picks it up", async () => {
  const fake = fakeSupabase(); const tr = fakeTreasury(); const t = await boot(fake, tr);
  try {
    await t.deposit(5, 10 * MICRO);
    tr.nextBroadcast = "failed";
    const failed = await t.withdraw("3", "req-fail-0001");
    assert.equal(failed.http, 502); assert.equal(failed.status, "refunded"); assert.equal(failed.balanceMicro, 10 * MICRO);
    assert.ok(t.rows("refund").some((l) => l.ref === "refund:withdraw:req-fail-0001" && l.micro === 3 * MICRO));
    // unknown: debited, signature recorded, broadcast, answer pending, nothing refunded
    tr.defaultFinality = "unknown";
    const pend = await t.withdraw("4", "req-pend-0001");
    assert.equal(pend.http, 202); assert.equal(pend.status, "pending"); assert.equal(pend.balanceMicro, 6 * MICRO);
    assert.equal(t.rows("refund").filter((l) => l.ref.includes("req-pend")).length, 0, "never refunded while unknown");
    // later the chain says finalized: the sweep marks it sent, no second broadcast
    tr.finalityOf.set(pend.signature, "finalized");
    assert.deepEqual(await t.app.withdrawals.sweep(), { settled: 1, refunded: 0 });
    assert.ok(t.rows("withdraw-sent").some((l) => l.ref === "withdraw:req-pend-0001")); assert.equal(tr.broadcasts.length, 1, "never sent twice");
    assert.deepEqual(await t.app.withdrawals.sweep(), { settled: 0, refunded: 0 });
    // a second unknown one is left for the next process
    tr.defaultFinality = "unknown";
    const pend2 = await t.withdraw("1", "req-pend-0002"); assert.equal(pend2.status, "pending"); assert.equal(pend2.balanceMicro, 5 * MICRO);
  } finally { await t.close(); }
  // a restart: the pending withdrawal is found in Supabase and settled on startup; an expired one is refunded
  const tr2 = fakeTreasury();
  tr2.finalityOf.set(SIG(2), "finalized");    // req-pend-0002 was the third signature prepared by the previous process
  const t2 = await boot(fake, tr2);
  try {
    assert.ok(t2.rows("withdraw-sent").some((l) => l.ref === "withdraw:req-pend-0002"), "settled on startup");
    assert.equal(await t2.balance(), 5 * MICRO);
    assert.ok(t2.lines.some((l) => l.includes("[fiat] withdrawals on start: 1 settled, 0 refunded")));
    // a new unknown one that then expires: refunded by the sweep, once
    tr2.defaultFinality = "unknown";
    const p2 = await t2.withdraw("1", "req-expire-01"); assert.equal(p2.status, "pending");
    tr2.finalityOf.set(p2.signature, "expired");
    const t3 = await boot(fake, tr2);
    try {
      assert.ok(t3.rows("refund").some((l) => l.ref === "refund:withdraw:req-expire-01" && l.micro === MICRO), "refunded once expired");
      assert.equal(await t3.balance(), 5 * MICRO);
      await t3.app.startup(); assert.equal(t3.rows("refund").filter((l) => l.ref === "refund:withdraw:req-expire-01").length, 1, "refunded once");
    } finally { await t3.close(); }
  } finally { await t2.close(); }
});

test("withdraw: money locked in an open stake has already left the balance, so it cannot be withdrawn", async () => {
  const fake = fakeSupabase(); const tr = fakeTreasury(); const t = await boot(fake, tr);
  try {
    await t.deposit(6, 5 * MICRO);
    const run = await fetch(`${t.base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Oly" }) }).then((x) => x.json());
    const seat = await t.api(`/runs/${run.runId}/seat`, "tok", { action: "take" });
    const word = run.state.hand.find((w: string) => w !== run.state.safe)!;
    const key = Uint8Array.from(Buffer.from((await fetch(`${t.base}/api/v1/treasury`).then((x) => x.json())).pubkeyHex, "hex"));
    await t.api(`/runs/${run.runId}/plant-fiat`, "tok", { commitmentHex: toHex(commitment(word, salt, key)), stake: 3 }, { "x-seat-token": seat.token });
    assert.equal(await t.balance(), 2 * MICRO, "the $3 stake is out of the balance");
    const r = await t.withdraw("3", "req-locked-01");
    assert.equal(r.http, 402); assert.equal(r.error, "You can withdraw at most $2.00.");
    assert.equal(tr.broadcasts.length, 0);
    const ok = await t.withdraw("2", "req-locked-02"); assert.equal(ok.status, "sent"); assert.equal(await t.balance(), 0);
  } finally { await t.close(); }
});

test("treasury: the real signer loads a Solana CLI keypair (path or inline), reports its address, and the mock chain adopts it as the treasury", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.generate();
  const dir = mkdtempSync(join(tmpdir(), "wt-kp-")); const file = join(dir, "treasury.json");
  writeFileSync(file, JSON.stringify([...kp.secretKey]));
  const fromFile = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: file, RPC_URL: "http://127.0.0.1:1" } as any, MINT)!;
  const inline = SolanaTreasury.fromEnv({ TREASURY_KEYPAIR: JSON.stringify([...kp.secretKey]) } as any, MINT)!;
  assert.equal(fromFile.address, kp.publicKey.toBase58()); assert.equal(inline.address, fromFile.address);
  assert.equal(base58(fromFile.publicKeyBytes()), fromFile.address);
  assert.equal(SolanaTreasury.fromEnv({} as any, MINT), null);
  // with the real treasury configured, the mock chain's treasury (deposits, commitments) is that public key
  const pol = await mockPollar();
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: rpcFor("x").rpc, supabase: null, treasury: fromFile });
  const port = await app.listen(0);
  try {
    const t = await fetch(`http://127.0.0.1:${port}/api/v1/treasury`).then((x) => x.json());
    assert.equal(t.address, fromFile.address);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`).then((x) => x.json())).withdrawals, "ready");
    assert.ok(!JSON.stringify(t).includes(String([...kp.secretKey].slice(0, 4))), "no secret anywhere in responses");
  } finally { await app.close(); await pol.close(); const { setMockTreasury } = await import("../src/chain/mock.ts"); const { mockKey } = await import("../src/chain/mock.ts"); setMockTreasury(mockKey("treasury")); }
});
