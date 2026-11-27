// Cash-out: the treasury pays USDC from its own wallet to a player's Pollar Solana wallet. The chain side is behind
// an interface so tests use a fake; the real one signs with TREASURY_KEYPAIR (a Solana CLI JSON secret key, as a file
// path or inline) over RPC_URL using @solana/web3.js and @solana/spl-token. Nothing here reads a balance or decides
// money: the server debits first (apply_delta) and only then asks this to send.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export type SendOutcome =
  | { status: "sent"; signature: string; lastValidBlockHeight: number }      // broadcast; wait for finality separately
  | { status: "failed"; reason: string };                                     // definite: nothing left the treasury
export type Finality = "finalized" | "failed" | "expired" | "unknown";

export interface TreasuryWallet {
  /** The treasury's public key, base58. Deposits go here and cash-outs come from here. */
  readonly address: string;
  /** What the treasury holds right now: USDC in base units, SOL in lamports. */
  holdings(): Promise<{ usdcMicro: bigint; lamports: bigint }>;
  /** Sign a USDC transfer to `to` (the token account is created if missing) and hand back its signature; nothing is
   *  broadcast until `broadcast()` is called, so the signature can be recorded first. */
  prepare(to: string, micro: bigint): Promise<{ signature: string; lastValidBlockHeight: number; broadcast(): Promise<SendOutcome> }>;
  /** Where a broadcast transaction stands: finalized, failed on chain, expired unseen, or not known yet. */
  finality(signature: string, lastValidBlockHeight: number): Promise<Finality>;
}

/** Lamports the treasury must keep for a transfer plus an associated-token-account rent (0.00204 SOL) and fees. */
export const MIN_SOL_LAMPORTS = 5_000_000n;

/** The real treasury on Solana (devnet in test mode). */
export class SolanaTreasury implements TreasuryWallet {
  readonly address: string;
  private readonly web3: any; private readonly spl: any; private readonly conn: any; private readonly kp: any; private readonly mint: any;
  private constructor(web3: any, spl: any, rpcUrl: string, secret: Uint8Array, mint: string) {
    this.web3 = web3; this.spl = spl;
    this.conn = new web3.Connection(rpcUrl, "finalized");
    this.kp = web3.Keypair.fromSecretKey(secret);
    this.mint = new web3.PublicKey(mint);
    this.address = this.kp.publicKey.toBase58();
  }
  /** TREASURY_KEYPAIR: a path to the JSON secret-key array, or the array itself. The key never leaves this object. */
  static fromEnv(env: NodeJS.ProcessEnv, mint: string): SolanaTreasury | null {
    const raw = env.TREASURY_KEYPAIR;
    if (!raw) return null;
    const text = raw.trim().startsWith("[") ? raw : readFileSync(raw.trim(), "utf8");
    const secret = Uint8Array.from(JSON.parse(text));
    const req = createRequire(import.meta.url);
    return new SolanaTreasury(req("@solana/web3.js"), req("@solana/spl-token"), env.RPC_URL ?? "https://api.devnet.solana.com", secret, mint);
  }
  publicKeyBytes(): Uint8Array { return new Uint8Array(this.kp.publicKey.toBytes()); }
  async holdings() {
    const lamports = BigInt(await this.conn.getBalance(this.kp.publicKey, "finalized"));
    const ata = this.spl.getAssociatedTokenAddressSync(this.mint, this.kp.publicKey);
    let usdcMicro = 0n;
    try { const b = await this.conn.getTokenAccountBalance(ata, "finalized"); usdcMicro = BigInt(b.value.amount); } catch { usdcMicro = 0n; }   // no account yet: nothing held
    return { usdcMicro, lamports };
  }
  async prepare(to: string, micro: bigint) {
    const { PublicKey, Transaction } = this.web3;
    const owner = new PublicKey(to);
    const from = this.spl.getAssociatedTokenAddressSync(this.mint, this.kp.publicKey);
    const dest = this.spl.getAssociatedTokenAddressSync(this.mint, owner);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: this.kp.publicKey, blockhash, lastValidBlockHeight });
    tx.add(this.spl.createAssociatedTokenAccountIdempotentInstruction(this.kp.publicKey, dest, owner, this.mint));
    tx.add(this.spl.createTransferCheckedInstruction(from, this.mint, dest, this.kp.publicKey, micro, 6));
    tx.sign(this.kp);
    const signature = base58(new Uint8Array(tx.signature));
    const raw = tx.serialize();
    const broadcast = async (): Promise<SendOutcome> => {
      try { await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 3 }); }
      catch (e) {
        // a rejected broadcast (simulation failed, bad account) is definite: the network never accepted it
        const msg = (e as Error).message ?? String(e);
        if (/Transaction simulation failed|invalid|insufficient|Blockhash not found|custom program error/i.test(msg)) return { status: "failed", reason: msg.slice(0, 160) };
        return { status: "sent", signature, lastValidBlockHeight };   // a network hiccup after signing: unknown, re-checked by signature
      }
      return { status: "sent", signature, lastValidBlockHeight };
    };
    return { signature, lastValidBlockHeight, broadcast };
  }
  async finality(signature: string, lastValidBlockHeight: number): Promise<Finality> {
    const st = await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = st.value?.[0];
    if (s) {
      if (s.err) return "failed";
      if (s.confirmationStatus === "finalized") return "finalized";
      return "unknown";
    }
    const height = await this.conn.getBlockHeight("finalized");
    return height > lastValidBlockHeight ? "expired" : "unknown";
  }
}

function base58(bytes: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
