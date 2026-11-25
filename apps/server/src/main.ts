// WordTrap server: game loop + watchUrl feed + x402 risk oracle.
//   SIM=1          in-memory chain + simulated crowd (no wallet/RPC needed)
//   CHAIN=solana   real devnet program (see chain/solana.ts)
//   ANTHROPIC_API_KEY set → Byte uses the LLM agent, else scripted agent
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { FeedEvent } from "@wordtrap/shared";
import { MockChain } from "./chain/mock.ts";
import type { Chain } from "./chain/types.ts";
import { Game, type EngineConfig } from "./engine.ts";
import { LlmAgent, ScriptedAgent } from "./agent.ts";
import { SimWallet } from "./wallet.ts";
import { handleRisk, requirement, simVerifier, facilitatorVerifier } from "./oracle.ts";
import { startCrowd } from "./crowd.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SIM = process.env.SIM === "1";
const FAST = process.env.FAST === "1";
const WATCH_HTML = fileURLToPath(new URL("../../watch/index.html", import.meta.url));
const ORACLE_PAYTO = process.env.ORACLE_PAYTO ?? "ORACLE_TREASURY_PUBKEY";
const NETWORK = process.env.X402_NETWORK ?? "solana-devnet";

const fastCfg: Partial<EngineConfig> = { windowMs: 1500, revealGraceMs: 400, fuseMs: 180_000 };

let game: Game;
let chain: Chain;
let lastState: FeedEvent | null = null;
const recent: FeedEvent[] = [];
const clients = new Set<WebSocket>();

function broadcast(e: FeedEvent) {
  if (e.type === "state") lastState = e; else { recent.push(e); if (recent.length > 50) recent.shift(); }
  const msg = JSON.stringify(e);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

async function makeChain(): Promise<Chain> {
  if (process.env.CHAIN === "solana") {
    const { SolanaChain } = await import("./chain/solana.ts");
    return SolanaChain.fromEnv();
  }
  return new MockChain();
}

async function newMatch() {
  chain = await makeChain();
  const agent = process.env.ANTHROPIC_API_KEY ? new LlmAgent(process.env.ANTHROPIC_API_KEY) : new ScriptedAgent();
  game = new Game({
    matchId: `m${Date.now().toString(36)}`, chain, agent, wallet: new SimWallet(),
    oracleUrl: `http://127.0.0.1:${PORT}/oracle/risk`, cfg: FAST ? fastCfg : {},
  });
  recent.length = 0;
  game.on("feed", broadcast);
  if (SIM && chain instanceof MockChain) startCrowd(game, chain);
  return game;
}

async function loop() {
  for (;;) {
    const g = await newMatch();
    const survived = await g.run().catch((e) => { console.error("match crashed", e); return false; });
    console.log(`[match ${g.state.matchId}] byte ${survived ? "SURVIVED" : "DIED"} · turns ${g.state.turn} · fuse ${(g.state.fuseMs / 1000).toFixed(0)}s · traps fired ${g.state.traps.filter((t) => t.status === "fired").length}/${g.state.traps.length}`);
    if (process.env.ONE_MATCH === "1") process.exit(survived ? 0 : 3);
    await new Promise((r) => setTimeout(r, FAST ? 1000 : 15_000));
  }
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}
const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

const verifier = process.env.X402_FACILITATOR ? facilitatorVerifier(process.env.X402_FACILITATOR) : simVerifier;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); return res.end(); }
    if (url.pathname === "/" || url.pathname === "/watch") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(await readFile(WATCH_HTML));
    }
    if (url.pathname === "/suggest") {
      // Swipe deck for TrapSetter: obvious answers for the tile Byte faces + Byte's verbal tics.
      const tile = game.currentTile();
      const freq = new Map<string, number>();
      for (const s of game.state.spoken) freq.set(s.word, (freq.get(s.word) ?? 0) + 1);
      const tics = [...freq].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 6);
      return json(res, 200, { prompt: tile.prompt, words: [...new Set([...tile.obvious, ...tics])] });
    }
    if (url.pathname === "/state") return json(res, 200, { state: lastState, recent });
    if (url.pathname === "/oracle/risk" && req.method === "POST") {
      return handleRisk(req, res, await readBody(req), {
        verifier, requirement: requirement(`http://${req.headers.host}/oracle/risk`, ORACLE_PAYTO, NETWORK), ctx: () => game.riskContext(),
      });
    }
    // Mock-only viewer endpoints (production: viewers sign on-chain txs from mobile/Pollar).
    if (url.pathname.startsWith("/api/") && req.method === "POST") {
      if (chain.kind !== "mock") return json(res, 400, { error: "sign on-chain from the client in solana mode" });
      const b = JSON.parse((await readBody(req)) || "{}");
      if (url.pathname === "/api/plant") return json(res, 200, await chain.plantTrap!(b));
      if (url.pathname === "/api/reveal") return json(res, 200, await chain.revealTrap!(b));
      if (url.pathname === "/api/back") { await chain.backByte!(b.user, b.amount); game.sync(); return json(res, 200, { ok: true }); }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  clients.add(ws);
  if (lastState) ws.send(JSON.stringify(lastState));
  for (const e of recent) ws.send(JSON.stringify(e));
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`WordTrap ${SIM ? "SIM" : process.env.CHAIN ?? "mock"} · watchUrl http://localhost:${PORT}/watch`);
  loop();
});
