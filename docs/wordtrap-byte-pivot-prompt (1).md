# TASK: Refactor WordTrap so the Byte Arena platform can play it over HTTP

You are working in the `wordtrap` monorepo (Node 22+, native TypeScript — no build step; npm workspaces: `packages/shared`, `apps/server`; plus `apps/watch/index.html`, `apps/mobile`, and a Rust Anchor program in `programs/wordtrap`).

## Context — why this refactor

WordTrap was built with its own internal AI agent ("Byte") driving the game loop in-process. The real hackathon track works the other way around: **Byte is an external AI streamer run by bytearena.fun.** We publish a game API; their agent calls it over HTTP, narrates on their stream, and we only supply the game + a spectator page. Our internal agent must become an optional local *driver* used for testing, not part of the game.

## Byte Arena platform contract (from app.bytearena.fun/api/game-spec — comply exactly)

1. We declare our own endpoints in a JSON `api` block; Byte calls only what is declared.
2. `api.baseUrl` must be public **https** (localhost and private IPs are blocked).
3. **Every response must contain the complete game state as JSON** — the next move must be decidable from that response alone.
4. Moves must come from a closed, enumerable set. No mouse input, no reaction-time dependence. **Therefore: no wall-clock fuse.** The fuse must burn per-action (turn-based), not in real time.
5. `api.start`: one call, no signup. Declares `method`, `path`, `body` (may use `{{callsign}}`). `save` maps variable names to response fields via dotted paths (we save `apiKey` and `runId`).
6. `api.auth`: a header template, e.g. header `Authorization`, value `Bearer {{apiKey}}`, sent on every call after start.
7. `api.state`: GET, **must have zero side effects** (must not advance turns, consume actions, or start timers).
8. `api.actions[]`: each has `name`, `description`, `method`, `path`, `body`, optional `params` (entries: `type`, `choices`, `required`), optional `terminal`/`decision` flags. Byte cannot invent undeclared actions/params. Repeated actions must be idempotent **or reject stale turns with a legible error** — never silently apply a move twice.
9. `api.finish`: required — a state `path` plus `equals` values meaning the run is over. Finished runs must keep answering with their final state (no 404s).
10. `api.result`: `win` (`path` + `equals`, must appear in the final state) and `score` (`path` + `label` ≤ 12 chars, finite number). Ranking: wins first, then score.
11. `api.watchUrl`: URL template using a variable saved at start (e.g. `.../watch/{{runId}}`). Must be served as `text/html`, must **allow framing via a real `Content-Security-Policy: frame-ancestors https://app.bytearena.fun` response header** (a `<meta>` tag does not work), must resolve as a deep link, must not depend on `document.hidden` for polling, no login/audio required. Any third-party API it reads needs CORS.
12. Limits: 400 calls per run, 12 s per call, 64 KB response, 2 h run cap.
13. Bets/predictions are decided from **state JSON, not narration** → mines must trigger on words Byte **plays as moves**, never on narration (we no longer see narration at all).

## Game design after the pivot

- Each tile (prompt) comes with a visible **hand of ~10 word cards** (mix of obvious answers and oddball synonyms). Byte clears a tile by playing `needed` cards one at a time (action `play_word`, param `word` which MUST be one of `state.hand` — validate server-side, reject others with a legible 400 error that includes the current state).
- Viewers mine words (commit-reveal, unchanged). A mine detonates when Byte **plays** that word on a turn ≥ its `armed_turn` (program logic unchanged). Playing cheap obvious cards is tempting; mined ones blow up.
- **Every action advances the turn by exactly 1** (and calls `chain.advanceTurn()`), so mines planted "now" arm on Byte's next action, same as the on-chain rule.
- Fuse is an integer number of units (start 180). Costs: play_word 5, buy_hint 3 (+$0.001 x402), defuse_tile 20 (skip tile, max 2), challenge_word 8 (names a suspected mine WITHOUT playing it; a correct challenge permanently disarms that mine via the existing on-chain challenge bitmap — the word stays in hand and becomes safe to play, which is the galaxy-brain move), pass_turn 10. A detonation burns 22.
- End states: `status` = `"escaped"` (cleared all tiles) or `"dead"` (fuse ≤ 0 or `turn ≥ 60`). `score = position * 100 + max(0, fuse)`.
- `buy_hint` results must be stored INTO the state (`state.hint`: word → risk 0..1) so Byte can read them next call.

## File-by-file tasks

### 1. `packages/shared/src/index.ts`
Keep all hashing/tokenize/trapFired/money helpers EXACTLY as they are (they mirror the Rust program; the test vectors in `packages/shared/test` must keep passing). Replace `BoardState`/`FeedEvent`:

```ts
export type MatchStatus = "live" | "dead" | "escaped";
export interface BoardState {
  matchId: string; matchPda?: string; callsign?: string;
  status: MatchStatus; turn: number; position: number;
  tiles: { prompt: string; cleared: boolean; needed: number; played: string[] }[];
  hand: string[];
  fuse: number; fuseTotal: number;
  hint: Record<string, number> | null;
  spoken: { word: string; turn: number }[];
  challenged: { word: string; turn: number }[];
  traps: TrapView[];
  backerTotal: number; trapTotal: number;
  defusesLeft: number; hintsBought: number; hintSpendUsd: number;
  score: number;
}
export type FeedEvent =
  | { type: "state"; state: BoardState }
  | { type: "action"; action: string; detail: string; turn: number }
  | { type: "hint"; scores: Record<string, number>; costUsd: number; txSig: string }
  | { type: "trap_planted"; trap: TrapView }
  | { type: "trap_fired"; trap: TrapView; payout: number; fuseBurn: number }
  | { type: "match_end"; status: MatchStatus; reason: string };
```
(Drop `turn_window` and `narration` — there are no wall-clock windows anymore and narration lives on Byte's stream.)

### 2. `apps/server/src/content.ts`
Add a `sideways: string[]` field to each `Tile` (move the per-prompt synonym lists out of `agent.ts` `SYNONYMS` into the deck). Add `handFor(tile, extraTics: string[], seed: number): string[]` → deterministic shuffle of ~4 obvious + ~4 sideways + up to 2 extras, deduped, all passing `isMineable`, length ≤ 10.

### 3. NEW `apps/server/src/match.ts` (replaces `engine.ts` — delete `engine.ts`)
Turn-based `Match` class (EventEmitter), constructor `{ matchId, callsign, chain, wallet, oracleUrl, cfg?, seed? }`:
- `async start()`: `chain.initMatch`, set `matchPda` from `chain.address?.()`, emit initial events, allow pre-start planting, then `chain.startMatch()` → turn 1, deal first hand.
- `async act(name: string, params: { word?: string; turn?: number }): Promise<BoardState>`:
  - If run finished → return final state unchanged (idempotent).
  - If `params.turn` is present and ≠ `state.turn` → throw `StaleTurnError("stale turn: current turn is N")` (HTTP layer returns 409 with `{ error, state }`).
  - Apply the action (validate `word ∈ hand` for play_word; for challenge_word any mineable word is allowed but suggest the hand). Record played words on-chain via `chain.recordWords([word], "spoken")`, challenges via `"challenged"`.
  - **After recording, await the reveal hooks** (`match.afterWords: ((words: string[]) => Promise<void>)[]`) so synchronous crowds/relayers can detonate before we build the response — Byte must see the detonation in the SAME response. Then re-sync from `chain.snapshot()`.
  - Advance: `turn++`, `chain.advanceTurn()`, check end conditions, on end call `chain.endMatch(status === "escaped")` and emit `match_end`.
  - Return the full `BoardState`.
- `chain.onTrapFired` → burn 22 fuse, emit `trap_fired`.
- buy_hint: call the existing `buyRisk(oracleUrl, hand, wallet)`, store scores in `state.hint`, emit `hint` event. On oracle failure, still burn the fuse cost and put `hint: {}` with an `action` event noting the failure (never crash the run).
- Keep `riskContext()` as engine.ts had it.

### 4. `apps/server/src/crowd.ts` (rewrite)
Simulated viewers for SIM mode: on each turn event, each setter plants (prob ~0.6) a commitment on a word drawn mostly from the CURRENT hand/obvious list (they can see the hand now — that's the point). Register a reveal hook on `match.afterWords` that synchronously reveals any of its secret words that were just played (respecting `armedTurn`, try/catch for challenged/duplicate). Keep backers seeding the pool.

### 5. NEW `apps/server/src/driver.ts` (replaces `agent.ts` — delete `agent.ts`)
A local stand-in for Byte used by SIM mode and pre-submission rehearsal. Pure function `decide(state: BoardState): { action: string; word?: string }`:
- no hint yet && ≥2 armed traps && fuse > 10 → `buy_hint`
- if hint: top-scored word > 0.85 and turn % 5 === 0 → `challenge_word` on it
- fuse < 35 && defusesLeft > 0 && >1 tile left → `defuse_tile`
- else `play_word` picking the LOWEST hint score from hand (unknown words count as 0.3); every 4th turn deliberately play the most obvious card (Byte must be fallible or the stream is boring)
- fallback `pass_turn`.

### 6. `apps/server/src/main.ts` (rewrite) + NEW `apps/server/src/runs.ts`
`RunManager`: `start(callsign)` → `{ runId (random base36), apiKey (random 32 hex), state }`; keeps `Map<runId, { key, match, chain, events: {seq, e}[] }>` (cap 200 events, keep finished runs in memory for the session). In SIM mode attach `startCrowd` to each new run.

HTTP routes (keep `/oracle/risk` exactly as-is):
- `POST /api/v1/runs` body `{ "callsign": "..." }` → 200 `{ "runId", "apiKey", "state" }` — the ONLY unauthenticated game call.
- `GET /api/v1/runs/:id/state` (Bearer auth) → `BoardState`, zero side effects.
- `POST /api/v1/runs/:id/play` `{ "word": "...", "turn": n? }`, `/hint` `{}`, `/defuse` `{}`, `/challenge` `{ "word": "..." }`, `/pass` `{}` (all Bearer auth) → full `BoardState`; 400 `{ error, state }` for invalid word, 409 for stale turn. Map action names play_word/buy_hint/defuse_tile/challenge_word/pass_turn.
- `GET /runs/:id/spectate?after=seq` (public, CORS `*`) → `{ seq, events, state }` for the watch page and mobile app.
- `GET /api/v1/current` → `{ runId }` of the most recent live run (second-screen mobile).
- `GET /watch/:id` → serves `apps/watch/index.html` with headers `content-type: text/html` AND `Content-Security-Policy: frame-ancestors 'self' https://app.bytearena.fun`.
- `GET /api/v1/spec` → serves `byte.game.json`.
- Mock-mode only: `POST /runs/:id/plant` and `/runs/:id/reveal` (browser demo planter), plus `GET /suggest?run=:id`.
- SIM=1: a loop that creates a run **through its own public HTTP API** (not in-process) and plays it with `driver.decide` every ~600 ms (FAST=1) / 2.5 s — this doubles as our Byte rehearsal harness. ONE_MATCH=1 exits after one run (exit 0 escaped / 3 dead).

### 7. NEW `byte.game.json` (repo root)
```json
{
  "api": {
    "baseUrl": "https://REPLACE-WITH-DEPLOYED-HOST",
    "start": { "method": "POST", "path": "/api/v1/runs", "body": { "callsign": "{{callsign}}" },
               "save": { "apiKey": "apiKey", "runId": "runId" } },
    "auth": { "header": "Authorization", "value": "Bearer {{apiKey}}" },
    "state": { "method": "GET", "path": "/api/v1/runs/{{runId}}/state" },
    "actions": [
      { "name": "play_word", "description": "Play one word card from state.hand onto the current tile. Clearing a tile needs state.tiles[position].needed words. If the word is secretly mined and the mine is armed, it detonates: -22 fuse and the trapper gets paid. Costs 5 fuse.", "method": "POST", "path": "/api/v1/runs/{{runId}}/play", "body": { "word": "{{word}}" }, "params": { "word": { "type": "string", "required": true } }, "decision": true },
      { "name": "buy_hint", "description": "Pay $0.001 USDC via x402 to score every word in state.hand for mine risk (0..1). Scores appear in state.hint. Costs 3 fuse.", "method": "POST", "path": "/api/v1/runs/{{runId}}/hint", "body": {} },
      { "name": "challenge_word", "description": "Type (not play) one word you suspect is mined. If it IS mined and armed, that mine is permanently disarmed and the word becomes safe to play. Costs 8 fuse.", "method": "POST", "path": "/api/v1/runs/{{runId}}/challenge", "body": { "word": "{{word}}" }, "params": { "word": { "type": "string", "required": true } }, "decision": true },
      { "name": "defuse_tile", "description": "Skip the current tile without playing any word. Costs 20 fuse. Only state.defusesLeft uses remain.", "method": "POST", "path": "/api/v1/runs/{{runId}}/defuse", "body": {} },
      { "name": "pass_turn", "description": "Do nothing. Costs 10 fuse.", "method": "POST", "path": "/api/v1/runs/{{runId}}/pass", "body": {} }
    ],
    "finish": { "path": "status", "equals": ["escaped", "dead"] },
    "result": { "win": { "path": "status", "equals": ["escaped"] },
                "score": { "path": "score", "label": "FUSE SCORE" } },
    "watchUrl": "https://REPLACE-WITH-DEPLOYED-HOST/watch/{{runId}}"
  }
}
```

### 8. `apps/watch/index.html`
Rework the page script: take the run id from the URL path (`/watch/:id`; if absent fetch `/api/v1/current`), POLL `GET /runs/:id/spectate?after=<lastSeq>` every 1200 ms with plain `setInterval` (never check `document.hidden`), render exactly as before PLUS a "BYTE'S HAND" row of word cards (mark cards red if that word already detonated, struck-through if challenged). Remove the websocket, the arming-window banner, and the speech-type-on effect tied to narration (show last played words + action detail in the bubble instead). Keep the demo mine-planter panel (point it at `/runs/:id/plant`, auto-reveal via `/runs/:id/reveal` with the armedTurn check that's already there). No login, no audio.

### 9. `apps/mobile/App.tsx`
Replace the websocket with: poll `GET ${SERVER}/api/v1/current` until a runId appears, then poll `GET ${SERVER}/runs/:id/spectate` every 1.5 s. Remove the arming-window countdown (mines can be armed at any time now; they arm next turn). Everything else (MWA combo arming, secure-store salts, auto-detonate revealer) stays.

### 10. Tests — all must pass with `npm test` (node --test, TS natively)
- Keep every existing test green, especially `packages/shared/test/shared.test.ts` hash vectors (if those change you broke program compatibility — revert).
- NEW `apps/server/test/match.test.ts`: with `MockChain` and a seeded Match (inject a fixed tile deck): (a) plant a mine on a hand word, play it one turn later → fuse drops by 22+5, trap status fired, payout correct; (b) `act` with stale `turn` → StaleTurnError and state unchanged; (c) challenge then play the same word → no detonation; (d) drive `decide()` to completion → status ends in escaped|dead, finished run's `act` returns final state unchanged; (e) GET-state purity: calling state twice changes nothing.
- NEW `apps/server/test/api.test.ts`: boot the real HTTP server on an ephemeral port; full flow via fetch: start → state (no side effects) → play invalid word → 400 with legible error AND full state in body → play valid word → 200 full state; wrong Bearer → 401; finished run still answers state.

### 11. Do NOT touch
- `programs/wordtrap/` (Rust), the hash domains (`wordtrap:v1`, `wordtrap:word`), `chain/mock.ts` economics, `chain/types.ts` (except nothing needed), `oracle.ts`, `wallet.ts`, `apps/mobile/src/chain.ts`.
- Keep `scripts/trace.ts` working: rewrite it to run N seeded matches with `decide()` + crowd directly against `Match` (no HTTP) and print the win rate; target Byte winning 25–40% of sims (tune crowd aggression, not the fuse costs, to get there).

### 12. Docs
Update `README.md` (run instructions: `npm run sim` now auto-plays runs through the HTTP API; watch page is per-run at `/watch/:id`) and `docs/HACKATHON_PLAN.md` (Byte track qualification checklist: public https deploy, spec JSON uploaded on bytearena "My games" with a prose game document, one full Byte run completed, public repo + demo video). Add `docs/GAME_SPEC.md`: a one-page prose description of WordTrap written FOR the Byte upload form (what the game is, the five actions, how mines/challenges work, what the fuse costs are, what `hint` means, what finishing looks like).

## Acceptance checklist (run these)
```bash
npm install
npm test                                  # all green
cargo test -p wordtrap                    # untouched, still green
node scripts/trace.ts 30                  # prints win rate in 25–40%
ONE_MATCH=1 FAST=1 SIM=1 node apps/server/src/main.ts   # a full run plays via HTTP and exits
curl -sS -D- -o /dev/null http://localhost:8787/watch/<runId>  # shows text/html + frame-ancestors CSP header
```
Use `cross-env` in package.json scripts so they work on Windows.
