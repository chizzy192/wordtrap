# Dev3pack Global Hackathon — Nov 27–29, 2026

## What changed (Nov 25)

The Byte track works the opposite way from what we built. Byte is an **external AI streamer run by
bytearena.fun**. It plays games over HTTP, decides moves from the state JSON we return, and narrates on
its own stream. We do not run Byte, we do not see its narration, and we cannot use a wall-clock fuse.
Our in-process agent becomes a local driver for sims only. See `docs/ARCHITECTURE.md` for the target
design and `docs/wordtrap-byte-pivot-prompt (1).md` for the file-by-file refactor.

What the pivot buys us: one HTTP API serves Byte, the sim harness, the watch page and the phone app.
The on-chain program, the mine economics and the mobile arming flow are untouched.

## Before Friday: open questions

1. **Can we build before the hackathon starts?** Ask in the Telegram group. If no, this repo is the design
   reference and we rebuild on day 1. The pivot prompt is written so a rebuild is mechanical.
2. **Sponsor tracks.** hack.dev3pack.xyz lists Best App Overall, Best Mobile App on Solana Mobile and local
   tracks. Confirm the Byte, Agentic and DeFi bounty pages and how many tracks one project can enter.
3. **Pollar:** resolved. `@pollar/core` 0.12 supports Solana (SPL payments, sponsored fees). Still needed from
   the Pollar team: a test publishable key + secret key, and the Server API paths for payment lookup and session
   verification (`POLLAR_PAYMENT_PATH`, `POLLAR_SESSION_PATH`). Note the npm release is 0.12.0; the README's 0.12.1 is not published.
4. **Byte deploy host.** We need a public https origin before the spec can be uploaded (localhost and
   private IPs are rejected). Decide Friday morning: Fly.io, Railway or Render, with a dedicated devnet RPC.
5. **Byte "My games" upload.** Confirm the form fields: spec JSON, prose game document, and whether a test
   run can be triggered on demand or whether we wait in a queue.

## Byte track qualification checklist

Everything below is required by app.bytearena.fun/api/game-spec. Check each item off literally.

| # | Requirement | How we meet it | Status |
|---|---|---|---|
| 1 | Public **https** `api.baseUrl` | Deployed server, `byte.game.json` baseUrl and watchUrl replaced | ⏳ |
| 2 | Spec JSON uploaded on bytearena "My games" with a prose game document | `byte.game.json` + `docs/GAME_SPEC.md` | ✅ files written · ⏳ upload |
| 3 | `start`: one unauthenticated call, saves `apiKey` and `runId` | `POST /api/v1/runs` | ✅ api.test.ts |
| 4 | `auth`: `Authorization: Bearer {{apiKey}}` on every later call | constant-time check on all `/api/v1/runs/:id/*`, 401 otherwise | ✅ api.test.ts |
| 5 | `state` GET has zero side effects | `/state` returns a copy; test (e) in match.test.ts + api.test.ts | ✅ |
| 6 | Every response is the complete game state | `act()` returns full `BoardState`; 400/409 carry `state` too | ✅ api.test.ts |
| 7 | Closed set of actions, no reaction-time dependence | 5 declared actions, per-action fuse, no timers anywhere in `match.ts` | ✅ |
| 8 | Repeated actions idempotent or stale turns rejected legibly | optional `turn` → 409 `{ error, state }`; finished runs return final state | ✅ tests (b), (d), api |
| 9 | `finish` and `result` readable from final state | `status ∈ {escaped, dead}`, `score`, label `FUSE SCORE` | ✅ |
| 10 | Finished runs keep answering (no 404) | runs kept in memory for the session | ✅ api.test.ts |
| 11 | `watchUrl` frameable: `text/html`, real `frame-ancestors` CSP header, deep link, no `document.hidden`, no login/audio | `/watch/:id`; header verified with curl and in api.test.ts | ✅ locally · ⏳ on the https host |
| 12 | Limits: 400 calls, 12 s/call, 64 KB, 2 h | turn cap 60, reveal hooks inside request, event cap 200, state ≈ 5 KB | ✅ |
| 13 | Bets decided from state JSON, not narration | mines fire only on `play_word` words; narration never reaches the server | ✅ |
| 14 | One full Byte run completed on the platform | watch it end-to-end, save the run id | ⏳ |
| 15 | Public repo + demo video | GitHub public, 2-minute video | ⏳ |

## Track checklist

| Track | What we show | Status |
|---|---|---|
| Byte | Turn-based HTTP game Byte plays live; spectator iframe shows hand, fuse, mines, detonations | ⏳ refactor + deploy + one platform run |
| Solana Overall | Anchor program with commit-reveal mines + backer pool, live game | ✅ program + tests · ⏳ devnet deploy |
| DeFi | USDC vault with bounty budget, pro-rata settlement | ✅ logic · stretch: idle vault USDC earns yield |
| Agentic | Game server pays the x402 risk oracle on Byte's behalf from a Swig wallet with a spend-limited role | ✅ x402 flow (sim) · ⏳ Swig + facilitator |
| Solana Mobile | TrapSetter APK: swipe combos, one MWA signature, auto-detonation with no popup | ✅ code · ⏳ polling rewrite + device build |
| Pollar | Google sign-in viewers stake fiat on mines via a custodial treasury; see clause table below | ✅ UNBLOCKED (Nov 25): `fiat.ts`, `apps/stake`, 6 tests · ⏳ Pollar keys + endpoint confirmation |

### Pollar track, clause by clause (vs the sponsor pitch)

| Sponsor clause | What we do | Status |
|---|---|---|
| Onboarding without a wallet (Google sign-in creates a per-user wallet) | `apps/stake` runs inside `PollarProvider`; `login({ provider: "google" })` | [TESTNET] with a publishable key; demo-credit mode without one [LIVE] |
| External Solana wallets (Wallet Standard) | `@pollar/solana-wallet-standard-adapter` in Pollar mode; raw `@wallet-standard/app` connect in demo mode | [TESTNET] / [LIVE] |
| Fiat top-up (card, Pix, bank QR) | `openCardModal({ panel: "fund" })` → payment id → `POST /api/v1/fiat/confirm` → server verifies with the secret key, credits exactly once | [TESTNET]; live corridors per Pollar today: Bolivia bank QR, Brazil Pix, Argentina transfers (none exercised by us) |
| Sponsored fees / no SOL needed by the viewer | the treasury signs every on-chain plant/reveal/back; viewers hold only a ledger balance | [LIVE] on the mock chain, [TESTNET] on devnet |
| Micro-stakes in USD | integer micro-USD ledger, `plant-fiat` from $0.10 | [LIVE] |
| Payouts | `TrapFired` credits the owner; `settle` splits the treasury's backer share pro-rata | [LIVE] (mock) |
| Off-ramp to bank | not built; Pollar `openRampModal({ direction: "sell" })` exists, our ledger → Pollar withdrawal is not wired | [ROADMAP] |
| Webhooks | not built on purpose: Pollar lists them as upcoming; we verify by pulling | n/a |
| Server-side payment lookup + session verification endpoints | `PollarHttp` with configurable paths; **unconfirmed**: docs.pollar.xyz unreachable, not in the SDK repo | ⏳ confirm with the Pollar team |

## Refactor work list (from the pivot prompt) — done Nov 25

All twelve steps are in the tree. `engine.ts` and `agent.ts` are gone and `ws` is no longer a dependency.

1. ✅ `packages/shared/src/index.ts`: new `BoardState` / `FeedEvent`, lowercase action names. Hash helpers untouched; hash vectors green.
2. ✅ `apps/server/src/content.ts`: `sideways` and `needed` per tile, `handFor()`.
3. ✅ `apps/server/src/match.ts`: turn-based `Match`, `act()`, `StaleTurnError` (409), `InvalidActionError` (400), `afterWords` reveal hooks, `turnHooks` plant hooks.
4. ✅ `apps/server/src/crowd.ts`: hand-aware setters, synchronous reveal hook. Nov 25 rework: setters stack on the 1–2 most obvious cards (`multi_boom` event when 2+ fire together), 25% scatter onto sideways cards / habits / just-challenged words. Defaults: 5 setters, aggression 0.11, $20 backers. **Deploy with `CROWD=1`** (not `SIM=1`) so real Byte runs get mines without self-play.
5. ✅ `apps/server/src/driver.ts`: pure `decide(state)`.
6. ✅ `apps/server/src/runs.ts` + `main.ts`: routes, Bearer auth, CSP header, SIM loop over the public API, `ONE_MATCH` exit codes.
7. ✅ `byte.game.json` at repo root (host placeholders still to fill).
8. ✅ `apps/watch/index.html`: polling, hand row, no websocket / arming banner / narration.
9. ✅ `apps/mobile/App.tsx`: polling, no countdown, swipe deck = Byte's hand.
10. ✅ Tests: `match.test.ts` (a–e plus hint and bad-word cases), `api.test.ts` (full contract over HTTP plus the planter). 17 tests green.
11. ✅ `scripts/trace.ts`: seeded sims. Win rate 33% on the default seed, 32% and 54% on two other 100-run seed sets. Variance is high, so re-check after any content change (`CROWD_SETTERS` / `CROWD_AGGRESSION` env override the crowd).
12. ✅ Docs: README, this file, `docs/GAME_SPEC.md`, `docs/ARCHITECTURE.md`.

Known gameplay edge (on-chain rule, not a bug): a challenge disarms mines that are already armed. A mine planted on the same turn as the challenge still arms next turn, so "challenge then immediately play" can still detonate. `GAME_SPEC.md` says so, and the sim driver does it on purpose.

Acceptance (run before deploy; results from Nov 25 on a Windows dev box):

```bash
npm install
npm test                                                  # 17/17 green
cargo test -p wordtrap                                    # NOT RUN here: cargo is not installed on this machine; program untouched
node scripts/trace.ts 30                                  # 33%
ONE_MATCH=1 FAST=1 SIM=1 node apps/server/src/main.ts     # played 24 turns over HTTP, exited 3 (dead)
curl -sS -D- -o /dev/null http://localhost:8787/watch/<runId>   # text/html + frame-ancestors 'self' https://app.bytearena.fun
```

## Team split (3–4 people)

- **Chain (Rust):** `anchor build`, deploy to devnet, test token mint, anchor-bankrun integration test of the full match. No program changes.
- **Server:** deploy to a public https host, fill the host into `byte.game.json`, Swig wallet + x402 facilitator, keep `scripts/trace.ts` win rate in range after any content change.
- **Mobile + watch:** polling rewrite in `App.tsx`, hand row and CSP check on the watch page, `npx expo run:android` on a device with an MWA wallet, first reveal funded with a little SOL (or a relayer).
- **Product/pitch:** `docs/GAME_SPEC.md` for the Byte upload form, bytearena "My games" submission, demo video, deck, collecting clips from the platform run.

## Day plan

- **Thu (pre-hack, if allowed):** refactor is done locally. Pick the host (question 4), get a devnet RPC, read the bytearena upload form (question 5), run `cargo test -p wordtrap` on a machine that has cargo.
- **Fri:** devnet deploy. Public https deploy of the server. Spec + prose doc uploaded to bytearena. Watch page and mobile on polling. APK installs and arms a mine against a sim run.
- **Sat:** first real Byte run on the platform. Fix whatever the platform rejects. Swig role + real x402 facilitator. Tune crowd aggression from what the real run showed. Phone auto-detonates during a platform run.
- **Sun morning:** freeze. Record the demo from a real Byte run (at least one detonation from the phone, one challenge). Submit early.

## 90-second demo script

1. (0:00) Byte's stream, our watch page in the iframe: "Byte has to clear 7 prompts from a visible hand of cards. Every card it plays goes on-chain. You can mine any card."
2. (0:15) Phone: swipe right on "coffee" and "alarm", one wallet signature, two hashes appear on the board. They arm on Byte's next move.
3. (0:35) Byte buys a hint for $0.001 over x402 (shown in the ticker) and sees "coffee 0.99" in `state.hint`.
4. (0:50) Byte dodges coffee, then plays "alarm". The phone fires the mine on its own, BOOM, −22 fuse, payout shown in the same response Byte reads.
5. (1:10) Byte challenges "coffee" without playing it. The mine is disarmed on-chain via the challenge bitmap, the card turns safe. Explain why mines arm next turn.
6. (1:25) Settlement: backers sweep the mines that never fired. The code is public, here's the repo and the run id on bytearena.

## Risks

- **Platform rejects the spec.** Most likely causes: baseUrl not https, CSP header missing, state over 64 KB, a reveal hook pushing a call past 12 s. Run the acceptance list against the deployed host, not localhost.
- **Byte never plays mined words.** If Byte reads `hint` perfectly the stream is boring. The crowd and card mix are tuned so obvious cards are both tempting and mined. Watch the first platform run and adjust `sideways` lists and crowd aggression, not fuse costs.
- **Win rate drifts.** Target 25–40% in `scripts/trace.ts`. Below that Byte always dies and backers never win; above it mines rarely pay.
- Real-money betting on outcomes may count as gambling in some places. Keep the demo on devnet and present it as a game.
- Devnet RPC can rate-limit, and every action now hits the chain synchronously. Batch `record_words` (8 per tx supported), use a dedicated RPC, and keep the mock chain as the fallback for the demo video.
- The run cap is 2 h and 400 calls. Byte may think slowly; `turn >= 60` ends the run long before either limit.
