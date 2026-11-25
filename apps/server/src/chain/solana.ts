// Devnet adapter for programs/wordtrap. Needs `anchor build` first (target/idl/wordtrap.json).
// STATUS: written against Anchor 0.32 TS API; first run on devnet is a day-1 task.
//
// env: RPC_URL, AUTHORITY_KEYPAIR (path to referee keypair json), USDC_MINT, MATCH_ID (u64)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Chain, ChainTrap, TrapFiredEvent } from "./types.ts";

const USDC = 1_000_000;
const wordSeed = (w: string) => createHash("sha256").update("wordtrap:word").update(w).digest();

export class SolanaChain implements Chain {
  readonly kind = "solana" as const;
  private a: any; private program: any; private provider: any;
  private game: any; private vault: any; private mint: any; private matchId: bigint;
  private traps = new Map<string, ChainTrap>();
  private backerTotal = 0; private turn = 0;
  private firedCbs: ((e: TrapFiredEvent) => void)[] = [];
  private plantedCbs: ((t: ChainTrap) => void)[] = [];

  static async fromEnv() {
    const anchor = await import("@coral-xyz/anchor");
    const web3 = await import("@solana/web3.js");
    const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.AUTHORITY_KEYPAIR!, "utf8"))));
    const conn = new web3.Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
    const idl = JSON.parse(readFileSync(new URL("../../../../target/idl/wordtrap.json", import.meta.url), "utf8"));
    const c = new SolanaChain();
    c.a = { anchor, web3 }; c.provider = provider; c.program = new anchor.Program(idl, provider);
    c.mint = new web3.PublicKey(process.env.USDC_MINT!);
    c.matchId = BigInt(process.env.MATCH_ID ?? Date.now());
    return c;
  }

  private pda(seeds: (Buffer | Uint8Array)[]) {
    return this.a.web3.PublicKey.findProgramAddressSync(seeds, this.program.programId)[0];
  }

  async initMatch() {
    const { anchor } = this.a;
    const id = Buffer.alloc(8); id.writeBigUInt64LE(this.matchId);
    const auth = this.provider.wallet.publicKey;
    this.game = this.pda([Buffer.from("match"), auth.toBuffer(), id]);
    this.vault = this.pda([Buffer.from("vault"), this.game.toBuffer()]);
    await this.program.methods
      .initializeMatch(new anchor.BN(this.matchId.toString()), 30_000, new anchor.BN(120), new anchor.BN(50_000))
      .accountsPartial({ authority: auth, game: this.game, mint: this.mint, vault: this.vault })
      .rpc();
    this.program.addEventListener("trapPlanted", (e: any) => {
      if (!e.game.equals(this.game)) return;
      const t: ChainTrap = { id: e.trap.toBase58(), setter: "", stake: e.stake.toNumber() / USDC, armedTurn: e.armedTurn, status: "armed" };
      this.traps.set(t.id, t); this.plantedCbs.forEach((cb) => cb(t));
    });
    this.program.addEventListener("backed", (e: any) => { if (e.game.equals(this.game)) this.backerTotal += e.amount.toNumber() / USDC; });
    this.program.addEventListener("trapFired", (e: any) => {
      if (!e.game.equals(this.game)) return;
      const t = this.traps.get(e.trap.toBase58());
      if (!t) return;
      t.status = "fired"; t.word = e.word;
      this.firedCbs.forEach((cb) => cb({ trap: t, word: e.word, payout: e.payout.toNumber() / USDC, turn: e.turn }));
    });
  }

  address() { return this.game?.toBase58(); }
  /** The referee/authority keypair doubles as the custodial treasury for fiat viewers. */
  treasury() { const pk = this.provider.wallet.publicKey; return { setter: pk.toBase58(), pubkey: new Uint8Array(pk.toBytes()) }; }
  private auth() { return { authority: this.provider.wallet.publicKey, game: this.game }; }
  async startMatch() { await this.program.methods.startMatch().accounts(this.auth()).rpc(); this.turn = 1; }
  async advanceTurn() { await this.program.methods.advanceTurn().accounts(this.auth()).rpc(); return ++this.turn; }
  async endMatch(s: boolean) { await this.program.methods.endMatch(s).accounts(this.auth()).rpc(); }

  /** Batch every word of an utterance into one tx (≈8-10 record_word ixs fit). */
  async recordWords(words: string[], kind: "spoken" | "challenged") {
    const { web3 } = this.a;
    let last = "";
    for (let i = 0; i < words.length; i += 8) {
      const tx = new web3.Transaction();
      for (const w of words.slice(i, i + 8)) {
        tx.add(await this.program.methods
          .recordWord(w, kind === "spoken" ? { spoken: {} } : { challenged: {} })
          .accountsPartial({ ...this.auth(), wordLog: this.pda([Buffer.from("word"), this.game.toBuffer(), wordSeed(w)]) })
          .instruction());
      }
      last = await this.provider.sendAndConfirm(tx);
    }
    return last;
  }

  onTrapFired(cb: (e: TrapFiredEvent) => void) { this.firedCbs.push(cb); }
  onTrapPlanted(cb: (t: ChainTrap) => void) { this.plantedCbs.push(cb); }
  snapshot() {
    const traps = [...this.traps.values()];
    return { turn: this.turn, backerTotal: this.backerTotal, trapTotal: traps.reduce((n, t) => n + t.stake, 0), traps };
  }
}
