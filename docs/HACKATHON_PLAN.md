# Dev3pack Global Hackathon — Nov 27–29, 2026

## Before Friday: open questions

1. **Can we build before the hackathon starts?** The FAQ asks this but the answer isn't public. Ask in the
   Telegram group. If the answer is no, treat this repo as a design reference and rebuild it from scratch on day 1
   (it's laid out so that's quick).
2. **Where do the sponsor tracks come from?** hack.dev3pack.xyz lists Best App Overall ($10k+), Best Mobile
   App on Solana Mobile (Seeker phones), and $500 local tracks. It does **not** list Byte, Pollar, Agentic or DeFi
   bounties. Find the official bounty page, its requirements, and how many tracks one project can enter.
3. **Pollar:** the public `@pollar/core` SDK describes itself as **Stellar**-based. Check with the Pollar team
   that Solana is supported before relying on it. If it isn't, use a Solana social-login provider with gas sponsorship
   (Privy, Phantom embedded, Dynamic) for onboarding, and keep the Pollar track only if they confirm Solana.
4. **Byte:** what does the Byte track actually require (SDK, streaming platform, how the `watchUrl` is registered)?
   Our agent sits behind an interface, so it can switch to Byte's runtime.

## Track checklist

| Track | What we show | Status |
|---|---|---|
| Solana Overall | Anchor program with commit-reveal mines + backer pool, live game | ✅ program + tests · ⏳ devnet deploy |
| DeFi | USDC vault with bounty budget, pro-rata settlement | ✅ logic · stretch: idle vault USDC earns yield |
| Agentic | Byte pays the x402 oracle on its own, from a Swig wallet with a spend-limited role | ✅ x402 flow (sim) · ⏳ Swig + facilitator |
| Solana Mobile | TrapSetter APK: swipe combos, one MWA signature, auto-detonation with no popup | ✅ code · ⏳ device build |
| Byte | Talks out loud, watchUrl shows board / fuse / mines | ✅ watch page · ⏳ TTS + Byte runtime |
| Pollar | Social login + sponsored micro-stakes + off-ramp | ⛔ blocked on question 3 |

## Team split (3–4 people)

- **Chain (Rust):** `anchor build`, deploy to devnet, test token mint, anchor-bankrun integration test of the full match.
- **Server/agent:** run SolanaChain on devnet, LLM prompt tuning, ElevenLabs TTS (also a Dev3pack sponsor), Swig wallet.
- **Mobile:** `npx expo run:android` on a device with a Mobile Wallet Adapter wallet, IDL import, the revealer key
  sends its first reveal funded with a little SOL (or a relayer pays the fee).
- **Product/pitch:** demo video, deck, 3 rehearsed live matches, collecting viral clips.

## Day plan

- **Fri:** devnet deploy, one full match on devnet with the referee key and scripted Byte. APK installs and arms a mine.
- **Sat:** LLM Byte + TTS, real x402 facilitator, Swig role, auto-detonation from the phone, watch page hosted.
- **Sun morning:** freeze features. Record the demo (a 2-minute match, at least one detonation from the phone). Submit early.

## 90-second demo script

1. (0:00) Watch page: "Byte has to clear 7 prompts. Everything it says goes on-chain. You can mine any word."
2. (0:15) Phone: swipe right on "coffee" and "alarm", one wallet signature, the mines appear as hashes on stream.
3. (0:35) Byte buys a hint over x402 for $0.001 (shown in the ticker) and sees "coffee 99%".
4. (0:50) Byte dodges coffee… then says "alarm" in its own narration. The phone fires the mine on its own, BOOM, −22s, payout shown.
5. (1:10) Byte challenges a suspected mine. Explain the challenge bitmap and why mines arm on the next turn.
6. (1:25) Settlement: backers sweep the mines that never fired. The code is public, here's the repo.

## Risks

- Real-money betting on outcomes may count as gambling in some places. Keep the demo on devnet and present it as a game.
- An LLM can produce words the server's tokenizer splits differently. The server normalizes speech and is the single source of truth.
- Devnet RPC can rate-limit. Batch record_word calls (8 per tx are already supported) and use a dedicated RPC.
