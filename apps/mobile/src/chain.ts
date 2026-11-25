// Client-side WordTrap instructions for the phone: plant (signed via MWA) and reveal (signed by
// the phone's hot "revealer" key — no wallet popup, so the mine detonates the instant Byte speaks).
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { sha256 } from "@noble/hashes/sha2.js";
import idl from "./wordtrap.idl.json"; // copy from target/idl/wordtrap.json after `anchor build`

const cfg = Constants.expoConfig!.extra as { rpcUrl: string; programId: string; usdcMint: string };
export const connection = new Connection(cfg.rpcUrl, "confirmed");
const MINT = new PublicKey(cfg.usdcMint);
const enc = new TextEncoder();
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const commitment = (word: string, salt: Uint8Array, setter: PublicKey) => sha256(cat(enc.encode("wordtrap:v1"), enc.encode(word), salt, setter.toBytes()));
const wordSeed = (w: string) => sha256(cat(enc.encode("wordtrap:word"), enc.encode(w)));

// Read-only provider: MWA does the signing for plants, the revealer key for reveals.
const program = new Program(idl as any, new AnchorProvider(connection, { publicKey: PublicKey.default } as any, {}));
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

export async function revealerKey(): Promise<Keypair> {
  const saved = await SecureStore.getItemAsync("revealer");
  if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  const kp = Keypair.generate();
  await SecureStore.setItemAsync("revealer", JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export interface Secret { trap: string; word: string; salt: number[]; setter: string; armedTurn?: number }
export async function loadSecrets(): Promise<Secret[]> { return JSON.parse((await SecureStore.getItemAsync("mines")) ?? "[]"); }
async function saveSecrets(s: Secret[]) { await SecureStore.setItemAsync("mines", JSON.stringify(s)); }

/** One MWA approval arms the whole combo: N plant_trap ixs in a single tx. */
export async function armCombo(game: PublicKey, words: string[], stakeUsd: number) {
  const revealer = (await revealerKey()).publicKey;
  const vault = pda(enc.encode("vault"), game.toBytes());
  return transact(async (wallet) => {
    const auth = await wallet.authorize({ cluster: "devnet", identity: { name: "WordTrap", uri: "https://wordtrap.xyz" } });
    const setter = new PublicKey(Buffer.from(auth.accounts[0].address, "base64"));
    const setterAta = getAssociatedTokenAddressSync(MINT, setter);
    const tx = new Transaction();
    const secrets: Secret[] = [];
    for (const word of words) {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const c = commitment(word, salt, setter);
      const trap = pda(enc.encode("trap"), game.toBytes(), c);
      tx.add(await program.methods
        .plantTrap(Array.from(c), new BN(Math.round(stakeUsd * 1e6)), revealer)
        .accountsPartial({ setter, game, trap, setterAta, vault, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction());
      secrets.push({ trap: trap.toBase58(), word, salt: Array.from(salt), setter: setter.toBase58() });
    }
    tx.feePayer = setter;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const [sig] = await wallet.signAndSendTransactions({ transactions: [tx] });
    await saveSecrets([...(await loadSecrets()), ...secrets]); // salts never leave the phone
    return sig;
  });
}

/** Called from the live feed when Byte says one of our words. No popup. */
export async function detonate(game: PublicKey, s: Secret) {
  const kp = await revealerKey();
  const setter = new PublicKey(s.setter);
  const tx = new Transaction().add(await program.methods
    .revealTrap(s.word, Array.from(s.salt))
    .accountsPartial({
      caller: kp.publicKey, game, trap: new PublicKey(s.trap),
      wordLog: pda(enc.encode("word"), game.toBytes(), wordSeed(s.word)),
      setterAta: getAssociatedTokenAddressSync(MINT, setter),
      vault: pda(enc.encode("vault"), game.toBytes()), tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction());
  // revealer pays its own (tiny) fee — top it up with ~0.01 SOL on first arm, or sponsor via relayer.
  const sig = await connection.sendTransaction(tx, [kp]);
  await saveSecrets((await loadSecrets()).filter((x) => x.trap !== s.trap));
  return sig;
}
