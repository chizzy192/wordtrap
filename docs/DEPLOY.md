# WordTrap devnet deploy kit

Built from commit 43fbf7f (Rust program unchanged since tests passed 8/8).
Program ID (already baked into wordtrap.so): 2f3m7iDZvMhZFfMeBi2GbhmmX9G9AcdekNtaDWMoMZNE

## 0. One-time: install the Solana CLI in WSL (small, ~100 MB — no Rust needed)
    sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
    # reopen the shell, or: export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

## 1. Referee wallet + devnet SOL
    solana-keygen new -o ~/referee.json          # this is the game server's AUTHORITY_KEYPAIR
    solana config set --url devnet --keypair ~/referee.json
    solana airdrop 2 && solana airdrop 2         # repeat / use faucet.solana.com if rate-limited
    solana balance                               # want >= 3 SOL (deploy costs ~2.5)

## 2. Deploy (from the folder holding these files)
    solana program deploy --program-id wordtrap-keypair.json wordtrap.so
    # prints: Program Id: 2f3m7iDZvMhZFfMeBi2GbhmmX9G9AcdekNtaDWMoMZNE

## 3. Repo updates (commit these)
    - programs/wordtrap/src/lib.rs : declare_id!("2f3m7iDZvMhZFfMeBi2GbhmmX9G9AcdekNtaDWMoMZNE")
    - Anchor.toml                  : both [programs.*] entries -> same ID
    - apps/mobile/app.json         : extra.programId -> same ID
    - copy wordtrap.json           -> target/idl/wordtrap.json (server reads it)  AND apps/mobile/src/wordtrap.idl.json
    - keep wordtrap-keypair.json PRIVATE (never commit; it owns the program upgrade authority)

## 4. Devnet USDC + server env
    Use the devnet USDC mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (faucet: faucet.circle.com, devnet)
    or create a test mint you control:  spl-token create-token --decimals 6
    Render: upload referee.json as a Secret File (/etc/secrets/referee.json), then set
    CHAIN=solana, RPC_URL=https://api.devnet.solana.com, USDC_MINT=<mint>, AUTHORITY_KEYPAIR=/etc/secrets/referee.json

## 5. Smoke-test on devnet BEFORE pointing Byte at it
    CHAIN=solana locally first; the SolanaChain adapter was written against docs and
    has never touched a live cluster — expect to fix small account/arg mismatches here.
