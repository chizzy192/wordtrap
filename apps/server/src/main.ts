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
import { FiatLedger, FiatError, MockPollar, confirmPayment, pollarFromEnv, toMicro, fromMicro, MICRO, type PollarGateway } from "./fiat.ts";
import { commitment, fromHex, toHex, normalizeWord, isMineable, proRata } from "@wordtrap/shared";

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
  /** "mock" enables /dev/credit, /runs/:id/plant|reveal and /runs/:id/settle. Default from CHAIN env. */
  chainKind?: "mock" | "solana";
  /** Fiat ledger file (atomic JSON). `null` = in-memory. Default data/fiat-ledger.json or FIAT_LEDGER_PATH. */
  ledgerPath?: string | null;
  /** Pollar gateway. Default: PollarHttp when POLLAR_SECRET_KEY is set, else MockPollar (demo credits). */
  pollar?: PollarGateway;
}

export interface App { server: Server; runs: RunManager; ledger: FiatLedger; pollar: PollarGateway; port(): number; listen(port: number): Promise<number>; close(): Promise<void> }
const LEDGER_DEFAULT = fileURLToPath(new URL("../../../data/fiat-ledger.json", import.meta.url));

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

  const chainKind = o.chainKind ?? (process.env.CHAIN === "solana" ? "solana" : "mock");
  const ledger = new FiatLedger(o.ledgerPath === undefined ? (process.env.FIAT_LEDGER_PATH ?? LEDGER_DEFAULT) : o.ledgerPath);
  const pollar = o.pollar ?? pollarFromEnv();

  const runs = new RunManager({
    makeChain,
    cfg: o.cfg,
    oracleUrl: (id) => `http://127.0.0.1:${port}/oracle/risk?run=${id}`,
    onRun: (run: Run) => {
      // Fiat mines: when the treasury's trap fires, pay the viewer who owns it (idempotent per trap).
      run.chain.onTrapFired((e) => { if (ledger.trapOwner(e.trap.id)) ledger.payTrap(e.trap.id, Math.round(e.payout * MICRO)); });
      const crowd = o.sim ? (o.crowd === false || o.crowd === undefined ? true : o.crowd) : o.crowd;
      if (!crowd) return;
      if (!(run.chain instanceof MockChain)) return;          // CROWD is a no-op on a real chain
      startCrowd(run.match, run.chain, crowd === true ? {} : crowd);
    },
  });

  // Pending Pollar payments (gateway unreachable / still processing) are re-verified in the background.
  const retry = setInterval(async () => {
    for (const { id, user } of ledger.pendingPayments()) { try { await confirmPayment(ledger, pollar, id, user); } catch { /* keep pending */ } }
  }, 30_000);
  retry.unref();

  /** I6: who is this viewer? Pollar session token (real mode) or a plain {user} (demo-credit mode). */
  async function identify(req: IncomingMessage, body: Record<string, any>): Promise<string> {
    if (pollar.kind === "pollar") {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
      if (!m) throw new FiatError("sign in with Pollar: send Authorization: Bearer <session token>", 401);
      const s = await pollar.verifySession(m[1].trim());
      if (!s) throw new FiatError("Pollar session invalid or expired", 401);
      return s.userId;
    }
    const u = String(body.user ?? req.headers["x-user"] ?? "").trim().slice(0, 64);
    if (!u) throw new FiatError("demo-credit mode: send {user}", 400);
    return u;
  }
  const bal = (user: string) => ({ user, balanceMicro: ledger.balance(user), balanceUsd: fromMicro(ledger.balance(user)) });

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

      // ---- stake page (apps/stake, built with `npm run build -w apps/stake`) ----
      if (p === "/stake" || p.startsWith("/stake/")) {
        const rel = p === "/stake" || p === "/stake/" ? "index.html" : p.slice("/stake/".length);
        if (rel.includes("..")) return json(res, 400, { error: "bad path" });
        try {
          const body = await readFile(fileURLToPath(new URL(`../../stake/dist/${rel}`, import.meta.url)));
          const type = rel.endsWith(".js") ? "text/javascript" : rel.endsWith(".css") ? "text/css" : rel.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
          res.writeHead(200, { "content-type": type, "cache-control": rel === "index.html" ? "no-store" : "public, max-age=3600" });
          return res.end(body);
        } catch { return json(res, 404, { error: "stake page not built: run `npm run build -w apps/stake`" }); }
      }

      // ---- fiat staking (Pollar): custodial treasury path, see fiat.ts ----
      if (p === "/api/v1/treasury") {
        const chain = runs.current()?.chain ?? (await makeChain());
        const t = chain.treasury();
        return json(res, 200, { setter: t.setter, pubkeyHex: toHex(t.pubkey), chain: chain.kind, mode: pollar.kind === "pollar" ? "pollar" : "demo-credits" });
      }
      if (p === "/api/v1/fiat/balance" && req.method === "GET") {
        const user = await identify(req, Object.fromEntries(url.searchParams));
        return json(res, 200, { ...bal(user), mode: pollar.kind, traps: ledger.trapsOf(user), history: ledger.history(user, 20) });
      }
      if (p === "/api/v1/fiat/confirm" && req.method === "POST") {
        const b = await readJson(req);
        const user = await identify(req, b);
        const paymentId = String(b.paymentId ?? "").trim();
        if (!paymentId) throw new FiatError("paymentId required", 400);
        const r = await confirmPayment(ledger, pollar, paymentId, user);
        return json(res, r.status === "pending" ? 202 : 200, { paymentId, ...r, ...bal(user) });
      }
      if (p === "/dev/credit" && req.method === "POST") {
        if (chainKind !== "mock" || pollar.kind !== "mock") return json(res, 403, { error: "dev credits only exist in mock mode" });
        const b = await readJson(req);
        const user = await identify(req, b);
        const micro = toMicro(Number(b.amount ?? 0));
        const paymentId = String(b.paymentId ?? `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
        (pollar as MockPollar).register(paymentId, user, micro);     // the "payment" the gateway will verify
        const r = await confirmPayment(ledger, pollar, paymentId, user);
        return json(res, 200, { paymentId, ...r, ...bal(user) });
      }
      const fp = /^\/runs\/([^/]+)\/(plant-fiat|back-fiat|reveal-fiat|settle)$/.exec(p);
      if (fp) {
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        const run = runs.get(fp[1]);
        if (!run) return json(res, 404, { error: `unknown run ${fp[1]}` });
        const chain = run.chain;
        const treasury = chain.treasury();
        const b = await readJson(req);
        if (fp[2] === "settle") {
          // Mock only: on devnet `finalize` is an on-chain tx by the authority after the reveal deadline.
          if (!(chain instanceof MockChain)) return json(res, 400, { error: "settle is mock-only; finalize on-chain in solana mode" });
          if (!run.match.finished()) return json(res, 409, { error: "run still live" });
          const already = ledger.settled(run.id);
          if (already) return json(res, 200, { runId: run.id, treasuryPayoutMicro: Object.values(already.paid).reduce((n, x) => n + x, 0), paid: already.paid, duplicate: true });
          // Same math as the program's finalize/claim_backer: treasury's pro-rata share of what is left in the vault.
          const deposit = chain.backers.get(treasury.setter) ?? 0n;
          const treasuryPayout = chain.status === "finalized" ? 0 : Number(proRata(chain.vault, deposit, chain.backerTotal));
          chain.finalize();
          const paid = ledger.settleBackers(run.id, treasuryPayout);
          return json(res, 200, { runId: run.id, treasuryPayoutMicro: treasuryPayout, paid, duplicate: false });
        }
        const user = await identify(req, b);
        if (fp[2] === "plant-fiat") {
          if (!chain.plantTrap) return json(res, 400, { error: "chain cannot plant from the server" });
          const commitmentHex = String(b.commitmentHex ?? "").toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(commitmentHex)) throw new FiatError("commitmentHex must be 32 bytes hex (sha256 of wordtrap:v1|word|salt|TREASURY pubkey)", 400);
          const micro = toMicro(Number(b.stake ?? 0));
          ledger.debit(user, micro, "plant mine", commitmentHex.slice(0, 16));
          let trap;
          try { trap = await chain.plantTrap({ commitmentHex, stake: fromMicro(micro), setter: treasury.setter }); }
          catch (e) { ledger.credit(user, micro, "plant refund", commitmentHex.slice(0, 16)); throw new FiatError(`plant failed: ${(e as Error).message}`, 400); }
          ledger.ownTrap(trap.id, { user, runId: run.id, stake: micro });
          return json(res, 200, { trap, ...bal(user) });
        }
        if (fp[2] === "back-fiat") {
          if (!chain.backByte) return json(res, 400, { error: "chain cannot back from the server" });
          const micro = toMicro(Number(b.amount ?? 0));
          ledger.debit(user, micro, "back byte", run.id);
          try { await chain.backByte(treasury.setter, fromMicro(micro)); }
          catch (e) { ledger.credit(user, micro, "back refund", run.id); throw new FiatError(`back failed: ${(e as Error).message}`, 400); }
          ledger.recordBacker(run.id, user, micro);
          run.match.sync();
          return json(res, 200, { backerTotal: run.match.snapshot().backerTotal, backed: ledger.backersOf(run.id)[user], ...bal(user) });
        }
        // reveal-fiat (I2): the browser kept word+salt; we verify against the commitment and reveal as treasury.
        if (!chain.revealTrap) return json(res, 400, { error: "chain cannot reveal from the server" });
        const trapId = String(b.trapId ?? "");
        const owner = ledger.trapOwner(trapId);
        if (!owner || owner.user !== user) throw new FiatError("not your mine", 403);
        if (owner.status !== "armed") return json(res, 200, { trapId, status: owner.status, payoutMicro: owner.payout ?? 0, ...bal(user) });
        const word = normalizeWord(String(b.word ?? ""));
        const saltHex = String(b.saltHex ?? "").toLowerCase();
        if (!isMineable(word) || !/^[0-9a-f]{64}$/.test(saltHex)) throw new FiatError("word (mineable) and saltHex (32 bytes) required", 400);
        const expect = chain.trapCommitment?.(trapId);
        if (expect && toHex(commitment(word, fromHex(saltHex), treasury.pubkey)) !== expect) throw new FiatError("bad reveal: word or salt does not match this mine's commitment", 400);
        let fired;
        try { fired = await chain.revealTrap({ trapId, word, saltHex, setter: treasury.setter }); }
        catch (e) { throw new FiatError(`reveal rejected: ${(e as Error).message}`, 400); }
        const after = ledger.trapOwner(trapId)!;      // credited by the onTrapFired hook, synchronously
        return json(res, 200, { trapId, status: after.status, payoutMicro: after.payout ?? 0, fired, ...bal(user) });
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
      json(res, e instanceof FiatError ? e.code : 400, { error: (e as Error).message });
    }
  });

  return {
    server, runs, ledger, pollar,
    port: () => port,
    listen: (want: number) => new Promise<number>((r) => server.listen(want, () => { port = (server.address() as any).port; r(port); })),
    close: () => { clearInterval(retry); return new Promise<void>((r) => server.close(() => r())); },
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
  console.log(`fiat: ${app.pollar.kind === "pollar" ? "Pollar (server-verified payments)" : "demo credits (POLLAR_SECRET_KEY unset)"} · ledger ${app.ledger.path ?? "in-memory"} · stake page /stake/`);
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
