// Pollar in test mode, with a mocked Pollar Server API (POST /v3/tokens/verify) and a mocked Solana JSON-RPC.
// Sign-in: a valid token signs in (identity = the Solana wallet) and is cached; expired / invalid / wrong-app tokens
// are refused with their sentences. Funding: a finalized USDC transfer to the treasury credits once; the same
// signature twice credits once; a different wallet, destination or amount is refused; unfinalized stays pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, JsonRpc, USDC_MINTS, base58, MICRO } from "../src/fiat.ts";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";     // the player's Pollar wallet (Solana)
const OTHER = "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde";

/** Mocked Pollar Server API v3: only /tokens/verify, secret key in x-pollar-api-key. */
async function mockPollar() {
  const calls: string[] = [];
  const tokens: Record<string, any> = {
    good: { status: 200, body: { code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_1", applicationId: "app_1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), network: "testnet", wallet: { address: WALLET, chain: "SOLANA", custody: "internal" }, profile: { mail: "p@example.com" }, authProvider: "google" } } },
    mainnetuser: { status: 200, body: { code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_2", applicationId: "app_1", expiresAt: Date.now() + 3600_000, network: "mainnet", wallet: WALLET } } },
    expired: { status: 401, body: { code: "SDK_AUTH_TOKEN_EXPIRED", success: false } },
    invalid: { status: 401, body: { code: "SDK_AUTH_INVALID_TOKEN", success: false } },
    otherapp: { status: 403, body: { code: "SDK_TOKEN_WRONG_APPLICATION", success: false } },
  };
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-pollar-api-key"] !== SECRET) return reply(403, { code: "API_KEY_TYPE_NOT_ALLOWED", success: false });
      if (req.method !== "POST" || req.url !== "/v3/tokens/verify") return reply(404, { code: "NOT_FOUND", success: false });
      const { token } = JSON.parse(raw || "{}");
      calls.push(token);
      const t = tokens[token] ?? { status: 401, body: { code: "SDK_AUTH_INVALID_TOKEN", success: false } };
      reply(t.status, t.body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v3`, calls, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Mocked Solana JSON-RPC: getGenesisHash + getTransaction over a fixture map. */
async function mockRpc() {
  const txs = new Map<string, any>();
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      const result = method === "getGenesisHash" ? DEVNET_GENESIS : method === "getTransaction" ? (txs.get(params[0]) ?? null) : null;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, txs, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
/** A jsonParsed SPL transfer as getTransaction returns it: pre/post token balances for sender and destination owners. */
function usdcTransfer(from: string, to: string, amountMicro: number, o: { mint?: string; err?: unknown } = {}) {
  const mint = o.mint ?? MINT;
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  return {
    slot: 1234, blockTime: 1700000000,
    transaction: { message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: "senderAta" }, { pubkey: "destAta" }], instructions: [] }, signatures: ["sig"] },
    meta: {
      err: o.err ?? null, fee: 5000,
      preTokenBalances: [{ accountIndex: 1, mint, owner: from, uiTokenAmount: ui(20 * MICRO) }, { accountIndex: 2, mint, owner: to, uiTokenAmount: ui(0) }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: from, uiTokenAmount: ui(20 * MICRO - amountMicro) }, { accountIndex: 2, mint, owner: to, uiTokenAmount: ui(amountMicro) }],
    },
  };
}
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;   // 88 base58 chars (no 0, O, I, l)

async function boot() {
  const pol = await mockPollar();
  const rpc = await mockRpc();
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: new PollarServerApi({ secretKey: SECRET, baseUrl: pol.url }), rpc: new JsonRpc(rpc.url) });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const treasury = await fetch(`${base}/api/v1/treasury`).then((r) => r.json());
  const call = (path: string, token: string | null, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, base, pol, rpc, treasury, call, close: async () => { await app.close(); await pol.close(); await rpc.close(); } };
}

test("pollar: the treasury says where to pay (address, USDC mint, network), and a valid token signs the wallet in once (cached)", async () => {
  const t = await boot();
  try {
    assert.equal(t.treasury.mode, "pollar");
    assert.equal(t.treasury.network, "devnet");
    assert.equal(t.treasury.usdcMint, MINT);
    assert.equal(t.treasury.address, base58(Uint8Array.from(Buffer.from(t.treasury.pubkeyHex, "hex"))));
    for (let i = 0; i < 3; i++) {
      const r = await t.call("/api/v1/fiat/balance", "good");
      assert.equal(r.status, 200);
      assert.equal((await r.json()).user, WALLET, "identity is the Solana wallet address");
    }
    assert.deepEqual(t.pol.calls, ["good"], "verified once, then served from the cache until expiresAt");
    // no token: guests may still take a seat (no money), anyone else is told to sign in
    const run = await fetch(`${t.base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Oly" }) }).then((r) => r.json());
    assert.equal((await fetch(`${t.base}/runs/${run.runId}/seat`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-ABCDEFGH" }, body: JSON.stringify({ action: "take" }) })).status, 200);
    const anon = await fetch(`${t.base}/api/v1/fiat/balance`);
    assert.equal(anon.status, 401); assert.equal((await anon.json()).error, "Sign in with Google first.");
  } finally { await t.close(); }
});

test("pollar: expired, invalid and wrong-application tokens are refused with their sentences", async () => {
  const t = await boot();
  try {
    const cases = [
      ["expired", 401, "Your Pollar sign-in has expired. Sign in again."],
      ["invalid", 401, "That Pollar sign-in is not valid. Sign in again."],
      ["otherapp", 403, "That sign-in belongs to a different Pollar application. Sign in here again."],
    ] as const;
    for (const [token, status, msg] of cases) {
      const r = await t.call("/api/v1/fiat/balance", token);
      assert.equal(r.status, status, token); assert.equal((await r.json()).error, msg);
    }
    assert.equal(t.pol.calls.filter((c) => c === "expired").length, 1);
    assert.equal((await t.call("/api/v1/fiat/balance", "expired")).status, 401);
    assert.equal(t.pol.calls.filter((c) => c === "expired").length, 2, "refusals are not cached");
  } finally { await t.close(); }
});

test("pollar: a finalized USDC transfer to the treasury credits once; the same signature twice credits once", async () => {
  const t = await boot();
  try {
    t.rpc.txs.set(SIG(1), usdcTransfer(WALLET, t.treasury.address, 5 * MICRO));
    const first = await t.call("/api/v1/fiat/confirm", "good", { signature: SIG(1), amount: 5 });
    assert.equal(first.status, 200);
    const j = await first.json();
    assert.equal(j.status, "credited"); assert.equal(j.credited, true); assert.equal(j.duplicate, false); assert.equal(j.balanceMicro, 5 * MICRO);
    const again = await t.call("/api/v1/fiat/confirm", "good", { signature: SIG(1), amount: 5 }).then((r) => r.json());
    assert.equal(again.status, "credited"); assert.equal(again.duplicate, true); assert.equal(again.balanceMicro, 5 * MICRO, "not credited twice");
    const bal = await t.call("/api/v1/fiat/balance", "good").then((r) => r.json());
    assert.equal(bal.balanceMicro, 5 * MICRO);
    assert.equal(bal.history.filter((h: any) => h.ref === SIG(1)).length, 1);
  } finally { await t.close(); }
});

test("pollar: not finalized yet → pending (202), never credited; credited once it is", async () => {
  const t = await boot();
  try {
    const r = await t.call("/api/v1/fiat/confirm", "good", { signature: SIG(2), amount: 3 });
    assert.equal(r.status, 202);
    const j = await r.json();
    assert.equal(j.status, "pending"); assert.equal(j.balanceMicro, 0);
    assert.deepEqual(t.app.ledger.pendingPayments(), [{ id: SIG(2), user: WALLET, micro: 3 * MICRO }]);
    t.rpc.txs.set(SIG(2), usdcTransfer(WALLET, t.treasury.address, 3 * MICRO));
    const r2 = await t.call("/api/v1/fiat/confirm", "good", { signature: SIG(2), amount: 3 }).then((x) => x.json());
    assert.equal(r2.status, "credited"); assert.equal(r2.balanceMicro, 3 * MICRO);
    assert.deepEqual(t.app.ledger.pendingPayments(), []);
  } finally { await t.close(); }
});

test("pollar: a payment from a different wallet, to a different destination, of a different amount, another mint, or that failed is refused", async () => {
  const t = await boot();
  try {
    const refused = async (sig: string, body: any, status: number, msg: string | RegExp) => {
      const r = await t.call("/api/v1/fiat/confirm", "good", { signature: sig, amount: 5, ...body });
      assert.equal(r.status, status, sig);
      const e = (await r.json()).error;
      typeof msg === "string" ? assert.equal(e, msg) : assert.match(e, msg);
    };
    t.rpc.txs.set(SIG(3), usdcTransfer(OTHER, t.treasury.address, 5 * MICRO));
    await refused(SIG(3), {}, 403, "That payment was not sent from your Pollar wallet.");
    t.rpc.txs.set(SIG(4), usdcTransfer(WALLET, OTHER, 5 * MICRO));
    await refused(SIG(4), {}, 402, "That transaction did not pay USDC to the game treasury.");
    t.rpc.txs.set(SIG(5), usdcTransfer(WALLET, t.treasury.address, 5 * MICRO));
    await refused(SIG(5), { amount: 7 }, 402, "The treasury received $5.00, not $7.00.");
    t.rpc.txs.set(SIG(6), usdcTransfer(WALLET, t.treasury.address, 5 * MICRO, { mint: "So11111111111111111111111111111111111111112" }));
    await refused(SIG(6), {}, 402, "That transaction did not pay USDC to the game treasury.");
    t.rpc.txs.set(SIG(7), usdcTransfer(WALLET, t.treasury.address, 5 * MICRO, { err: { InstructionError: [0, "Custom"] } }));
    await refused(SIG(7), {}, 402, "That transaction failed on Solana. Nothing was credited.");
    await refused("not-a-signature", {}, 400, "That is not a Solana transaction signature.");
    // refused signatures are remembered as failed, never pending, and the balance is untouched
    assert.deepEqual(t.app.ledger.pendingPayments(), []);
    assert.equal((await t.call("/api/v1/fiat/balance", "good").then((r) => r.json())).balanceMicro, 0);
    // a wallet on another Solana network than RPC_URL cannot be credited here
    t.rpc.txs.set(SIG(8), usdcTransfer(WALLET, t.treasury.address, 5 * MICRO));
    const net = await t.call("/api/v1/fiat/confirm", "mainnetuser", { signature: SIG(8), amount: 5 });
    assert.equal(net.status, 409);
    assert.equal((await net.json()).error, "Your Pollar wallet is on Solana mainnet, but this server settles on Solana devnet. That payment cannot be credited here.");
    // a guest has no wallet to pay from
    const guest = await fetch(`${t.base}/api/v1/fiat/confirm`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-ABCDEFGH" }, body: JSON.stringify({ signature: SIG(8), amount: 5 }) });
    assert.equal(guest.status, 401); assert.equal((await guest.json()).error, "Sign in with Google to add funds.");
  } finally { await t.close(); }
});

test("pollar: dev credits are refused in Pollar mode; with the keys unset everything is demo credits", async () => {
  const t = await boot();
  try {
    assert.equal((await t.call("/dev/credit", "good", { amount: 5 })).status, 403);
  } finally { await t.close(); }
  const demo = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 } });
  const port = await demo.listen(0);
  try {
    const tr = await fetch(`http://127.0.0.1:${port}/api/v1/treasury`).then((r) => r.json());
    assert.equal(tr.mode, "demo-credits"); assert.equal(tr.usdcMint, undefined, "no RPC is touched in demo mode");
    const c = await fetch(`http://127.0.0.1:${port}/dev/credit`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-ZZZZZZZZ" }, body: JSON.stringify({ amount: 5 }) }).then((r) => r.json());
    assert.equal(c.balanceMicro, 5 * MICRO);
  } finally { await demo.close(); }
});
