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
| `PORT` | 8787 | Listen port. |
| `CHAIN=solana` | mock | Real devnet program via `RPC_URL`, `AUTHORITY_KEYPAIR`, `USDC_MINT`. `CROWD` is a no-op here (warning at startup). |
| `X402_FACILITATOR`, `ORACLE_PAYTO`, `X402_NETWORK` | sim verifier | Real x402 settlement for the risk oracle. |
| `POLLAR_SECRET_KEY` | unset = demo credits | Server-side Pollar key: payments and viewer sessions are verified with it before any ledger credit. Never ship it to a browser. |
| `POLLAR_API_URL`, `POLLAR_PAYMENT_PATH`, `POLLAR_SESSION_PATH` | `https://sdk.api.pollar.xyz/v3`, `/payments/{id}`, `/auth/session` | Pollar Server API endpoints. Unconfirmed against the docs (site unreachable on Nov 25); set them from the docs before real money. |
| `FIAT_LEDGER_PATH` | `data/fiat-ledger.json` | Atomic JSON ledger: balances, payment ids, trap ownership, backer shares. |
| `VITE_POLLAR_PUBLISHABLE_KEY`, `VITE_POLLAR_BASE_URL`, `VITE_SERVER_URL` | unset | Build-time settings for `apps/stake` (browser). |

## The API Byte plays

| Call | Auth | Returns |
|---|---|---|
| `POST /api/v1/runs` `{ "callsign": "Byte" }` | none | `{ runId, apiKey, state }` |
| `GET /api/v1/runs/:id/state` | `Authorization: Bearer <apiKey>` | full state, no side effects |
| `POST /api/v1/runs/:id/play` `{ "word": "...", "turn"?: n }` | Bearer | full state (400 bad word, 409 stale turn, both with `state`) |
| `POST /api/v1/runs/:id/hint` · `/challenge` `{ "word" }` · `/defuse` · `/pass` | Bearer | full state |
| `GET /runs/:id/spectate?after=seq` | public | `{ seq, events, state }` for the watch page and phone |
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
VITE_POLLAR_PUBLISHABLE_KEY=pk_... npm run build -w apps/stake   # Pollar mode (Google sign-in, card top-ups)
POLLAR_SECRET_KEY=sk_... npm run dev        # server verifies payments + sessions with Pollar; otherwise demo credits
```

Without keys the page runs in **demo-credit mode**: `POST /dev/credit` funds a balance (mock chain only),
and the rest of the flow is identical. Manual walkthrough: `/dev/credit` → plant on `/stake/?run=<id>` →
Byte plays the card → the page reveals it → payout lands in the balance.

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
