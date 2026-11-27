// A game server with a mocked Pollar and a mock Solana chain, for the funds-page browser test (scripts/browser-stake.mjs,
// Part D). Nothing here touches real money or real services.
//   node scripts/stake-mock-server.ts [port]        game server on <port> (default 8808), mock chain on <port>+1
// The mock chain is one in-memory ledger that plays three parts: the player's Pollar wallet (what the page's mocked
// usePollar() reads and pays from), the Solana RPC the game server confirms deposits on (a transfer becomes finalized
// CREDIT_DELAY_MS after it was sent, like a real devnet confirmation), and the treasury that pays cash-outs (the wallet
// balance moves WALLET_LAG_MS after the broadcast, because a real wallet's balance lags the chain).
// Pollar's token verify is a local HTTP stub: the token "mock-token" is user usr_1 with wallet PLAYER.
import { createServer } from "node:http";
import { createApp } from "../apps/server/src/main.ts";
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { PollarServerApi, USDC_MINTS, base58, MICRO } from "../apps/server/src/fiat.ts";
import type { TreasuryWallet, Finality, SendOutcome } from "../apps/server/src/treasury.ts";

const PORT = Number(process.argv[2] ?? 8808);
const CREDIT_DELAY_MS = Number(process.env.WT_MOCK_CREDIT_DELAY_MS ?? 8000);
const WALLET_LAG_MS = Number(process.env.WT_MOCK_WALLET_LAG_MS ?? 3000);
export const PLAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const START_MICRO = 20 * MICRO;
const MINT = USDC_MINTS.devnet;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const signatureOf = () => "5".repeat(12) + Array.from({ length: 76 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

// ---- the mock chain ----
interface Tx { signature: string; from: string; to: string; micro: number; at: number; visibleAt: number }
const wallets = new Map<string, number>([[PLAYER, START_MICRO]]);
const txs = new Map<string, Tx>();
let sends = 0, hold = false;
const treasuryAddr = base58(new MockChain().treasury().pubkey);
const balance = (a: string) => wallets.get(a) ?? 0;
const ui = (n: number) => ({ amount: String(n), decimals: 6, uiAmount: n / MICRO, uiAmountString: (n / MICRO).toFixed(6) });
/** What getTransaction answers for a visible transfer: the token balance deltas confirmUsdcPayment reads. */
const parsed = (t: Tx) => ({ slot: 1, blockTime: Math.floor(t.at / 1000), meta: { err: null,
  preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: t.from, uiTokenAmount: ui(balance(t.from) + t.micro) }, { accountIndex: 2, mint: MINT, owner: t.to, uiTokenAmount: ui(0) }],
  postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: t.from, uiTokenAmount: ui(balance(t.from)) }, { accountIndex: 2, mint: MINT, owner: t.to, uiTokenAmount: ui(t.micro) }] },
  transaction: { message: { accountKeys: [{ pubkey: t.from, signer: true }, { pubkey: "ata-from" }, { pubkey: "ata-to" }], instructions: [] } } });
const visible = (t: Tx) => Date.now() >= t.visibleAt;
const transfer = (from: string, to: string, micro: number, visibleAt: number) => {
  const t: Tx = { signature: signatureOf(), from, to, micro, at: Date.now(), visibleAt };
  wallets.set(from, balance(from) - micro); txs.set(t.signature, t);
  return t;
};
const rpc = {
  getTransaction: async (s: string) => { const t = txs.get(s); return t && visible(t) ? parsed(t) : null; },
  getGenesisHash: async () => DEVNET_GENESIS,
  getSignaturesForAddress: async () => [...txs.values()].filter((t) => t.to === treasuryAddr && visible(t)).map((t) => ({ signature: t.signature, err: null })),
  getTokenAccountsByOwner: async (owner: string) => (owner === treasuryAddr ? ["treasury-ata"] : []),
};
const treasury: TreasuryWallet = {
  address: treasuryAddr,
  async holdings() { return { usdcMicro: 1_000n * BigInt(MICRO), lamports: 1_000_000_000n }; },
  async prepare(to: string, micro: bigint) {
    const signature = signatureOf();
    return { signature, lastValidBlockHeight: 1000, broadcast: async (): Promise<SendOutcome> => {
      const t: Tx = { signature, from: treasuryAddr, to, micro: Number(micro), at: Date.now(), visibleAt: Date.now() };
      txs.set(signature, t);
      setTimeout(() => wallets.set(to, balance(to) + Number(micro)), WALLET_LAG_MS);   // the wallet's balance lags the chain
      return { status: "sent", signature };
    } };
  },
  async finality(): Promise<Finality> { return hold ? "unknown" : "finalized"; },
} as TreasuryWallet;

// ---- Pollar's token verify, stubbed ----
const verify = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const ok = /"mock-token"/.test(raw);
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { code: "SERVER_TOKEN_VERIFIED", success: true, content: { userId: "usr_1", applicationId: "app", expiresAt: Date.now() + 3_600_000, network: "testnet", wallet: { address: PLAYER, chain: "SOLANA" }, profile: { name: "Emmanuel Ofodile", email: "player@example.com" }, authProvider: "google" } } : { code: "TOKEN_INVALID", success: false }));
  });
});
await new Promise<void>((r) => verify.listen(0, "127.0.0.1", r));
const pollar = new PollarServerApi({ secretKey: "sec_testnet_mock0000000000000000", baseUrl: `http://127.0.0.1:${(verify.address() as any).port}/v3`, log: () => {} });

// ---- the game server ----
const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, pollar, rpc, usdcMint: MINT, supabase: null, treasury, withdrawWaitMs: 300 });
await app.listen(PORT);

// ---- the mock chain over HTTP (what the page's mocked usePollar() talks to) ----
const chain = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const out = (code: number, j: unknown) => { res.writeHead(code, headers); res.end(JSON.stringify(j)); };
  const address = String(url.searchParams.get("address") ?? PLAYER);
  if (url.pathname === "/wallet") return out(200, { usdcMicro: balance(address) });
  if (url.pathname === "/send") {
    sends++;
    const micro = Number(body.micro);
    if (!Number.isInteger(micro) || micro <= 0) return out(400, { error: "bad amount" });
    if (balance(String(body.from)) < micro) return out(400, { error: "insufficient balance" });
    const t = transfer(String(body.from), String(body.to), micro, Date.now() + CREDIT_DELAY_MS);
    return out(200, { signature: t.signature });
  }
  if (url.pathname === "/history") {
    const records = [...txs.values()].filter((t) => t.from === address || t.to === address).sort((a, b) => b.at - a.at).slice(0, 20)
      .map((t) => ({ id: t.signature, hash: t.signature, createdAt: new Date(t.at).toISOString(), summary: t.from === address ? `Sent USDC to ${t.to.slice(0, 4)}…${t.to.slice(-4)}` : "USDC received", details: { amount: String(t.micro), decimals: 6, destination: t.to } }));
    return out(200, { records });
  }
  if (url.pathname === "/credit") { const micro = Number(body.micro ?? 20 * MICRO); await app.players.applyDelta(PLAYER, micro, "credit", `mock-credit-${Date.now()}-${Math.random()}`); return out(200, { balanceMicro: await app.players.balance(PLAYER) }); }
  if (url.pathname === "/runs") { const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: String(body.callsign ?? "Oly") }) }).then((x) => x.json()); return out(200, r); }
  if (url.pathname === "/stats") return out(200, { sends, treasury: treasuryAddr, player: PLAYER, visible: [...txs.values()].filter(visible).map((t) => t.signature) });
  if (url.pathname === "/reset") {   // the chain and the player's game balance start over (the runs stay)
    wallets.clear(); wallets.set(PLAYER, Number(body.usdcMicro ?? START_MICRO)); txs.clear(); sends = 0; hold = false;
    const bal = await app.players.balance(PLAYER); if (bal > 0) await app.players.applyDelta(PLAYER, -bal, "reset", `mock-reset-${Date.now()}`);
    return out(200, { ok: true });
  }
  if (url.pathname === "/hold") { hold = body.on !== false; if (!hold) await app.withdrawals.sweep(); return out(200, { hold }); }   // "unknown" finality until released; the sweep then settles
  return out(404, { error: "no such route" });
});
await new Promise<void>((r) => chain.listen(PORT + 1, "127.0.0.1", r));
console.log(`[stake-mock] game server http://127.0.0.1:${PORT}  mock chain http://127.0.0.1:${PORT + 1}  player ${PLAYER}  treasury ${treasuryAddr}  credit after ${CREDIT_DELAY_MS} ms`);
const stop = async () => { chain.close(); verify.close(); await app.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
