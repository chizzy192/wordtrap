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
import { FiatLedger, FiatError, MockPollar, JsonRpc, GENESIS, USDC_MINTS, base58, isSolanaAddress, confirmPayment, confirmUsdcPayment, reconcileDeposits, pollarFromEnv, toMicro, fromMicro, microToUsd, MICRO, type PollarGateway, type PollarSession, type SolanaRpc } from "./fiat.ts";
import { MemoryMoneyStore, SupabaseMoneyStore, bindWallet, refundOrphans, migrateLedger, type MoneyStore, type SupabaseLike } from "./store.ts";
import { SolanaTreasury, type TreasuryWallet } from "./treasury.ts";
import { Withdrawals } from "./withdrawals.ts";
import { setMockTreasury } from "./chain/mock.ts";
import { DeckManager, FirecrawlClient, MemoryDeckStore, SupabaseDeckStore, loadSources, playable, type FirecrawlLike, type DeckStore, type DeckSource } from "./decks.ts";
import { commitment, fromHex, toHex, normalizeWord, isMineable, proRata } from "@wordtrap/shared";
import { MemoryProfileStore, validateName, shortAddress, type ProfileStore } from "./profiles.ts";
import { RoomError } from "./rooms.ts";

const WATCH_HTML = fileURLToPath(new URL("../../watch/index.html", import.meta.url));
const SPEC_JSON = fileURLToPath(new URL("../../../byte.game.json", import.meta.url));
/** Real response header (a <meta> tag does not work): lets app.bytearena.fun iframe the watch page. */
export const FRAME_CSP = "frame-ancestors 'self' https://app.bytearena.fun";

/**
 * Last line of defence: an unhandled rejection or uncaught exception anywhere (a bot, a timer, a
 * self-fetch) is logged with its stack and the server keeps serving. Every known path is caught
 * closer to the source; this exists so an unknown one never takes a live run down.
 */
export function installProcessGuards(log: (...a: unknown[]) => void = console.error) {
  if ((process as any).__wordtrapGuards) return;
  (process as any).__wordtrapGuards = true;
  process.on("unhandledRejection", (reason) => log("[process] unhandled rejection (server keeps running):", (reason as Error)?.stack ?? reason));
  process.on("uncaughtException", (err) => log("[process] uncaught exception (server keeps running):", err?.stack ?? err));
}
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
  /** Pollar gateway. Default: PollarServerApi when POLLAR_SECRET_KEY is set, else MockPollar (demo credits). */
  pollar?: PollarGateway;
  /** Solana RPC used to confirm USDC payments (Pollar mode). Default: JSON-RPC at RPC_URL (devnet). */
  rpc?: SolanaRpc;
  /** USDC mint for payments. Default: USDC_MINT env, else Circle's mint for the cluster RPC_URL points at. */
  usdcMint?: string;
  /** Durable money for Pollar players: a Supabase client (or a fake in tests). Default: SUPABASE_URL +
   *  SUPABASE_SERVICE_ROLE_KEY from the environment; `null` forces memory. Guests never touch it. */
  supabase?: SupabaseLike | null;
  /** The treasury wallet that pays cash-outs (and receives deposits). Default: TREASURY_KEYPAIR from the environment
   *  (a Solana CLI JSON secret key, path or inline); `null` = withdrawals not set up. Tests hand in a fake. */
  treasury?: TreasuryWallet | null;
  /** How long a withdrawal waits for finality before answering "pending" (tests shorten it). */
  withdrawWaitMs?: number;
  /** Earlier treasury addresses whose deposits still count (default LEGACY_TREASURY_ADDRESSES). */
  legacyTreasuries?: string[];
  /** Daily decks: the Firecrawl client (default from FIRECRAWL_API_KEY; `null` = no web decks), sources, store, today. */
  firecrawl?: FirecrawlLike | null;
  deckSources?: DeckSource[];
  deckStore?: DeckStore;
  deckToday?: () => string;
  /** ADMIN_TOKEN for POST /api/v1/decks/refresh (default from the environment). */
  adminToken?: string | null;
  /** Let the funds page bind the wallet address the SDK shows when Pollar's server side gives none (env
   *  ALLOW_CLIENT_WALLET_BINDING=1). Off by default: a client could bind another player's address first. */
  allowClientWalletBinding?: boolean;
  /** Default spectator delay in seconds for GET /runs/:id/spectate (env SPECTATE_DELAY_SECONDS, default 4). Never affects the Byte API. */
  spectateDelay?: number;
  /** Player display names keyed by wallet address / guest id. Default: in memory. */
  profiles?: ProfileStore;
  /** Test funds a new guest is credited once (env GUEST_START_FUNDS, default 10). Mock chain only. */
  guestStartFunds?: number;
  /** Bots sit in empty seats and plant (needs `crowd`). Default: same as `crowd`. */
  bots?: boolean;
  /** Pace of the house Byte in rooms started from the lobby (ms between moves). Default 2500. */
  houseDelayMs?: number;
}

export interface App { server: Server; runs: RunManager; ledger: FiatLedger; pollar: PollarGateway; store: MoneyStore | null; players: MoneyStore; withdrawals: Withdrawals; port(): number; listen(port: number): Promise<number>; close(): Promise<void>; startup(): Promise<{ refunds: { user: string; micro: number; ref: string }[]; migrated: { deposits: number; balances: number } | null }> }
const LEDGER_DEFAULT = fileURLToPath(new URL("../../../data/fiat-ledger.json", import.meta.url));
/** Whether apps/stake was built with VITE_POLLAR_PUBLISHABLE_KEY: its index.html carries <meta name="wt-pollar" content="configured|missing">. */
async function stakeBuildPollar(): Promise<"configured" | "missing" | "not built"> {
  try {
    const html = await readFile(fileURLToPath(new URL("../../stake/dist/index.html", import.meta.url)), "utf8");
    const m = /<meta name="wt-pollar" content="(configured|missing)">/.exec(html);
    return m ? (m[1] as "configured" | "missing") : "missing";
  } catch { return "not built"; }
}
/** Content types for the static files the server hands out (brand files at the root, the stake build under /stake/). */
const STATIC_TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".json": "application/json", ".woff2": "font/woff2" };

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
/** Reads the body; a client that disconnects mid-request settles the promise instead of leaving the handler hanging. */
const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => resolve(b));
  req.on("error", (e) => reject(new Error(`client disconnected: ${e.message}`)));
  req.on("close", () => { if (!req.complete) reject(new Error("client disconnected before the request finished")); });
});
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
  const envDelay = Number(process.env.SPECTATE_DELAY_SECONDS);
  const spectateDelay = Math.min(20, Math.max(0, o.spectateDelay ?? (Number.isFinite(envDelay) ? envDelay : 4)));
  const profiles = o.profiles ?? new MemoryProfileStore();
  const envGuest = Number(process.env.GUEST_START_FUNDS);
  const guestStartFunds = Math.max(0, o.guestStartFunds ?? (Number.isFinite(envGuest) ? envGuest : 10));
  const ledger = new FiatLedger(o.ledgerPath === undefined ? (process.env.FIAT_LEDGER_PATH ?? LEDGER_DEFAULT) : o.ledgerPath);
  const pollar = o.pollar ?? pollarFromEnv();
  // Money: Pollar players' balances live in Supabase when it is configured; guests' test funds and demo mode stay in memory.
  const memStore = new MemoryMoneyStore(ledger);
  const supa: SupabaseMoneyStore | null = o.supabase === undefined ? SupabaseMoneyStore.fromEnv() : (o.supabase ? new SupabaseMoneyStore(o.supabase) : null);
  const isGuest = (u: string) => pollar.kind !== "pollar" || u.startsWith("guest-");
  const storeFor = (user: string): MoneyStore => (supa && !isGuest(user) ? supa : memStore);
  const players: MoneyStore = supa ?? memStore;                 // Pollar players' wallet + display name
  /** Game-driven money (bounties, payouts, settle marks): applied now, or queued for the retry loop when the store is down. */
  async function moneyLater(user: string, delta: number, kind: string, ref: string) {
    try { await storeFor(user).applyDelta(user, delta, kind, ref); }
    catch (e) { console.warn(`[fiat] ${kind} ${ref} queued for retry:`, (e as Error).message); ledger.enqueue({ user, delta, kind, ref }); }
  }
  // Cash-out: the treasury that signs USDC transfers to players. With a real keypair, the mock chain reports its public
  // key as the treasury, so deposits, commitments and withdrawals all use one address.
  // A bad TREASURY_KEYPAIR never stops the server: it is reported once and withdrawals stay off.
  let treasuryWallet: TreasuryWallet | null = null;
  if (o.treasury !== undefined) treasuryWallet = o.treasury;
  else { try { treasuryWallet = SolanaTreasury.fromEnv(process.env, o.usdcMint ?? process.env.USDC_MINT ?? USDC_MINTS.devnet, console.warn); } catch (e) { console.warn(`TREASURY_KEYPAIR could not be loaded (${(e as Error).message.split("\n")[0].slice(0, 80)}). Withdrawals are off.`); treasuryWallet = null; } }
  if (treasuryWallet instanceof SolanaTreasury && chainKind === "mock") setMockTreasury(treasuryWallet.publicKeyBytes());
  const withdrawals = new Withdrawals({ storeFor, stores: () => (supa ? [supa, memStore] : [memStore]), treasury: () => treasuryWallet, log: console.log, waitMs: o.withdrawWaitMs, pollMs: o.withdrawWaitMs ? Math.min(200, o.withdrawWaitMs) : undefined });
  const planted = new Map<string, any>();                       // plant ref → trap, so a retried plant is not charged or planted twice
  const backCount = new Map<string, number>();                  // runId:user → backs so far (each back gets its own ref)
  const rpc = o.rpc ?? new JsonRpc(process.env.RPC_URL ?? "https://api.devnet.solana.com");
  const allowClientWalletBinding = o.allowClientWalletBinding ?? process.env.ALLOW_CLIENT_WALLET_BINDING === "1";
  const NO_WALLET = "We couldn't find your Solana wallet with Pollar. Sign out and in again, or contact us.";
  /** Which Solana cluster RPC_URL points at (from its genesis hash), cached. */
  let clusterCache: string | null = null;
  const cluster = async () => (clusterCache ??= GENESIS[await rpc.getGenesisHash()] ?? "unknown");
  const usdcMint = async () => o.usdcMint ?? process.env.USDC_MINT ?? ((await cluster()) === "mainnet" ? USDC_MINTS.mainnet : USDC_MINTS.devnet);
  const treasuryAddress = async () => base58((runs.current()?.chain ?? (await makeChain())).treasury().pubkey);
  /** Earlier treasury addresses whose deposits still count (LEGACY_TREASURY_ADDRESSES); never a destination for new payments. */
  const legacyTreasuries = (o.legacyTreasuries ?? (process.env.LEGACY_TREASURY_ADDRESSES ?? "").split(",")).map((a) => a.trim()).filter(isSolanaAddress);
  const usdcCfg = async () => ({ treasury: await treasuryAddress(), mint: await usdcMint(), legacy: legacyTreasuries });

  const crowdOn = !!(o.sim || o.crowd);
  // "Start a room" from the lobby: a run played by the house Byte (the local driver over this same API). Capped.
  const HOUSE_MAX = 3, houseDelayMs = o.houseDelayMs ?? 2500, houseRuns = new Set<string>();
  const houseStop = new AbortController();                      // app.close() stops every house Byte
  const nameCache = new Map<string, string>();        // address -> display name, filled as profiles are read or written
  // Daily decks from the web (Firecrawl → validated tiles → Supabase or memory), refreshed lazily when a run starts.
  const firecrawl: FirecrawlLike | null = o.firecrawl === undefined ? (process.env.FIRECRAWL_API_KEY ? new FirecrawlClient(process.env.FIRECRAWL_API_KEY) : null) : o.firecrawl;
  const decks = new DeckManager({ sources: o.deckSources ?? loadSources(), store: o.deckStore ?? (supa ? new SupabaseDeckStore(supa.db) : new MemoryDeckStore()), firecrawl, log: console.log, today: o.deckToday });
  const adminToken = o.adminToken === undefined ? (process.env.ADMIN_TOKEN || null) : o.adminToken;
  const runs = new RunManager({
    makeChain,
    cfg: o.cfg,
    oracleUrl: (id) => `http://127.0.0.1:${port}/oracle/risk?run=${id}`,
    extraBackers: (id) => Object.keys(ledger.backersOf(id)).length,
    bots: o.bots ?? crowdOn,
    nameOf: (a) => nameCache.get(a) ?? shortAddress(a),
    pickDeck: async () => { const d = await decks.pickForRun(); return d ? { tiles: playable(d), meta: { theme: d.theme, sourceUrl: d.sourceUrl, site: d.site, day: d.day } } : null; },
    onRun: (run: Run) => {
      // Fiat mines: when the treasury's trap fires, pay the viewer who owns it (idempotent per trap).
      run.chain.onTrapFired((e) => {
        // runs inside the chain's event emit; a ledger write failure (disk full, bad file) must not break the reveal
        try {
          const t = ledger.payTrap(e.trap.id, Math.round(e.payout * MICRO));
          if (t) void moneyLater(t.user, t.payout!, "bounty", `${run.id}:bounty:${e.trap.id}`);
        } catch (err) { console.error(`[fiat] could not credit trap ${e.trap.id}:`, (err as Error).stack ?? err); }
      });
      const crowd = o.sim ? (o.crowd === false || o.crowd === undefined ? true : o.crowd) : o.crowd;
      if (!crowd) return;
      if (!(run.chain instanceof MockChain)) return;          // CROWD is a no-op on a real chain
      // four seats: one bot per empty seat, re-evaluated every turn as people sit down and leave
      startCrowd(run.match, run.chain, { setters: 4, ...(crowd === true ? {} : crowd), setterCount: () => run.room.botCount() });
    },
  });

  // Pending payments (not finalized yet / RPC unreachable) are re-checked in the background; never credited until confirmed.
  const retry = setInterval(async () => {
    for (const { id, user, micro } of ledger.pendingPayments()) {
      try {
        if (pollar.kind === "pollar") await confirmUsdcPayment(ledger, rpc, await usdcCfg(), id, { userId: "", wallet: user, network: "", expiresAt: 0 }, micro, storeFor(user));
        else await confirmPayment(ledger, pollar as MockPollar, id, user);
      } catch (e) { console.warn(`[fiat] pending payment ${id} still unconfirmed:`, (e as Error).message); }   // stays pending (or was marked failed), never credited
    }
    try { await withdrawals.sweep(); } catch (e) { console.warn("[fiat] withdrawal sweep failed:", (e as Error).message); }
    for (const job of ledger.queued()) {                          // game money that could not reach the store earlier
      try { await storeFor(job.user).applyDelta(job.user, job.delta, job.kind, job.ref); ledger.dequeue(job.ref); }
      catch (e) { console.warn(`[fiat] ${job.kind} ${job.ref} still queued:`, (e as Error).message); }
    }
  }, 30_000);
  retry.unref();

  /** I6: who is this viewer? Pollar mode: the access token (Authorization: Bearer) is verified with Pollar and the
   *  identity is the Solana wallet address; a guest id (guest-…) is still accepted for seats, names and rooms, but
   *  it can never be funded. Demo-credit mode: a plain {user} / x-user. */
  /** Reconcile this player's uncredited deposits in the background: on every sign-in (a token is verified with
   *  Pollar once, then served from the cache), and when a wallet is bound. */
  function reconcileSoon(session: PollarSession) {
    if (pollar.kind !== "pollar" || !session.wallet) return;
    (async () => { try { await reconcileDeposits(ledger, rpc, await usdcCfg(), session, { log: console.log, store: storeFor(session.wallet!) }); } catch (e) { console.warn("[fiat] reconciliation failed:", (e as Error).message); } })();
  }
  /** The verified session with its Solana wallet: from Pollar's verify content, else Pollar's users lookup (inside
   *  verifySession), else the address this user bound through POST /api/v1/fiat/wallet. */
  async function sessionOf(token: string, o: { allowUnbound?: boolean } = {}): Promise<PollarSession> {
    const s = await pollar.verifySession(token);
    if (!s.wallet && allowClientWalletBinding) s.wallet = (await players.playerByUser(s.userId))?.wallet ?? null;
    if (!s.wallet && !o.allowUnbound) throw new FiatError(allowClientWalletBinding ? "We could not read your Solana wallet from Pollar. Open the funds page so it can send your wallet address." : NO_WALLET, 428);
    if (s.fresh && s.wallet) { players.upsertPlayer({ userId: s.userId, wallet: s.wallet }).catch(() => {}); reconcileSoon(s); }
    return s;
  }
  async function whoIs(req: IncomingMessage, body: Record<string, any>): Promise<{ id: string; session?: PollarSession }> {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const u = String(body.user ?? req.headers["x-user"] ?? "").trim().slice(0, 64);
    if (pollar.kind === "pollar") {
      if (m) { const s = await sessionOf(m[1].trim()); return { id: s.wallet!, session: s }; }
      if (/^guest-[A-Za-z0-9]{4,}$/.test(u)) return { id: u };
      throw new FiatError("Sign in with Google first.", 401);
    }
    if (!u) throw new FiatError("Sign in to play.", 401);
    return { id: u };
  }
  const identify = async (req: IncomingMessage, body: Record<string, any>) => (await whoIs(req, body)).id;
  const bal = async (user: string) => { const m = await storeFor(user).balance(user); return { user, balanceMicro: m, balanceUsd: fromMicro(m) }; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      if (p === "/") return json(res, 200, { name: "WordTrap", api: "see /api/v1/spec", spec: "/api/v1/spec", health: "/healthz", watch: "/watch/{runId}" });
      if (p === "/healthz") {
        // Pollar needs POLLAR_SECRET_KEY on the server at run time and VITE_POLLAR_PUBLISHABLE_KEY in the stake build at
        // build time (the build records only whether it was set). Variable names only, never values.
        const pollarMissing: string[] = [];
        if (pollar.kind !== "pollar") pollarMissing.push("POLLAR_SECRET_KEY");
        const stakeBuild = await stakeBuildPollar();
        if (stakeBuild !== "configured") pollarMissing.push(`VITE_POLLAR_PUBLISHABLE_KEY (build time, apps/stake${stakeBuild === "not built" ? " not built" : ""})`);
        const storage = supa ? ((await supa.ping()) ? "supabase" : "supabase-unreachable") : "memory";
        return json(res, 200, { ok: true, pollar: pollarMissing.length ? "missing" : "configured", pollarMissing, stakeBuild, storage, withdrawals: treasuryWallet ? "ready" : "not configured", decks: await decks.status() });
      }
      if (p === "/api/v1/decks/refresh" && req.method === "POST") {
        // for the operator: refresh today's decks now (one Firecrawl request per source per day still applies)
        if (!adminToken) return json(res, 403, { error: "ADMIN_TOKEN is not configured on this server." });
        if (String(req.headers["x-admin-token"] ?? "") !== adminToken) return json(res, 401, { error: "Admin token required." });
        const r = await decks.refresh(true);
        return json(res, 200, { ...r, decks: await decks.status(), today: (await decks.store.forDay(o.deckToday?.() ?? new Date().toISOString().slice(0, 10))).map((d) => ({ theme: d.theme, site: d.site, tiles: d.tiles.length })) });
      }

      // ---- lobby ----
      if (p === "/play" || p === "/play/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(await readFile(fileURLToPath(new URL("../../watch/play.html", import.meta.url))));
      }
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

      // ---- "Pick a side" page: a second entry of the stake build (apps/stake/side.html) ----
      if (p === "/side" || /^\/side\/[^/]+$/.test(p)) {
        try {
          const body = await readFile(fileURLToPath(new URL("../../stake/dist/side.html", import.meta.url)));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(body);
        } catch { return json(res, 404, { error: "side page not built: run `npm run build -w apps/stake`" }); }
      }
      // ---- stake page (apps/stake, built with `npm run build -w apps/stake`) ----
      if (p === "/stake" || p.startsWith("/stake/")) {
        const rel = p === "/stake" || p === "/stake/" ? "index.html" : p.slice("/stake/".length);
        if (rel.includes("..")) return json(res, 400, { error: "bad path" });
        try {
          const body = await readFile(fileURLToPath(new URL(`../../stake/dist/${rel}`, import.meta.url)));
          const type = STATIC_TYPES[rel.slice(rel.lastIndexOf("."))] ?? "text/html; charset=utf-8";
          res.writeHead(200, { "content-type": type, "cache-control": rel === "index.html" ? "no-store" : "public, max-age=3600" });
          return res.end(body);
        } catch { return json(res, 404, { error: "stake page not built: run `npm run build -w apps/stake`" }); }
      }

      // ---- brand files at the site root (favicons, touch icon, wordmarks, web app manifest) from apps/watch/public ----
      const brand = /^\/([A-Za-z0-9_-]+\.(?:ico|png|webmanifest))$/.exec(p);
      if (brand && req.method === "GET") {
        try {
          const body = await readFile(fileURLToPath(new URL(`../../watch/public/${brand[1]}`, import.meta.url)));
          res.writeHead(200, { "content-type": STATIC_TYPES[brand[1].slice(brand[1].lastIndexOf("."))], "cache-control": "public, max-age=86400" });
          return res.end(body);
        } catch { return json(res, 404, { error: `no such file ${brand[1]}` }); }
      }
      // ---- player identity: shared browser module + display-name profiles ----
      if (p === "/identity.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(await readFile(fileURLToPath(new URL("../../watch/identity.js", import.meta.url))));
      }
      if (p === "/api/v1/profile") {
        const b = req.method === "PUT" || req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams);
        const who = await whoIs(req, b);                 // the wallet address / guest id is the identity
        const address = who.id;
        const durable = !!supa && !isGuest(address);     // Pollar players: players(user_id, wallet, display_name)
        if (req.method === "GET") {
          const name = durable ? (await supa!.player(address))?.name ?? null : (await profiles.get(address))?.name ?? null;
          if (name) nameCache.set(address, name);
          return json(res, 200, { address, name, hasName: !!name });
        }
        if (req.method === "PUT" || req.method === "POST") {
          const v = validateName(b.name);
          if (!v.ok) return json(res, 400, { error: v.error });
          if (durable) await supa!.upsertPlayer({ userId: who.session!.userId, wallet: address, name: v.name });
          else await profiles.put(address, v.name);
          nameCache.set(address, v.name);
          return json(res, 200, { address, name: v.name, hasName: true });
        }
        return json(res, 405, { error: "GET or PUT" });
      }

      // ---- fiat staking (Pollar): custodial treasury path, see fiat.ts ----
      if (p === "/api/v1/treasury") {
        const chain = runs.current()?.chain ?? (await makeChain());
        const t = chain.treasury();
        const base = { setter: t.setter, pubkeyHex: toHex(t.pubkey), address: base58(t.pubkey), chain: chain.kind, mode: pollar.kind === "pollar" ? "pollar" : "demo-credits", guestStartFunds: chainKind === "mock" ? guestStartFunds : 0 };
        if (pollar.kind !== "pollar") return json(res, 200, base);
        // where to pay: the treasury's address and the USDC mint on the cluster this server confirms payments on
        let net = "unknown", mint: string | null = null;
        try { net = await cluster(); mint = await usdcMint(); } catch { /* RPC down: the page says so and retries */ }
        return json(res, 200, { ...base, network: net, usdcMint: mint, withdrawals: treasuryWallet ? "ready" : "not configured" });
      }
      if (p === "/api/v1/fiat/balance" && req.method === "GET") {
        const user = await identify(req, Object.fromEntries(url.searchParams));
        const st = storeFor(user);
        return json(res, 200, { ...(await bal(user)), mode: pollar.kind, storage: st.kind, traps: ledger.trapsOf(user), history: await st.history(user, 20), deposits: await st.depositsOf(user) });
      }
      if (p === "/api/v1/fiat/wallet" && req.method === "POST") {
        // Last resort, used only when Pollar's server side gives no Solana address for this user: the page sends the
        // address the SDK shows and it is bound to the verified Pollar userId once (one per user, one user per address,
        // never changed from here). Deposits still credit only when the on-chain sender equals the bound address.
        if (pollar.kind !== "pollar") return json(res, 404, { error: "Wallet binding only exists in Pollar mode." });
        if (!allowClientWalletBinding) return json(res, 403, { error: NO_WALLET });
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
        if (!m) throw new FiatError("Sign in with Google first.", 401);
        const b = await readJson(req);
        const s = await sessionOf(m[1].trim(), { allowUnbound: true });
        if (s.wallet) return json(res, 200, { wallet: s.wallet, source: (await players.playerByUser(s.userId))?.wallet === s.wallet ? "bound" : "pollar" });
        const address = String(b.address ?? "").trim();
        if (!isSolanaAddress(address)) throw new FiatError("That is not a Solana wallet address.", 400);
        const wallet = await bindWallet(players, s.userId, address);
        console.log(`[fiat] bound a wallet for Pollar user ${s.userId.slice(0, 6)}… (client-claimed; Pollar gave none)`);
        reconcileSoon({ ...s, wallet });
        return json(res, 200, { wallet, source: "bound" });
      }
      if (p === "/api/v1/fiat/withdraw" && req.method === "POST") {
        // Cash-out to the player's own Pollar wallet. The destination is the wallet Pollar verified: never from the client.
        if (pollar.kind !== "pollar") return json(res, 404, { error: "Cash-out only exists with Pollar sign-in." });
        const b = await readJson(req);
        const who = await whoIs(req, b);
        if (!who.session) throw new FiatError("Sign in with Google to withdraw. Guests play with test funds that cannot be cashed out.", 401);
        const r = await withdrawals.request(who.id, who.session.wallet!, b.amount, b.requestId);
        return json(res, r.http, { ...r.body, ...(await bal(who.id)) });
      }
      if (p === "/api/v1/fiat/reconcile" && req.method === "POST") {
        if (pollar.kind !== "pollar") return json(res, 404, { error: "Nothing to reconcile in demo mode." });
        const who = await whoIs(req, {});
        if (!who.session) throw new FiatError("Sign in with Google first.", 401);
        const credited = await reconcileDeposits(ledger, rpc, await usdcCfg(), who.session, { log: console.log, store: storeFor(who.id) });
        return json(res, 200, { credited, ...(await bal(who.id)) });
      }
      if (p === "/api/v1/fiat/confirm" && req.method === "POST") {
        const b = await readJson(req);
        const who = await whoIs(req, b);
        if (pollar.kind === "pollar") {
          // { signature, amount }: the USDC transfer the Pollar wallet just sent; confirmed on Solana before any credit
          if (!who.session) throw new FiatError("Sign in with Google to add funds.", 401);
          const signature = String(b.signature ?? b.paymentId ?? "").trim();
          if (!signature) throw new FiatError("signature required", 400);
          const r = await confirmUsdcPayment(ledger, rpc, await usdcCfg(), signature, who.session, toMicro(b.amount ?? 0), storeFor(who.id));
          return json(res, r.status === "pending" ? 202 : 200, { signature, paymentId: signature, ...r, ...(await bal(who.id)) });
        }
        const paymentId = String(b.paymentId ?? "").trim();
        if (!paymentId) throw new FiatError("paymentId required", 400);
        const r = await confirmPayment(ledger, pollar as MockPollar, paymentId, who.id);
        return json(res, r.status === "pending" ? 202 : 200, { paymentId, ...r, ...(await bal(who.id)) });
      }
      if (p === "/dev/credit" && req.method === "POST") {
        if (chainKind !== "mock" || pollar.kind !== "mock") return json(res, 403, { error: "Test funds aren't available on this server. Sign in with Google to add funds." });
        const b = await readJson(req);
        const user = await identify(req, b);
        const micro = toMicro(Number(b.amount ?? 0));
        const paymentId = String(b.paymentId ?? `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
        (pollar as MockPollar).register(paymentId, user, micro);     // the "payment" the gateway will verify
        const r = await confirmPayment(ledger, pollar as MockPollar, paymentId, user);
        return json(res, 200, { paymentId, ...r, ...(await bal(user)) });
      }
      // ---- rooms and seats (server-enforced; the program knows nothing about seats) ----
      if (p === "/api/v1/rooms" && req.method === "GET") {
        return json(res, 200, runs.listRooms().map((r) => { const s = r.match.snapshot(); return { runId: r.id, code: r.id, byte: s.callsign ?? "Byte", turn: s.turn, fuse: s.fuse, fuseTotal: s.fuseTotal, seats: r.room.view(null, {}).map((v) => v.kind), people: r.room.humans().length }; }));
      }
      if (p === "/api/v1/rooms" && req.method === "POST") {
        const b = await readJson(req);
        const user = await identify(req, b);
        for (const id of houseRuns) if (runs.get(id)?.match.finished()) houseRuns.delete(id);
        if (houseRuns.size >= HOUSE_MAX) return json(res, 409, { error: "Three house rooms are already open. Join one of them instead." });
        const started = await runs.start("House Byte");
        houseRuns.add(started.runId);
        const run = runs.get(started.runId)!;
        const turn = run.match.snapshot().turn;
        const seat = run.room.take(user, turn);                     // the starter is seated first, so they host the room
        runs.announce(run, { type: "seat", action: "take", seat: seat.no, address: user, turn, detail: `${runs.nameOf(user)} opened the room and took seat ${seat.no}.` });
        playRunOverHttp(`http://127.0.0.1:${port}`, { callsign: "House Byte", delayMs: houseDelayMs, existing: started, signal: houseStop.signal })
          .catch((e) => console.warn(`[rooms] house Byte stopped in ${started.runId}:`, (e as Error).message))
          .finally(() => houseRuns.delete(started.runId));
        return json(res, 200, { runId: run.id, code: run.id, seat: seat.no, token: seat.token, host: true, room: run.room.summary(user, Object.fromEntries(nameCache)) });
      }
      if (p === "/api/v1/rooms/quick" && req.method === "POST") {
        const b = await readJson(req);
        const user = await identify(req, b);
        const run = runs.quickPick();
        if (!run) return json(res, 404, { error: "No room has a free seat right now. A room opens when a Byte agent starts a run." });
        const seat = run.room.take(user, run.match.snapshot().turn);
        runs.announce(run, { type: "seat", action: "take", seat: seat.no, address: user, turn: run.match.snapshot().turn, detail: `${runs.nameOf(user)} took seat ${seat.no}.` });
        return json(res, 200, { runId: run.id, code: run.id, seat: seat.no, token: seat.token });
      }
      const rs = /^\/runs\/([^/]+)\/(seat|room)$/.exec(p);
      if (rs && req.method === "POST") {
        const run = runs.get(rs[1]);
        if (!run) return json(res, 404, { error: `unknown run ${rs[1]}` });
        const b = await readJson(req);
        const user = await identify(req, b);
        const turn = run.match.snapshot().turn;
        if (rs[2] === "room") {
          run.room.setPrivate(user, !!b.private);                   // 403 "Only the host can make the room private."
          return json(res, 200, { runId: run.id, private: run.room.private, host: run.room.host === user, room: run.room.summary(user, Object.fromEntries(nameCache)) });
        }
        if (b.action === "leave") {
          const left = run.room.leave(user);
          if (left) runs.announce(run, { type: "seat", action: "leave", seat: left.no, address: user, turn, detail: `${runs.nameOf(user)} left seat ${left.no}.` });
          return json(res, 200, { runId: run.id, seat: null, seats: run.room.view(user, Object.fromEntries(nameCache)), room: run.room.summary(user, Object.fromEntries(nameCache)) });
        }
        if (run.match.finished()) return json(res, 409, { error: "This run is over. Find another room." });
        const had = run.room.seatOf(user);
        const seat = run.room.take(user, turn);                     // 409 with a clear sentence when all four are taken
        if (!had) runs.announce(run, { type: "seat", action: "take", seat: seat.no, address: user, turn, detail: `${runs.nameOf(user)} took seat ${seat.no}.` });
        return json(res, 200, { runId: run.id, seat: seat.no, token: seat.token, host: run.room.host === user, seats: run.room.view(user, Object.fromEntries(nameCache)), room: run.room.summary(user, Object.fromEntries(nameCache)) });
      }

      // Undelayed picker for seated players: which cards exist on this, the next and the later tile. Never played words, hints or traps.
      const pk = /^\/runs\/([^/]+)\/picker$/.exec(p);
      if (pk && req.method === "GET") {
        const run = runs.get(pk[1]);
        if (!run) return json(res, 404, { error: `unknown run ${pk[1]}` });
        if (req.headers["x-user"] || req.headers.authorization) { try { run.room.touch(await identify(req, {}), run.match.snapshot().turn); } catch { /* unauthenticated read is fine */ } }
        return json(res, 200, run.match.picker());
      }
      // Arm several cards in one action: [{ commitmentHex, stake }], each debited from the identity's balance.
      const pb = /^\/runs\/([^/]+)\/plant-fiat-batch$/.exec(p);
      if (pb && req.method === "POST") {
        const run = runs.get(pb[1]);
        if (!run) return json(res, 404, { error: `unknown run ${pb[1]}` });
        if (!run.chain.plantTrap) return json(res, 400, { error: "chain cannot plant from the server" });
        const b = await readJson(req);
        const user = await identify(req, b);
        const items = Array.isArray(b.items) ? b.items.slice(0, 10) : [];
        if (!items.length) throw new FiatError("items required: [{ commitmentHex, stake }]", 400);
        const seat = run.room.check(user, String(req.headers["x-seat-token"] ?? b.seatToken ?? ""));   // only seated players plant
        seat.lastActiveTurn = Math.max(seat.lastActiveTurn, run.match.snapshot().turn);
        const treasury = run.chain.treasury();
        const results: any[] = [];
        for (const it of items) {
          const commitmentHex = String(it.commitmentHex ?? "").toLowerCase();
          try {
            if (!/^[0-9a-f]{64}$/.test(commitmentHex)) throw new FiatError("commitmentHex must be 32 bytes hex", 400);
            const micro = toMicro(Number(it.stake ?? 0));
            const ref = `${run.id}:plant:${commitmentHex.slice(0, 16)}`;
            if (planted.has(ref)) { results.push({ ok: true, trap: planted.get(ref), duplicate: true }); continue; }
            await storeFor(user).applyDelta(user, -micro, "plant", ref);
            let trap;
            try { trap = await run.chain.plantTrap({ commitmentHex, stake: fromMicro(micro), setter: treasury.setter }); }
            catch (e) { await storeFor(user).applyDelta(user, micro, "refund", `refund:${ref}`); throw new FiatError(`plant failed: ${(e as Error).message}`, 400); }
            planted.set(ref, trap);
            ledger.ownTrap(trap.id, { user, runId: run.id, stake: micro });
            results.push({ ok: true, trap });
          } catch (e) { results.push({ ok: false, error: (e as Error).message }); }
        }
        return json(res, 200, { results, turn: run.match.snapshot().turn, ...(await bal(user)) });
      }
      // A signed-in backer's position: stake, share of the pool, and the payout if the run ended now (proRata, like the program).
      const mp = /^\/runs\/([^/]+)\/my-position$/.exec(p);
      if (mp && req.method === "GET") {
        const run = runs.get(mp[1]);
        if (!run) return json(res, 404, { error: `unknown run ${mp[1]}` });
        const user = await identify(req, Object.fromEntries(url.searchParams));
        const s = run.match.snapshot();
        const stakeMicro = ledger.backersOf(run.id)[user] ?? 0;
        const totalMicro = Math.round(s.backerTotal * MICRO);
        const poolMicro = Math.round(s.poolNow * MICRO);
        const payoutNowMicro = stakeMicro > 0 ? Number(proRata(BigInt(poolMicro), BigInt(stakeMicro), BigInt(totalMicro))) : 0;
        const paidMicro = ledger.trapsOf(user, run.id).filter((t) => t.status === "paid").reduce((n, t) => n + (t.payout ?? 0), 0);
        return json(res, 200, {
          runId: run.id, user, backingOpen: s.backingOpen, backingClosed: run.match.backingClosedReason(),
          stakeMicro, stakeUsd: fromMicro(stakeMicro),
          sharePct: totalMicro > 0 ? Math.round((10000 * stakeMicro) / totalMicro) / 100 : 0,
          payoutNowMicro, payoutNowUsd: fromMicro(payoutNowMicro),
          minesPaidMicro: paidMicro, minesPaidUsd: fromMicro(paidMicro),
          poolNowUsd: s.poolNow, backerCount: s.backerCount, status: s.status,
        });
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
          for (const [u, share] of Object.entries(paid)) { if (share > 0) await moneyLater(u, share, "payout", `${run.id}:payout:${u}`); else await moneyLater(u, 0, "settle", `${run.id}:settle:${u}`); }
          for (const t of ledger.trapsIn(run.id)) if (!(t.user in paid)) await moneyLater(t.user, 0, "settle", `${run.id}:settle:${t.user}`);
          return json(res, 200, { runId: run.id, treasuryPayoutMicro: treasuryPayout, paid, duplicate: false });
        }
        const user = await identify(req, b);
        if (fp[2] === "plant-fiat") {
          if (!chain.plantTrap) return json(res, 400, { error: "chain cannot plant from the server" });
          const seat = run.room.check(user, String(req.headers["x-seat-token"] ?? b.seatToken ?? ""));   // only seated players plant
          seat.lastActiveTurn = Math.max(seat.lastActiveTurn, run.match.snapshot().turn);
          const commitmentHex = String(b.commitmentHex ?? "").toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(commitmentHex)) throw new FiatError("commitmentHex must be 32 bytes hex (sha256 of wordtrap:v1|word|salt|TREASURY pubkey)", 400);
          const micro = toMicro(Number(b.stake ?? 0));
          const ref = `${run.id}:plant:${commitmentHex.slice(0, 16)}`;
          if (planted.has(ref)) return json(res, 200, { trap: planted.get(ref), duplicate: true, turn: run.match.snapshot().turn, ...(await bal(user)) });
          await storeFor(user).applyDelta(user, -micro, "plant", ref);
          let trap;
          try { trap = await chain.plantTrap({ commitmentHex, stake: fromMicro(micro), setter: treasury.setter }); }
          catch (e) { await storeFor(user).applyDelta(user, micro, "refund", `refund:${ref}`); throw new FiatError(`plant failed: ${(e as Error).message}`, 400); }
          planted.set(ref, trap);
          ledger.ownTrap(trap.id, { user, runId: run.id, stake: micro });
          return json(res, 200, { trap, turn: run.match.snapshot().turn, ...(await bal(user)) });   // turn: the undelayed truth for "Live from turn N. Byte is on turn M."
        }
        if (fp[2] === "back-fiat") {
          if (!chain.backByte) return json(res, 400, { error: "chain cannot back from the server" });
          const closed = run.match.backingClosedReason();   // server-enforced cut-off (the program itself still accepts back_byte while live)
          if (closed) throw new FiatError(closed, 400);
          const micro = toMicro(Number(b.amount ?? 0));
          const nth = backCount.get(`${run.id}:${user}`) ?? 0;
          const ref = `${run.id}:back:${user}:${nth}`;
          await storeFor(user).applyDelta(user, -micro, "back", ref);
          try { await chain.backByte(treasury.setter, fromMicro(micro)); }
          catch (e) { await storeFor(user).applyDelta(user, micro, "refund", `refund:${ref}`); throw new FiatError(`back failed: ${(e as Error).message}`, 400); }
          backCount.set(`${run.id}:${user}`, nth + 1);
          ledger.recordBacker(run.id, user, micro);
          run.match.sync();
          return json(res, 200, { backerTotal: run.match.snapshot().backerTotal, backed: ledger.backersOf(run.id)[user], ...(await bal(user)) });
        }
        // reveal-fiat (I2): the browser kept word+salt; we verify against the commitment and reveal as treasury.
        if (!chain.revealTrap) return json(res, 400, { error: "chain cannot reveal from the server" });
        const trapId = String(b.trapId ?? "");
        const owner = ledger.trapOwner(trapId);
        if (!owner || owner.user !== user) throw new FiatError("not your mine", 403);
        if (owner.status !== "armed") return json(res, 200, { trapId, status: owner.status, payoutMicro: owner.payout ?? 0, ...(await bal(user)) });
        const word = normalizeWord(String(b.word ?? ""));
        const saltHex = String(b.saltHex ?? "").toLowerCase();
        if (!isMineable(word) || !/^[0-9a-f]{64}$/.test(saltHex)) throw new FiatError("word (mineable) and saltHex (32 bytes) required", 400);
        const expect = chain.trapCommitment?.(trapId);
        if (expect && toHex(commitment(word, fromHex(saltHex), treasury.pubkey)) !== expect) throw new FiatError("bad reveal: word or salt does not match this mine's commitment", 400);
        if (run.match.isSafeWord(word)) throw new FiatError(`"${word}" is the safe card on its tile. Mines on it never fire.`, 400);
        if (run.match.isShielded()) throw new FiatError("This tile is shielded: two mines already went off here. Your mine stays armed for later.", 409);
        let fired;
        try { fired = await chain.revealTrap({ trapId, word, saltHex, setter: treasury.setter }); }
        catch (e) { throw new FiatError(`reveal rejected: ${(e as Error).message}`, 400); }
        const after = ledger.trapOwner(trapId)!;      // credited by the onTrapFired hook, synchronously
        return json(res, 200, { trapId, status: after.status, payoutMicro: after.payout ?? 0, fired, ...(await bal(user)) });
      }

      // ---- spectators: watch page + mobile ----
      const sp = /^\/runs\/([^/]+)\/(spectate|plant|reveal)$/.exec(p);
      if (sp) {
        const run = runs.get(sp[1]);
        if (!run) return json(res, 404, { error: `unknown run ${sp[1]}` });
        if (sp[2] === "spectate") {
          const raw = url.searchParams.get("delay");
          const delay = raw === null || raw === "" || !Number.isFinite(Number(raw)) ? spectateDelay : Number(raw);
          const feed = runs.spectate(run, Number(url.searchParams.get("after") ?? 0), delay, url.searchParams.get("paced") === "1");
          // an authenticated poll counts as activity for the viewer's seat (idle seats are freed after 10 quiet turns)
          let viewer: string | null = null;
          if (req.headers["x-user"] || req.headers.authorization) { try { viewer = await identify(req, {}); run.room.touch(viewer, run.match.snapshot().turn); } catch { viewer = null; } }
          // display names for every player on the board (setters, fiat backers, seats); the page shows short addresses for the rest
          const ids = new Set<string>([...feed.state.traps.map((t) => t.setter), ...Object.keys(ledger.backersOf(run.id)), ...run.room.humans().map((s) => s.address)]);
          const players = { ...(await profiles.names(ids)), ...(supa ? await supa.names([...ids].filter((a) => !isGuest(a))).catch(() => ({})) : {}) };
          for (const [a, n] of Object.entries(players)) nameCache.set(a, n);
          // The room (seats, host, private) is read live, never from the delayed board history: it comes as a
          // top-level `room` object, and is also merged into `state` for older readers. Event snapshots do not
          // carry it, so a replayed event can never put an older room setting back on screen.
          const room = run.room.summary(viewer, players);
          const state = { ...feed.state, seats: room.seats, host: room.host, private: room.private, room: { code: run.id, host: room.you.host, private: room.private } };
          return json(res, 200, { ...feed, state, players, room });
        }
        // Mock-only viewer endpoints (production: viewers sign on-chain txs from mobile/Pollar).
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        if (run.chain.kind !== "mock") return json(res, 400, { error: "sign on-chain from the client in solana mode" });
        const b = await readJson(req);
        if (sp[2] === "plant") return json(res, 200, { ...(await run.chain.plantTrap!(b as any)), turn: run.match.snapshot().turn });
        if (run.match.isSafeWord(normalizeWord(String(b.word ?? "")))) return json(res, 400, { error: `"${b.word}" is the safe card on its tile. Mines on it never fire.` });
        if (run.match.isShielded()) return json(res, 409, { error: "This tile is shielded: two mines already went off here." });
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
      json(res, e instanceof FiatError || e instanceof RoomError ? e.code : 400, { error: (e as Error).message });
    }
  });

  /** On start: copy the old ledger file into Supabase once (idempotent), then refund stakes of runs that never settled. */
  async function startup() {
    let migrated: { deposits: number; balances: number } | null = null;
    if (supa && (Object.keys(ledger.balances()).length || Object.keys(ledger.payments()).length)) {
      try { migrated = await migrateLedger(ledger, supa); if (migrated.deposits || migrated.balances) console.log(`[fiat] migrated ${migrated.deposits} deposits and ${migrated.balances} balances from the ledger file into Supabase`); }
      catch (e) { console.warn("[fiat] migration skipped:", (e as Error).message); }
    }
    try { const w = await withdrawals.sweep(); if (w.settled || w.refunded) console.log(`[fiat] withdrawals on start: ${w.settled} settled, ${w.refunded} refunded`); } catch (e) { console.warn("[fiat] withdrawal sweep failed:", (e as Error).message); }
    const refunds: { user: string; micro: number; ref: string }[] = [];
    const live = new Set(runs.all().filter((r) => !r.match.finished()).map((r) => r.id));
    for (const st of supa ? [supa, memStore] : [memStore]) {
      try { for (const r of await refundOrphans(st, live)) { refunds.push(r); console.log(`[fiat] refunded $${microToUsd(r.micro)} to ${shortAddress(r.user)} for an unfinished run (${r.ref})`); } }
      catch (e) { console.warn(`[fiat] ${st.kind} refunds skipped:`, (e as Error).message); }
    }
    return { refunds, migrated };
  }
  return {
    server, runs, ledger, pollar, store: supa, players, withdrawals, startup,
    port: () => port,
    listen: (want: number) => new Promise<number>((r) => server.listen(want, async () => { port = (server.address() as any).port; await startup(); r(port); })),
    close: () => { clearInterval(retry); houseStop.abort(); return new Promise<void>((r) => server.close(() => r())); },
  };
}

// ---------- SIM: a local driver plays runs through the public API (our Byte rehearsal) ----------

export async function playRunOverHttp(base: string, o: { callsign: string; delayMs: number; log?: (s: string) => void; existing?: { runId: string; apiKey: string; state: any }; signal?: AbortSignal }) {
  const log = o.log ?? (() => {});
  const started = o.existing ?? await fetch(`${base}/api/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callsign: o.callsign }) }).then((r) => r.json());
  const { runId, apiKey } = started;
  let state = started.state;
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  log(`run ${runId} · watch ${base}/watch/${runId}`);
  while (state.status === "live" && !o.signal?.aborted) {
    const mv = decide(state);
    const route = Object.entries(ACTION_ROUTES).find(([, a]) => a === mv.action)![0];
    let r: Response | null = null;
    for (let attempt = 0; attempt < 5 && !r; attempt++) {      // a dropped connection to our own server must not end the run
      try { r = await fetch(`${base}/api/v1/runs/${runId}/${route}`, { method: "POST", headers, body: JSON.stringify({ word: mv.word, turn: state.turn }) }); }
      catch (e) { log(`  fetch failed (${(e as Error).message}), retrying`); await new Promise((res) => setTimeout(res, 500 * (attempt + 1))); }
    }
    if (!r) { log("  the server is not answering; this driver stops"); break; }
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
  installProcessGuards();
  const PORT = Number(process.env.PORT ?? 8787);
  const SIM = process.env.SIM === "1";
  // Bots fill the empty seats by default; CROWD=0 turns them off. (SIM=1 adds the self-play driver.)
  const CROWD = SIM || process.env.CROWD !== "0";
  const FAST = process.env.FAST === "1";
  const crowd = crowdFromEnv();
  if (CROWD && process.env.CHAIN === "solana") console.warn("CROWD/SIM: simulated viewers only work on the mock chain; CHAIN=solana → crowd disabled");
  const app = createApp({ sim: SIM, crowd: CROWD ? crowd : false, oraclePayTo: process.env.ORACLE_PAYTO, network: process.env.X402_NETWORK, facilitator: process.env.X402_FACILITATOR });
  const port = await app.listen(PORT);
  const mode = SIM ? "SIM (crowd + self-play driver)" : CROWD ? "CROWD (simulated viewers on every run)" : process.env.CHAIN ?? "mock";
  console.log(`WordTrap ${mode} · api http://localhost:${port}/api/v1 · spec /api/v1/spec · watch /watch/<runId>`);
  if (app.pollar.kind === "pollar") {
    // never the keys: only which network and mint payments are confirmed on
    const t: any = await fetch(`http://127.0.0.1:${port}/api/v1/treasury`).then((r) => r.json()).catch(() => ({}));
    console.log(`fiat: Pollar sign-in (tokens verified server-side) · USDC payments confirmed on Solana ${t.network ?? "unknown"} · mint ${t.usdcMint ?? "unknown"} · treasury ${t.address ?? "?"} · ledger ${app.ledger.path ?? "in-memory"}`);
  } else console.log(`fiat: demo credits (POLLAR_SECRET_KEY unset) · ledger ${app.ledger.path ?? "in-memory"} · stake page /stake/`);
  if (CROWD && process.env.CHAIN !== "solana") console.log(`crowd: ${crowd.setters} setters · aggression ${crowd.aggression} · backers $${crowd.backerUsd}`);
  if (SIM) {
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      let state: any;
      try { ({ state } = await playRunOverHttp(base, { callsign: "sim-byte", delayMs: FAST ? 600 : 2500, log: console.log })); }
      catch (e) { console.error("sim run failed, starting another:", (e as Error).message); await new Promise((r) => setTimeout(r, 2000)); continue; }
      const fired = state.traps.filter((t: any) => t.status === "fired").length;
      console.log(`[run ${state.matchId}] byte ${state.status.toUpperCase()} · turns ${state.turn} · fuse ${state.fuse} · score ${state.score} · mines fired ${fired}/${state.traps.length}`);
      if (process.env.ONE_MATCH === "1") process.exit(state.status === "escaped" ? 0 : 3);
      await new Promise((r) => setTimeout(r, FAST ? 1000 : 15_000));
    }
  }
}
