// Runs N seeded sim matches directly against Match (no game HTTP) with the local driver + crowd,
// prints a turn trace for N=1 and the win rate. Target: Byte escapes 25–40% of the time.
// Usage: node scripts/trace.ts [N] [seed]   (CROWD_SETTERS / CROWD_AGGRESSION env override the crowd)
import { createServer } from "node:http";
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { Match } from "../apps/server/src/match.ts";
import { decide } from "../apps/server/src/driver.ts";
import { SimWallet } from "../apps/server/src/wallet.ts";
import { startCrowd } from "../apps/server/src/crowd.ts";
import { handleRisk, requirement, simVerifier } from "../apps/server/src/oracle.ts";

// The x402 oracle is still an HTTP service (that is the product); the game itself is driven in-process.
let match: Match;
const srv = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  handleRisk(req, res, b, { verifier: simVerifier, requirement: requirement("x", "pay", "solana-devnet"), ctx: () => match.riskContext() });
});
await new Promise<void>((r) => srv.listen(0, r));
const oracleUrl = `http://127.0.0.1:${(srv.address() as any).port}`;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const N = Number(process.argv[2] ?? 1);
const SEED = Number(process.argv[3] ?? 1);
let wins = 0, turns = 0, fired = 0, planted = 0;
for (let i = 0; i < N; i++) {
  const chain = new MockChain();
  match = new Match({ matchId: "t" + i, callsign: "trace", chain, wallet: new SimWallet(), oracleUrl, seed: SEED + i });
  startCrowd(match, chain, {
    rnd: seeded(SEED * 7919 + i),
    ...(process.env.CROWD_SETTERS ? { setters: Number(process.env.CROWD_SETTERS) } : {}),
    ...(process.env.CROWD_AGGRESSION ? { aggression: Number(process.env.CROWD_AGGRESSION) } : {}),
  });
  if (N === 1) match.on("feed", (e: any) => { if (e.type !== "state") console.log(JSON.stringify(e).slice(0, 160)); });
  let state = await match.start();
  while (state.status === "live") {
    const mv = decide(state);
    state = await match.act(mv.action, { word: mv.word, turn: state.turn });
  }
  if (state.status === "escaped") wins++;
  turns += state.turn; planted += state.traps.length; fired += state.traps.filter((t) => t.status === "fired").length;
  if (N === 1) { const pay = chain.finalize(); console.log("backer payouts", Object.fromEntries(pay), "vault", Number(chain.vault) / 1e6); }
}
console.log(`byte win rate ${wins}/${N} (${Math.round((100 * wins) / N)}%) · avg turns ${(turns / N).toFixed(1)} · mines fired ${fired}/${planted}`);
srv.close();
