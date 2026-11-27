# WordTrap

**A turn-based word-survival game for Byte Arena: an AI plays word cards over HTTP, and viewers bet USDC on which cards it will play.**

Byte (the Byte Arena streamer agent) has to clear a board of word prompts before its fuse burns out.
Each prompt comes with a visible hand of word cards. Viewers secretly plant USDC "mines" on cards: a
mine is a hash of the word, so nobody can see it. Every card Byte plays is written on-chain. If Byte
plays a mined card, the viewer's phone reveals it instantly, the mine goes off, the fuse loses 22, and
the setter wins their stake plus a bounty. If Byte reaches the exit, the people who backed Byte collect
every mine that never went off.

Byte is **not** our agent. We publish the game API described in `byte.game.json`; Byte Arena's agent
calls it and narrates on its own stream. A local driver plays the same API for sims and rehearsal.

```
byte.game.json  the spec Byte Arena reads (actions, auth, finish, result, watchUrl)
apps/server     game API · run manager · x402 risk oracle · spectator feed (Node 22, no build step)
apps/watch      spectator page, framed by app.bytearena.fun, one per run at /watch/:runId
apps/mobile     TrapSetter Android app (Expo + Mobile Wallet Adapter)
programs/       Anchor program: commit-reveal mines + backer pool (Rust)
packages/shared rules shared by everything — hashing is byte-identical to the Rust program
scripts/        trace.ts: N seeded sims against the engine, prints the win rate
docs/           ARCHITECTURE.md · HACKATHON_PLAN.md · GAME_SPEC.md (for the Byte upload form)
```

## Run it in 30 seconds (no wallet, no RPC)

```bash
npm install
npm run sim            # a local driver plays runs THROUGH the public HTTP API, forever
npm run sim:fast       # same, one move every 600 ms
npm run sim:once       # one run, then exit 0 (escaped) or 3 (dead)
```

The console prints each run's watch link, `http://localhost:8787/watch/<runId>`. Open it to see the
board, Byte's hand, the hidden mines and every detonation. The "Plant a mine" panel lets you mine a
card yourself; your browser keeps the salt and reveals the mine when Byte plays the card.

Sim mode uses an in-memory copy of the on-chain program plus simulated viewers who mine cards from
Byte's hand. Without `SIM=1` the server just waits for Byte (or you, with curl) to start a run.

### Environment

| Variable | Default | Effect |
|---|---|---|
| `CROWD=1` | off | Attach simulated viewers (mines + backers) to **every** run, including real Byte Arena runs, with no self-play. This is what the deployed server should run so Byte's runs are not silent. Mock chain only. |
| `SIM=1` | off | `CROWD=1` plus a local driver that plays runs through the public API. Rehearsal only: never run it on a server Byte Arena is playing against. |
| `CROWD_SETTERS` | 5 | Number of simulated setters. |
| `CROWD_AGGRESSION` | tuned value in `crowd.ts` | Probability each setter plants on a given turn. Tune this, never the fuse costs. |
| `CROWD_BACKER_USD` | 20 | Total mock USDC backing Byte (funds the bounties). |
| `FAST=1` | off | Sim driver acts every 600 ms instead of 2.5 s. |
| `ONE_MATCH=1` | off | Sim exits after one run: 0 escaped, 3 dead. |
| `SPECTATE_DELAY_SECONDS` | 4 | Default delay for the spectator feed, so the watch page stays in step with Byte's narration on its own stream. `GET /runs/:id/spectate?delay=<0..20>` overrides it per request (the watch page passes its own `?delay=` through; the stake page and phone use `delay=0`). `paced=1` attaches a board snapshot to each event so the page can replay them one at a time. The Byte API is never delayed. |
| `GUEST_START_FUNDS` | 10 | Test funds a new guest is credited once (keyed by guest id, so a reload never credits twice). Mock chain only. Players are identified by their wallet address or a guest id made once in the browser; display names live behind `GET`/`PUT /api/v1/profile` (in memory now, behind a store interface). |
| `PORT` | 8787 | Listen port. |
| `CHAIN=solana` | mock | Real devnet program via `RPC_URL`, `AUTHORITY_KEYPAIR`, `USDC_MINT`. `CROWD` is a no-op here (warning at startup). |
| `X402_FACILITATOR`, `ORACLE_PAYTO`, `X402_NETWORK` | sim verifier | Real x402 settlement for the risk oracle. |
| `POLLAR_SECRET_KEY` | unset = demo credits | Server-side Pollar secret key (`sec_testnet_…` / `sec_…`): every `Authorization: Bearer` token is verified at `POST /v3/tokens/verify` (header `x-pollar-api-key`) and the player's identity is the Solana wallet Pollar reports. Never printed, logged or shipped to a browser. |
| `POLLAR_SERVER_API_URL` | `https://server.api.pollar.xyz/v3` | Pollar Server API base URL. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | unset = memory | Durable money for Pollar players (server only, never sent to a page or logged). With both set, every balance read and movement of a signed-in Pollar player goes through Supabase: `credit_deposit` for USDC top-ups, `apply_delta` for stakes, bounties, backer payouts and refunds (kind + a stable ref, so a retry never pays twice), `players` for display names and wallets. Guests' test funds stay in memory. On start the old `data/fiat-ledger.json` is copied in once and stakes of runs that never settled are refunded. If Supabase is unreachable, money actions answer "We can't reach our records right now. Try again in a minute." and `GET /healthz` reports `"storage": "supabase-unreachable"` (otherwise `supabase` or `memory`). |
| `TREASURY_KEYPAIR` | unset = withdrawals off | The treasury's Solana secret key: an inline JSON array of 64 numbers, a path to a file holding one, or a base58 secret key. It signs USDC cash-outs over `RPC_URL`, and on the mock chain its public key becomes the treasury address viewers hash with and pay into. Never logged. A value that is not a secret key (a public address, a missing file) never stops the server: one line is logged, withdrawals stay off, and the funds page refuses to send until it is fixed. |
| `LEGACY_TREASURY_ADDRESSES` | unset | Comma-separated earlier treasury addresses. Finalized USDC transfers from a player's verified wallet to any of them are still credited (once per signature) by deposit confirmation and reconciliation. Never a destination for new payments: `GET /api/v1/treasury` only ever names the current treasury. |
| `FIRECRAWL_API_KEY` | unset = built-in decks only | Daily decks from the web: one Firecrawl v2 scrape per source per day (`apps/server/config/deck-sources.json`: Wikipedia "On this day", Wikipedia "Did you know" from the Main Page, NASA APOD) with JSON extraction (a prompt plus a schema) into 7 tiles in the built-in deck's shape. Tiles are validated (single English words, letters only, 3–10 letters, upper-cased, no duplicates, no word from its own clue, a blocklist, no tiles about people, and no tile whose clue or words touch violence, death, disaster, crime, disease, politics or religion; the prompt asks for neutral, playful categories only) and only the theme, source URL and tiles are stored, in Supabase `decks(day, theme, source_url, tiles)` or memory. Refresh is lazy: a run with no deck for today starts one in the background (one in flight, three attempts a day) and plays the newest stored deck, else the built-in one. The key is server only and never logged. |
| `ADMIN_TOKEN` | unset | Protects `POST /api/v1/decks/refresh` (header `x-admin-token`), which refreshes today's decks now. |
| `ALLOW_CLIENT_WALLET_BINDING` | unset = off | Last resort for a Pollar account whose Solana address neither `POST /v3/tokens/verify` nor `GET /v3/users?q=<id>` reports: with `1`, the funds page may send the address the SDK shows and the server binds it to the Pollar user once. **Unsafe by design** (a client could bind another player's address first, and that player's deposits would reconcile to the wrong account), so it is off unless you set it. Off, the player is told "We couldn't find your Solana wallet with Pollar. Sign out and in again, or contact us." |
| `RPC_URL`, `USDC_MINT` | `https://api.devnet.solana.com`, Circle's USDC for that cluster | In Pollar mode the server confirms every USDC top-up itself over this RPC (finalized, sent by the verified wallet, received by the treasury, right mint and amount) before crediting, exactly once per signature. Pollar "testnet" means Solana **devnet**; a wallet on another network is refused. |
| `FIAT_LEDGER_PATH` | `data/fiat-ledger.json` | Atomic JSON ledger: balances, payment ids, trap ownership, backer shares. |
| `VITE_POLLAR_PUBLISHABLE_KEY` (`pub_testnet_…`), `VITE_POLLAR_BASE_URL`, `VITE_SERVER_URL` | unset | **Build time**, baked into `apps/stake` by `npm run build -w apps/stake`; the server cannot supply them later. Without the publishable key the stake and side pages run in demo mode even when the server has the secret key, and `GET /healthz` answers `"pollar": "missing"` with the names (never the values) of what is unset. Run time on the server: `POLLAR_SECRET_KEY`, optional `POLLAR_SERVER_API_URL`, `RPC_URL`, `USDC_MINT`. |

## The API Byte plays

| Call | Auth | Returns |
|---|---|---|
| `POST /api/v1/runs` `{ "callsign": "Byte" }` | none | `{ runId, apiKey, state }` |
| `GET /api/v1/runs/:id/state` | `Authorization: Bearer <apiKey>` | full state, no side effects |
| `POST /api/v1/runs/:id/play` `{ "word": "...", "turn"?: n }` | Bearer | full state (400 bad word, 409 stale turn, both with `state`) |
| `POST /api/v1/runs/:id/hint` · `/challenge` `{ "word" }` · `/defuse` · `/pass` | Bearer | full state |
| `GET /runs/:id/spectate?after=seq` | public | `{ seq, events, state, players, room }` for the watch page and phone. `room` (seats, host, private, `you`) is read live, never from the delayed board history. |
| `GET /runs/:id/picker` | public | Undelayed "cards you can mine": the prompt, cards and safe card of this, the next and the later tile. Never played words, hints or traps. |
| `POST /runs/:id/seat` `{ action: "take" \| "leave" }` | identity | Four seats per room. Taking returns `{ seat, token }`; a fifth person gets 409. `plant-fiat` needs the token in `x-seat-token`. Seats idle for 10 turns are freed. |
| `POST /runs/:id/room` `{ private }` | host | The first person seated is the host; private rooms are hidden from the lobby and quick play. Anyone else gets 403 "Only the host can make the room private." Returns `{ private, host, room }`. |
| `GET /api/v1/rooms` · `POST /api/v1/rooms/quick` | public · identity | Live public rooms (most people first, then newest); quick play seats you in the first one with a free seat. |
| `POST /api/v1/rooms` | identity | "Start a room": opens a run played by the house Byte (the local driver over this same API) and seats the caller as host. At most three house rooms at once (409). Returns `{ runId, code, seat, token, room }`. The lobby link for any room is `/play?room=<code>`. |
| `POST /runs/:id/plant-fiat-batch` `{ items: [{ commitmentHex, stake }] }` | identity | Arm several cards in one action from the player's balance. Returns per-item results and the undelayed turn. |
| `POST /api/v1/decks/refresh` | `x-admin-token` | Refresh today's decks from the web now; answers what was stored and `decks: today|stale|builtin`. Each new run picks one of today's decks at random before any seat is taken and keeps it; `state.deck` carries `{ theme, sourceUrl, site, day }` and the board shows "Today's deck: <theme>" with a link to the source. |
| `GET /api/v1/treasury` | public | Where fiat mines are planted from and where top-ups go: `pubkeyHex`, `address`, and in Pollar mode `usdcMint` and `network` (`devnet` / `mainnet`, from `RPC_URL`). |
| `GET /api/v1/fiat/ready?address=<wallet the SDK will pay from>` | Pollar sign-in | Asked by the funds page before any payment. `ready: true` only when the server has a verified Solana wallet for the session and it equals that address; otherwise `ready: false` with a sentence, and `link: true` when the one-time wallet check is the way forward. Nothing is sent while it is false. |
| `POST /api/v1/fiat/link/start` · `POST /api/v1/fiat/link/confirm` `{ address, signature? }` | Pollar sign-in | Proof-of-control wallet check for an account whose Solana address Pollar's server side does not report: `start` names a one-time amount ($1 plus a random 1–9999 micro-dollar tail, valid 10 minutes, unique among open checks); `confirm` links the address to the Pollar user only when a finalized transfer of exactly that amount from that address reached the treasury inside the window (one address per user, one user per address, permanent), credits it as a deposit, and reconciles earlier transfers from that wallet. A claim alone never links. |
| `POST /api/v1/fiat/withdraw` `{ amount, requestId }` | Pollar sign-in | Cash-out of game balance as USDC to the player's own Pollar wallet (the address Pollar verified; never a client-supplied one). Decimal dollars, minimum $1.00, at most the balance, one in flight per player, five per hour. The balance drops first (`withdraw`, ref `withdraw:<requestId>`, so a repeat is a no-op), the treasury signs and records the signature before broadcasting, finality gives `withdraw-sent` (200) or a refund (502); an unknown outcome answers 202 and is re-checked every 30 s and on startup. Refused before any debit when the treasury is short of USDC or SOL: "Withdrawals are paused for a moment. Your balance is safe." |
| `POST /api/v1/fiat/confirm` `{ signature, amount }` | Pollar sign-in | Confirms a USDC transfer to the treasury on Solana and credits the balance once per signature; `202 pending` until it is finalized (re-checked every 30 s). Demo mode takes `{ paymentId }` from `/dev/credit`. |
| `GET /watch/:id` | public | the spectator page, with a `frame-ancestors` CSP header |
| `GET /api/v1/spec` | public | `byte.game.json` |

```bash
R=$(curl -s -X POST localhost:8787/api/v1/runs -d '{"callsign":"me"}')
KEY=$(echo $R | jq -r .apiKey); ID=$(echo $R | jq -r .runId)
curl -s -H "Authorization: Bearer $KEY" localhost:8787/api/v1/runs/$ID/state | jq .hand
curl -s -H "Authorization: Bearer $KEY" -d '{"word":"alpaca"}' localhost:8787/api/v1/runs/$ID/play | jq .fuse
```

## Fiat staking (Pollar)

Google sign-in creates a Pollar wallet; viewers stake from that wallet balance, tracked in a
server-side ledger (integer micro-USD). Local-currency top-up (Pix, bank QR, bank transfer) is
[ROADMAP] and is not offered anywhere in this build. The server treasury is the on-chain setter for all of them; the browser keeps the
word and salt and reveals through the server once Byte has played the card. Details and invariants:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#fiat-staking-pollar).

```bash
npm run stake:build                         # builds apps/stake → served by the game server at /stake/
VITE_POLLAR_PUBLISHABLE_KEY=pub_testnet_... npm run build -w apps/stake   # Pollar mode: @pollar/react sign-in, wallet, USDC top-ups, activity
POLLAR_SECRET_KEY=sec_testnet_... RPC_URL=https://api.devnet.solana.com npm run dev   # server verifies tokens with Pollar and USDC payments on Solana; otherwise demo credits
```

### Runs survive a restart (Supabase table `runs`)

With `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set, every run is saved write-behind (coalesced, retried, flushed on
SIGTERM) and every run updated in the last two hours is restored on startup with the same runId, turn and API key.
Create the table once (RLS on; no policies, so only the service role the server uses can read or write it):

```sql
create table if not exists public.runs (
  run_id     text primary key,
  status     text not null,          -- live | escaped | dead
  state      jsonb not null,         -- match, chain, room, feed, cursor, ledger slices (apps/server/src/runs.ts RunDump)
  updated_at timestamptz not null default now()
);
create index if not exists runs_updated_at_idx on public.runs (updated_at desc);
alter table public.runs enable row level security;
```

Browser test for the board and the side page (backer view, one side per run, zero name prompts), against the same mock server:

```bash
node scripts/browser-watch.mjs http://127.0.0.1:8808 http://127.0.0.1:8809 docs/design_reference/captures/watch
```

Browser test for the funds page (headless Chrome; Parts A–C need a build with any `VITE_POLLAR_PUBLISHABLE_KEY`, Part D
also `VITE_WT_MOCK_POLLAR=1` and the mock server, which credits a top-up 8 s after it was sent):

```bash
VITE_POLLAR_PUBLISHABLE_KEY=pub_testnet_x VITE_WT_MOCK_POLLAR=1 npm run build -w apps/stake
node scripts/stake-mock-server.ts 8808 &        # game server :8808 with a mocked Pollar, mock chain :8809
node scripts/browser-stake.mjs http://127.0.0.1:8808 docs/design_reference/captures/stake http://127.0.0.1:8809
npm run stake:build                              # then rebuild without the test flags
```

Without keys the page runs in **demo-credit mode**: `POST /dev/credit` funds a balance (mock chain only),
and the rest of the flow is identical. Manual walkthrough: add funds on `/stake/` → take a seat and plant from the
board (`/watch/<id>`) → Byte plays the card → the board reveals it → payout lands in the balance.

## Tests

```bash
npm test               # TS: Rust↔TS hash parity, mock chain economics, x402 flow, Match rules, full HTTP contract, fiat ledger
npm run program:test   # Rust: firing/challenge logic, bounty cap, pro-rata, word rules, hash vectors
node scripts/trace.ts 30   # 30 seeded sims, prints Byte's win rate (target 25–40%)
```

## Devnet + Byte Arena

```bash
anchor build && anchor deploy --provider.cluster devnet   # then update declare_id!/Anchor.toml
CHAIN=solana RPC_URL=... AUTHORITY_KEYPAIR=./referee.json USDC_MINT=... npm run dev
```

Deploy the server behind a public **https** host, put that host into `byte.game.json` (`baseUrl` and
`watchUrl`), and upload the file plus `docs/GAME_SPEC.md` on Byte Arena's "My games" page.

## Rules

| Action | Fuse | Effect |
|---|---|---|
| `play_word` | 5 | Play one card from the hand. A tile clears after `needed` cards. Mined + armed → detonation. |
| `buy_hint` | 3 + $0.001 x402 | Risk score 0..1 for every card in the hand, stored in `state.hint`. |
| `challenge_word` | 8 | Name a suspected mine without playing it. An armed mine on it is disarmed for good. |
| `defuse_tile` | 20 | Skip the tile. 2 uses per run. |
| `pass_turn` | 10 | Nothing. |
| Mine fires | 22 | The setter gets stake + 2× bounty (capped by the backer pool). |

Fuse starts at 180. The run ends on escape, at fuse 0, or at turn 60. Score is `position * 100 + fuse`.
A mine only becomes active on the turn **after** it's planted, so a viewer can never mine a card
Byte is already playing. Common words ("the", "and", "I"…) and words of 1–2 letters can't be mined.
