// Runs N fast sim matches and prints a turn trace + outcome stats.
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { Game } from "../apps/server/src/engine.ts";
import { ScriptedAgent } from "../apps/server/src/agent.ts";
import { SimWallet } from "../apps/server/src/wallet.ts";
import { startCrowd } from "../apps/server/src/crowd.ts";
import { createServer } from "node:http";
import { handleRisk, requirement, simVerifier } from "../apps/server/src/oracle.ts";

let game: Game;
const srv = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c;
  handleRisk(req, res, b, { verifier: simVerifier, requirement: requirement("x", "pay", "solana-devnet"), ctx: () => game.riskContext() }); });
await new Promise<void>((r) => srv.listen(8798, r));
const N = Number(process.argv[2] ?? 1); let wins = 0;
for (let i = 0; i < N; i++) {
  const chain = new MockChain();
  game = new Game({ matchId: "t" + i, chain, agent: new ScriptedAgent(), wallet: new SimWallet(), oracleUrl: "http://127.0.0.1:8798", cfg: { windowMs: 30, revealGraceMs: 30 } });
  startCrowd(game, chain);
  if (N === 1) game.on("feed", (e: any) => { if (e.type !== "state" && e.type !== "turn_window") console.log(JSON.stringify(e).slice(0, 160)); });
  if (await game.run()) wins++;
  if (N === 1) { const pay = chain.finalize(); console.log("backer payouts", Object.fromEntries(pay), "vault", Number(chain.vault) / 1e6); }
}
console.log(`byte win rate ${wins}/${N}`); srv.close();
