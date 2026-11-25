// WordTrap server: the game API Byte Arena's agent plays over HTTPS + spectator feed + x402 oracle.
//   CROWD=1        attach simulated viewers (mines + backers) to EVERY run, including real Byte Arena
//                  runs, without any self-play. Mock chain only. CROWD_SETTERS / CROWD_AGGRESSION /
//                  CROWD_BACKER_USD tune it (defaults in crowd.ts).
//   SIM=1          CROWD=1 plus a local driver that plays runs THROUGH this API (rehearsal only —
//                  never run SIM against real Byte runs)
//   FAST=1         sim driver acts every 600 ms instead of 2.5 s
//   ONE_MATCH=1    sim exits after one run (0 = escaped, 3 = dead)
//   CHAIN=solana   real devnet program (see chain/solana.ts); CROWD is a no-op there
// The spec Byte Arena reads is byte.game.json at the repo root (served at /api/v1/spec).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MockChain } from "./chain/mock.ts";
import type { Chain } from "./chain/types.ts";
import { InvalidActionError, StaleTurnError, type MatchConfig } from "./match.ts";
import { RunManager, type Run } from "./runs.ts";
import { handleRisk, requirement, simVerifier, facilitatorVerifier } from "./oracle.ts";
import { startCrowd, crowdFromEnv, type CrowdOptions } from "./crowd.ts";
import { decide } from "./driver.ts";

const WATCH_HTML = fileURLToPath(new URL("../../watch/index.html", import.meta.url));
const SPEC_JSON = fileURLToPath(new URL("../../../byte.game.json", import.meta.url));
/** Real response header (a <meta> tag does not work): lets app.bytearena.fun iframe the watch page. */
export const FRAME_CSP = "frame-ancestors 'self' https://app.bytearena.fun";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

const ACTION_ROUTES: Record<string, string> = { play: "play_word", hint: "buy_hint", defuse: "defuse_tile", challenge: "challenge_word", pass: "pass_turn" };

export interface AppOptions {
  /** Attach simulated viewers to every run (mock chain only). `sim` implies it. */
  crowd?: boolean | Partial<CrowdOptions>;
  /** Self-play driver loop over the public API (rehearsal only). Implies `crowd`. */
  sim?: boolean;
  cfg?: Partial<MatchConfig>;
  makeChain?: () => Promise<Chain>;
  oraclePayTo?: string;
  network?: string;
  facilitator?: string;
}

export interface App { server: Server; runs: RunManager; port(): number; listen(port: number): Promise<number>; close(): Promise<void> }

async function defaultChain(): Promise<Chain> {
  if (process.env.CHAIN === "solana") {
    const { SolanaChain } = await import("./chain/solana.ts");
    return SolanaChain.fromEnv();
  }
  return new MockChain();
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}
const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error("body must be JSON"); }
}

export function createApp(o: AppOptions = {}): App {
  const makeChain = o.makeChain ?? defaultChain;
  const verifier = o.facilitator ? facilitatorVerifier(o.facilitator) : simVerifier;
  const payTo = o.oraclePayTo ?? "ORACLE_TREASURY_PUBKEY";
  const network = o.network ?? "solana-devnet";
  let port = 0;

  const runs = new RunManager({
    makeChain,
    cfg: o.cfg,
    oracleUrl: (id) => `http://127.0.0.1:${port}/oracle/risk?run=${id}`,
    onRun: (run: Run) => {
      const crowd = o.sim ? (o.crowd === false || o.crowd === undefined ? true : o.crowd) : o.crowd;
      if (!crowd) return;
      if (!(run.chain instanceof MockChain)) return;          // CROWD is a no-op on a real chain
      startCrowd(run.match, run.chain, crowd === true ? {} : crowd);
    },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      if (p === "/") return json(res, 200, { name: "WordTrap", api: "see /api/v1/spec", spec: "/api/v1/spec", health: "/healthz", watch: "/watch/{runId}" });
      if (p === "/healthz") return json(res, 200, { ok: true });

      // ---- spectator page (framed by app.bytearena.fun) ----
      if (p === "/" || p === "/watch" || /^\/watch\/[^/]+$/.test(p)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP, "cache-control": "no-store" });
        return res.end(await readFile(WATCH_HTML));
      }
      if (p === "/api/v1/spec") {
        res.writeHead(200, { "content-type": "application/json", ...CORS });
        return res.end(await readFile(SPEC_JSON));
      }
      if (p === "/api/v1/current") return json(res, 200, { runId: runs.current()?.id ?? null });

      // ---- Byte: start ----
      if (p === "/api/v1/runs" && req.method === "POST") {
        const b = await readJson(req);
        const callsign = String(b.callsign ?? "byte").slice(0, 40) || "byte";
        return json(res, 200, await runs.start(callsign));
      }

      // ---- Byte: state + actions (Bearer auth) ----
      const m = /^\/api\/v1\/runs\/([^/]+)\/(state|play|hint|defuse|challenge|pass)$/.exec(p);
      if (m) {
        const run = runs.get(m[1]);
        if (!run) return json(res, 404, { error: `unknown run ${m[1]}` });
        if (!runs.authorized(run, req.headers.authorization)) return json(res, 401, { error: "unauthorized: send Authorization: Bearer <apiKey> from the start response" });
        if (m[2] === "state") {
          if (req.method !== "GET") return json(res, 405, { error: "state is GET only" });
          return json(res, 200, run.match.snapshot());             // zero side effects
        }
        if (req.method !== "POST") return json(res, 405, { error: "actions are POST only" });
        const b = await readJson(req);
        const turn = b.turn === undefined || b.turn === null ? undefined : Number(b.turn);
        try {
          return json(res, 200, await run.match.act(ACTION_ROUTES[m[2]], { word: b.word === undefined ? undefined : String(b.word), turn }));
        } catch (e) {
          if (e instanceof StaleTurnError) return json(res, 409, { error: e.message, state: e.state });
          if (e instanceof InvalidActionError) return json(res, 400, { error: e.message, state: e.state });
          throw e;
        }
      }

      // ---- spectators: watch page + mobile ----
      const sp = /^\/runs\/([^/]+)\/(spectate|plant|reveal)$/.exec(p);
      if (sp) {
        const run = runs.get(sp[1]);
        if (!run) return json(res, 404, { error: `unknown run ${sp[1]}` });
        if (sp[2] === "spectate") return json(res, 200, runs.spectate(run, Number(url.searchParams.get("after") ?? 0)));
        // Mock-only viewer endpoints (production: viewers sign on-chain txs from mobile/Pollar).
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        if (run.chain.kind !== "mock") return json(res, 400, { error: "sign on-chain from the client in solana mode" });
        const b = await readJson(req);
        if (sp[2] === "plant") return json(res, 200, await run.chain.plantTrap!(b as any));
        return json(res, 200, await run.chain.revealTrap!(b as any));
      }
      if (p === "/suggest") {
        const run = runs.get(url.searchParams.get("run") ?? "") ?? runs.current();
        if (!run) return json(res, 404, { error: "no live run" });
        const s = run.match.snapshot();
        return json(res, 200, { runId: run.id, prompt: s.tiles[s.position]?.prompt ?? null, words: s.hand });
      }

      // ---- x402 risk oracle (unchanged contract) ----
      if (p === "/oracle/risk" && req.method === "POST") {
        const run = runs.get(url.searchParams.get("run") ?? "") ?? runs.current();
        if (!run) return json(res, 404, { error: "no live run to score" });
        return handleRisk(req, res, await readBody(req), {
          verifier, requirement: requirement(`http://${req.headers.host}/oracle/risk`, payTo, network), ctx: () => run.match.riskContext(),
        });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  });

  return {
    server, runs,
    port: () => port,
    listen: (want: number) => new Promise<number>((r) => server.listen(want, () => { port = (server.address() as any).port; r(port); })),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------- SIM: a local driver plays runs through the public API (our Byte rehearsal) ----------

export async function playRunOverHttp(base: string, o: { callsign: string; delayMs: number; log?: (s: string) => void }) {
  const log = o.log ?? (() => {});
  const started = await fetch(`${base}/api/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callsign: o.callsign }) }).then((r) => r.json());
  const { runId, apiKey } = started;
  let state = started.state;
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  log(`run ${runId} · watch ${base}/watch/${runId}`);
  while (state.status === "live") {
    const mv = decide(state);
    const route = Object.entries(ACTION_ROUTES).find(([, a]) => a === mv.action)![0];
    const r = await fetch(`${base}/api/v1/runs/${runId}/${route}`, { method: "POST", headers, body: JSON.stringify({ word: mv.word, turn: state.turn }) });
    const body = await r.json();
    if (!r.ok) { log(`  ${r.status} ${body.error}`); state = body.state ?? (await fetch(`${base}/api/v1/runs/${runId}/state`, { headers }).then((x) => x.json())); continue; }
    state = body;
    const fired = state.traps.filter((t: any) => t.status === "fired").length;
    log(`  T${state.turn - 1} ${mv.action}${mv.word ? ` "${mv.word}"` : ""} → fuse ${state.fuse} · tile ${state.position + 1}/${state.tiles.length} · mines ${fired}/${state.traps.length}`);
    if (state.status === "live") await new Promise((r) => setTimeout(r, o.delayMs));
  }
  return { runId, state };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT ?? 8787);
  const SIM = process.env.SIM === "1";
  const CROWD = SIM || process.env.CROWD === "1";
  const FAST = process.env.FAST === "1";
  const crowd = crowdFromEnv();
  if (CROWD && process.env.CHAIN === "solana") console.warn("CROWD/SIM: simulated viewers only work on the mock chain; CHAIN=solana → crowd disabled");
  const app = createApp({ sim: SIM, crowd: CROWD ? crowd : false, oraclePayTo: process.env.ORACLE_PAYTO, network: process.env.X402_NETWORK, facilitator: process.env.X402_FACILITATOR });
  const port = await app.listen(PORT);
  const mode = SIM ? "SIM (crowd + self-play driver)" : CROWD ? "CROWD (simulated viewers on every run)" : process.env.CHAIN ?? "mock";
  console.log(`WordTrap ${mode} · api http://localhost:${port}/api/v1 · spec /api/v1/spec · watch /watch/<runId>`);
  if (CROWD && process.env.CHAIN !== "solana") console.log(`crowd: ${crowd.setters} setters · aggression ${crowd.aggression} · backers $${crowd.backerUsd}`);
  if (SIM) {
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      const { state } = await playRunOverHttp(base, { callsign: "sim-byte", delayMs: FAST ? 600 : 2500, log: console.log });
      const fired = state.traps.filter((t: any) => t.status === "fired").length;
      console.log(`[run ${state.matchId}] byte ${state.status.toUpperCase()} · turns ${state.turn} · fuse ${state.fuse} · score ${state.score} · mines fired ${fired}/${state.traps.length}`);
      if (process.env.ONE_MATCH === "1") process.exit(state.status === "escaped" ? 0 : 3);
      await new Promise((r) => setTimeout(r, FAST ? 1000 : 15_000));
    }
  }
}
