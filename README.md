# WordTrap

**A livestreamed word-survival game where an AI talks out loud and viewers bet USDC on which words it will say.**

Byte (an AI agent) has to clear a board of word prompts before its fuse burns out. Viewers secretly
plant USDC "mines" on words: a mine is a hash of the word, so nobody can see it. Everything Byte says
is written on-chain, including its own nervous commentary. If Byte says a mined word, the viewer's
phone reveals it instantly, the mine goes off, the fuse loses time, and the setter wins their stake plus a bounty.
If Byte reaches the exit, the people who backed Byte collect every mine that never went off.

```
apps/server     game engine · Byte agent · x402 risk oracle · watchUrl feed (Node 22, no build step)
apps/watch      watchUrl stream overlay (single HTML file)
apps/mobile     TrapSetter Android app (Expo + Mobile Wallet Adapter)
programs/       Anchor program: commit-reveal mines + backer pool (Rust)
packages/shared rules shared by everything — hashing is byte-identical to the Rust program
docs/           ARCHITECTURE.md · HACKATHON_PLAN.md
```

## Run it in 30 seconds (no wallet, no RPC)

```bash
npm install
npm run sim            # → open http://localhost:8787/watch
FAST=1 npm run sim     # same, with short arming windows for quick demos
```

Sim mode uses an in-memory copy of the on-chain program plus simulated viewers planting and
revealing mines. Open the "Plant a mine" panel on the watch page to play against Byte yourself.
Set `ANTHROPIC_API_KEY` to have Byte play with an LLM. Otherwise a scripted Byte plays.

## Tests

```bash
npm run program:test   # Rust: firing/challenge logic, bounty cap, pro-rata, word rules, hash vectors
npm test               # TS: Rust↔TS hash parity, mock chain economics, x402 402→pay→200 flow
```

## Devnet

```bash
anchor build && anchor deploy --provider.cluster devnet   # then update declare_id!/Anchor.toml
CHAIN=solana RPC_URL=... AUTHORITY_KEYPAIR=./referee.json USDC_MINT=... npm run dev
```

## Rules

| Action | Effect |
|---|---|
| `PLAY_WORD_CARD` | Answer the prompt with at least N words → clear the tile. Every word Byte says is recorded. |
| `BUY_HINT` | Byte pays $0.001 over x402 to get risk scores for up to 8 words, then picks its action. Once per turn. |
| `DEFUSE_TILE` | Skip the tile without speaking. Costs 20s of fuse. 2 uses per match. |
| `CHALLENGE_TRAP` | Byte types one word it thinks is mined, without saying it. If that word is mined, the mine is disarmed from then on. Costs 8s. |
| `PASS_TURN` | Costs 10s. |
| Mine fires | Costs 22s of fuse. The setter gets stake + 2× bounty (capped by the backer pool). |

A mine only becomes active on the turn **after** it's planted, so a viewer can never mine a word
Byte has already started saying. Common words ("the", "and", "I"…) and words of 1–2 letters can't be mined.
