// Solana wallet detection from Pollar (every response shape, the /v3/users lookup, the shape-only diagnostic), the
// client-claimed binding as a last resort, exact base-unit amounts, and reconciliation of uncredited deposits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi, findSolanaAddress, shapeOf, isSolanaAddress, toMicro, microToUsd, USDC_MINTS, base58, MICRO, FiatLedger } from "../src/fiat.ts";
import { fmtUsd, fromBase, toBase, unitsOf } from "../../stake/src/units.ts";

const SECRET = "sec_testnet_mock0000000000000000";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = USDC_MINTS.devnet;
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL2 = "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde";
const STELLAR = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SIG = (n: number) => `${"5".repeat(12)}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(75)}`;

test("findSolanaAddress: every shape Pollar might send", () => {
  assert.equal(findSolanaAddress({ wallet: SOL }), SOL, "bare string");
  assert.equal(findSolanaAddress({ wallet: { address: SOL, chain: "SOLANA" } }), SOL, "object with chain");
  assert.equal(findSolanaAddress({ wallet: { public_key: SOL, network: "solana" } }), SOL, "network + public_key");
  assert.equal(findSolanaAddress({ wallet: { solana: SOL, stellar: STELLAR } }), SOL, "keyed by chain");
  assert.equal(findSolanaAddress({ wallet: { SOLANA: { address: SOL }, STELLAR: { address: STELLAR } } }), SOL, "keyed by upper-case chain, nested");
  assert.equal(findSolanaAddress({ wallet: STELLAR, wallets: [{ chain: "STELLAR", address: STELLAR }, { chain: "Solana", address: SOL }] }), SOL, "array under wallets");
  assert.equal(findSolanaAddress({ wallet: [{ type: "stellar", publicKey: STELLAR }, { type: "sol", publicKey: SOL }] }), SOL, "array with type");
  assert.equal(findSolanaAddress({ wallets: [{ network: "stellar", public_key: STELLAR }, { network: "solana", public_key: SOL }] }), SOL, "/v3/users row shape");
  assert.equal(findSolanaAddress({ wallet: { address: SOL } }), SOL, "no chain label but a base58 32-byte address");
  assert.equal(findSolanaAddress({ wallet: { address: STELLAR } }), null, "a Stellar address alone is not Solana");
  assert.equal(findSolanaAddress({ wallet: { chain: "STELLAR", address: SOL2 } }), null, "a chain label that says another chain wins over the format");
  assert.equal(findSolanaAddress({ wallet: { chain: "SOLANA", address: SOL }, wallets: [{ chain: "SOLANA", address: SOL2 }] }), SOL, "labelled under wallet first");
  assert.equal(findSolanaAddress({ wallet: null, wallets: [] }), null);
  assert.ok(isSolanaAddress(SOL) && !isSolanaAddress(STELLAR) && !isSolanaAddress("0OIl") && !isSolanaAddress(SIG(1)));
});

test("shapeOf: key names and types only, strings as lengths", () => {
  const s = shapeOf({ code: "SERVER_TOKEN_VERIFIED", content: { userId: "usr_123", wallet: { address: SOL, chain: "SOLANA" }, wallets: [{ network: "stellar", public_key: STELLAR }], expiresAt: 1700000000, profile: { mail: "a@b.c" }, ok: true, nothing: null } });
  assert.deepEqual(s, { code: "string(21)", content: { userId: "string(7)", wallet: { address: "string(44)", chain: "string(6)" }, wallets: [{ network: "string(7)", public_key: "string(56)" }], expiresAt: "number", profile: { mail: "string(5)" }, ok: "boolean", nothing: null } });
  assert.ok(!JSON.stringify(s).includes(SOL) && !JSON.stringify(s).includes("a@b.c"));
});

/** Mocked Pollar: verify answers with a chosen content; /users answers with chosen rows. Records log lines. */
async function mockPollar(content: any, users: any[] | null) {
  const log: string[] = []; const hits: string[] = [];
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-pollar-api-key"] !== SECRET) return reply(403, { code: "API_KEY_TYPE_NOT_ALLOWED", success: false });
      if (req.method === "POST" && req.url === "/v3/tokens/verify") return reply(200, { code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_1", applicationId: "app", expiresAt: Date.now() + 3600_000, network: "testnet", authProvider: "google", profile: { mail: "p@example.com" }, ...content } });
      if (req.method === "GET" && req.url?.startsWith("/v3/users")) return users ? reply(200, { code: "SERVER_USERS_LIST", success: true, content: { users, total: users.length, page: 1 } }) : reply(404, { code: "NOT_FOUND", success: false });
      reply(404, { code: "NOT_FOUND", success: false });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const gw = new PollarServerApi({ secretKey: SECRET, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v3`, log: (l) => log.push(l) });
  return { gw, log, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("verify: the Solana wallet comes from the verify content, else from GET /v3/users?q=<userId>; the diagnostic logs the shape only", async () => {
  const direct = await mockPollar({ wallet: { address: SOL, chain: "SOLANA" } }, null);
  try { assert.equal((await direct.gw.verifySession("t1")).wallet, SOL); assert.deepEqual(direct.log, []); assert.ok(!direct.hits.some((h) => h.includes("/users"))); } finally { await direct.close(); }
  const viaUsers = await mockPollar({ wallet: STELLAR }, [{ id: "usr_1", email: "p@example.com", wallet_public_key: STELLAR, wallets: [{ network: "stellar", public_key: STELLAR }, { network: "solana", public_key: SOL }] }]);
  try {
    const s = await viaUsers.gw.verifySession("t2");
    assert.equal(s.wallet, SOL);
    assert.ok(viaUsers.hits.some((h) => h.startsWith("GET /v3/users?q=usr_1")), "users lookup by id");
    assert.equal(viaUsers.log.length, 1); assert.ok(viaUsers.log[0].startsWith("[fiat] verify shape (no Solana wallet found): "));
    const shape = JSON.parse(viaUsers.log[0].slice("[fiat] verify shape (no Solana wallet found): ".length));
    assert.equal(shape.content.wallet, `string(${STELLAR.length})`);
    assert.ok(!viaUsers.log[0].includes(STELLAR) && !viaUsers.log[0].includes("p@example.com") && !viaUsers.log[0].includes("t2") && !viaUsers.log[0].includes(SECRET), "no values in the diagnostic");
  } finally { await viaUsers.close(); }
  const none = await mockPollar({ wallet: STELLAR }, [{ id: "usr_1", wallets: [{ network: "stellar", public_key: STELLAR }] }]);
  try { assert.equal((await none.gw.verifySession("t3")).wallet, null); assert.ok(none.log.some((l) => l.includes("users lookup row shape"))); } finally { await none.close(); }
});

/** Mocked RPC with transfers to the treasury's token account. */
function mockRpc(treasury: string) {
  const txs = new Map<string, any>(); const sigs: { signature: string; err: unknown }[] = [];
  const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
  const transfer = (sig: string, from: string, to: string, micro: number) => {
    txs.set(sig, { slot: 1, blockTime: 1700000000, transaction: { message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: "fromAta" }, { pubkey: "treasuryAta" }], instructions: [] }, signatures: [sig] }, meta: { err: null, fee: 5000, preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(20 * MICRO) }, { accountIndex: 2, mint: MINT, owner: to, uiTokenAmount: ui(0) }], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: ui(20 * MICRO - micro) }, { accountIndex: 2, mint: MINT, owner: to, uiTokenAmount: ui(micro) }] } });
    if (to === treasury) sigs.unshift({ signature: sig, err: null });
  };
  const calls: string[] = [];
  const rpc = {
    async getTransaction(sig: string) { calls.push(`getTransaction ${sig.slice(0, 14)}`); return txs.get(sig) ?? null; },
    async getGenesisHash() { return DEVNET_GENESIS; },
    async getSignaturesForAddress(address: string, limit: number) { calls.push(`getSignaturesForAddress ${address}`); return address === "treasuryAta" ? sigs.slice(0, limit) : []; },
    async getTokenAccountsByOwner(owner: string, mint: string) { calls.push(`getTokenAccountsByOwner ${owner === treasury ? "treasury" : owner}`); return owner === treasury && mint === MINT ? ["treasuryAta"] : []; },
  };
  return { rpc, transfer, calls };
}
const hdr = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

test("no Solana wallet and binding off (the default): a plain sentence, and POST /api/v1/fiat/wallet is refused", async () => {
  const pol = await mockPollar({ wallet: STELLAR }, [{ id: "usr_1", wallets: [{ network: "stellar", public_key: STELLAR }] }]);
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: mockRpc("x").rpc });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr("tok") });
    assert.equal(r.status, 428);
    assert.equal((await r.json()).error, "We couldn't find your Solana wallet with Pollar. Sign out and in again, or contact us.");
    const bind = await fetch(`${base}/api/v1/fiat/wallet`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ address: SOL }) });
    assert.equal(bind.status, 403);
    assert.equal((await bind.json()).error, "We couldn't find your Solana wallet with Pollar. Sign out and in again, or contact us.");
    assert.equal(app.ledger.walletOf("usr_1"), null, "nothing bound");
    // even a binding left in the ledger file is ignored while the flag is off
    app.ledger.bindWallet("usr_1", SOL);
    assert.equal((await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr("tok") })).status, 428);
  } finally { await app.close(); await pol.close(); }
});

test("binding (ALLOW_CLIENT_WALLET_BINDING=1 only): the page's address is bound once per Pollar user, one user per address, never changed from the client; deposits credit only from that address", async () => {
  const pol = await mockPollar({ wallet: STELLAR }, [{ id: "usr_1", wallets: [{ network: "stellar", public_key: STELLAR }] }]);   // Pollar gives no Solana wallet
  const lines: string[] = []; const orig = console.log; console.log = (...a: any[]) => lines.push(a.join(" "));
  const treasuryOf = (hex: string) => base58(Uint8Array.from(Buffer.from(hex, "hex")));
  let app: any;
  try {
    const chain = new MockChain(); const treasury = treasuryOf(Buffer.from(chain.treasury().pubkey).toString("hex"));
    const m = mockRpc(treasury);
    app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: m.rpc, allowClientWalletBinding: true });
    const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
    // without a bound wallet, money calls answer 428 so the page sends the SDK's address
    const r428 = await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr("tok") });
    assert.equal(r428.status, 428);
    assert.equal((await r428.json()).error, "We could not read your Solana wallet from Pollar. Open the funds page so it can send your wallet address.");
    assert.equal((await fetch(`${base}/api/v1/fiat/wallet`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ address: "nope" }) })).status, 400);
    const bound = await fetch(`${base}/api/v1/fiat/wallet`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ address: SOL }) }).then((r) => r.json());
    assert.deepEqual(bound, { wallet: SOL, source: "bound" });
    assert.equal((await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr("tok") }).then((r) => r.json())).user, SOL, "identity is the bound address");
    // never changeable from the client
    const change = await fetch(`${base}/api/v1/fiat/wallet`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ address: SOL2 }) });
    assert.equal(change.status, 200); assert.equal((await change.json()).wallet, SOL, "a second claim does not change the binding");
    assert.equal(app.ledger.walletOf("usr_1"), SOL);
    // one user per address
    assert.throws(() => app.ledger.bindWallet("usr_2", SOL), /already linked to another Pollar account/);
    assert.throws(() => app.ledger.bindWallet("usr_1", SOL2), /already linked to a different wallet/);
    // deposits: only the on-chain sender equal to the bound address credits
    m.transfer(SIG(1), SOL2, treasury, 5 * MICRO);
    const other = await fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: SIG(1), amount: 5 }) });
    assert.equal(other.status, 403); assert.equal((await other.json()).error, "That payment was not sent from your Pollar wallet.");
    m.transfer(SIG(2), SOL, treasury, 5 * MICRO);
    const mine = await fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: SIG(2), amount: 5 }) }).then((r) => r.json());
    assert.equal(mine.status, "credited"); assert.equal(mine.balanceMicro, 5 * MICRO);
    assert.ok(lines.some((l) => l.startsWith("[fiat] bound a wallet for Pollar user usr_1")), "binding is logged without the address");
    assert.ok(!lines.some((l) => l.includes(SOL)), "no address in the binding log line");
  } finally { console.log = orig; await app?.close(); await pol.close(); }
});

test("amounts: exact base units on the page and the server; 5000000 → $5.00, 250000 → $0.25", () => {
  assert.equal(fmtUsd(5000000), "$5.00"); assert.equal(fmtUsd("250000"), "$0.25"); assert.equal(fmtUsd(123456), "$0.12"); assert.equal(fmtUsd(0), "$0.00"); assert.equal(fmtUsd("1500000000", 9), "$1.50");
  assert.equal(fromBase("5000000"), "5"); assert.equal(fromBase(250000), "0.25"); assert.equal(fromBase("1", 6), "0.000001");
  assert.equal(toBase("5"), 5000000); assert.equal(toBase("0.25"), 250000); assert.equal(toBase("0.1234567"), null); assert.equal(unitsOf(5), 5000000);
  assert.equal(toMicro("0.29"), 290000); assert.equal(toMicro(5), 5000000); assert.equal(toMicro("1.1"), 1100000); assert.throws(() => toMicro("0.1234567")); assert.throws(() => toMicro("abc")); assert.throws(() => toMicro(-1 as any));
  assert.equal(microToUsd(5000000n), "5.00"); assert.equal(microToUsd(7_123_456), "7.12");
});

test("deposits: a refused credit is retried and credits once; reconciliation credits once, ignores another wallet, and compares base units as integers", async () => {
  const pol = await mockPollar({ wallet: { address: SOL, chain: "SOLANA" } }, null);
  const chain = new MockChain(); const treasury = base58(chain.treasury().pubkey);
  const m = mockRpc(treasury);
  const lines: string[] = []; const orig = console.log; console.log = (...a: any[]) => lines.push(a.join(" "));
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: pol.gw, rpc: m.rpc });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const confirm = (sig: string, amount: number | string) => fetch(`${base}/api/v1/fiat/confirm`, { method: "POST", headers: hdr("tok"), body: JSON.stringify({ signature: sig, amount }) });
  try {
    // refused-then-retried: the first call comes before the transfer is finalized (202), the retry credits, once
    const first = await confirm(SIG(3), "5"); assert.equal(first.status, 202);
    m.transfer(SIG(3), SOL, treasury, 5_000_000);
    const second = await confirm(SIG(3), "5").then((r) => r.json()); assert.equal(second.status, "credited"); assert.equal(second.credited, true); assert.equal(second.micro, 5_000_000);
    const third = await confirm(SIG(3), "5").then((r) => r.json()); assert.equal(third.duplicate, true); assert.equal(third.balanceMicro, 5_000_000);
    // base units: "0.25" is compared as 250000n, never a float; a mismatched amount is refused with exact dollars
    m.transfer(SIG(4), SOL, treasury, 250_000);
    assert.equal((await confirm(SIG(4), "0.25").then((r) => r.json())).micro, 250_000);
    m.transfer(SIG(5), SOL, treasury, 5_000_000);
    const wrong = await confirm(SIG(5), "4.99"); assert.equal(wrong.status, 402); assert.equal((await wrong.json()).error, "The treasury received $5.00, not $4.99.");
    // reconciliation: two uncredited deposits from this wallet (one of them the "refused" SIG(5)), one from another wallet
    m.transfer(SIG(6), SOL, treasury, 2_000_000);
    m.transfer(SIG(7), SOL2, treasury, 9_000_000);
    const rec = await fetch(`${base}/api/v1/fiat/reconcile`, { method: "POST", headers: hdr("tok") }).then((r) => r.json());
    assert.deepEqual(rec.credited.map((c: any) => [c.signature, c.micro]).sort(), [[SIG(5), 5_000_000], [SIG(6), 2_000_000]], "SIG(5) (a real $5.00 deposit the page mis-claimed as $4.99) and SIG(6) are credited with their on-chain amounts; SIG(7) is another wallet's");
    assert.equal(rec.balanceMicro, 5_000_000 + 250_000 + 5_000_000 + 2_000_000);
    const again = await fetch(`${base}/api/v1/fiat/reconcile`, { method: "POST", headers: hdr("tok") }).then((r) => r.json());
    assert.deepEqual(again.credited, [], "reconciliation credits once");
    assert.equal(again.balanceMicro, 12_250_000);
    assert.ok(lines.some((l) => l.startsWith(`[fiat] reconciled ${SIG(6)} +$2.00 for wallet ${SOL.slice(0, 4)}…`)), "the Render log line");
    assert.ok(m.calls.includes("getTokenAccountsByOwner treasury") && m.calls.includes("getSignaturesForAddress treasuryAta"));
    // the other wallet's deposit is still available to its own sender (not marked failed for everyone)
    assert.equal(app.ledger.payment(SIG(7)), undefined);
    // automatic reconciliation on sign-in: a fresh token (new verify) picks up a deposit with no page call
    m.transfer(SIG(8), SOL, treasury, 1_000_000);
    await fetch(`${base}/api/v1/fiat/balance`, { headers: hdr("tok-fresh") });
    for (let i = 0; i < 40 && app.ledger.balance(SOL) < 13_250_000; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.ledger.balance(SOL), 13_250_000, "credited on sign-in without a manual step");
  } finally { console.log = orig; await app.close(); await pol.close(); }
});

test("ledger file: wallets survive a reload", () => {
  const l = new FiatLedger(null);
  assert.equal(l.bindWallet("usr_9", SOL), SOL); assert.equal(l.walletOf("usr_9"), SOL); assert.equal(l.walletOf("usr_x"), null);
});
