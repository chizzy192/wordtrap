// Runs N seeded sim matches directly against Match (no game HTTP) with the local driver + crowd,
// prints a turn trace for N=1 and the tuning stats. Targets over 100 seeds:
//   survival 25–40% · mean detonations ≥ 2 · zero-boom runs ≤ 10%  (NO_BLURT=1: zero-boom ≤ 25%)
// Usage: node scripts/trace.ts [N] [seed]
//   CROWD_SETTERS / CROWD_AGGRESSION / CROWD_BACKER_USD  override the crowd
//   NO_BLURT=1   disable the driver's deliberate "play the obvious card" mistake (smart-Byte proxy)
import { createServer } from "node:http";
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { Match } from "../apps/server/src/match.ts";
import { decide } from "../apps/server/src/driver.ts";
import { SimWallet } from "../apps/server/src/wallet.ts";
import { startCrowd, crowdFromEnv } from "../apps/server/src/crowd.ts";
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
const crowd = crowdFromEnv();
const blurt = process.env.NO_BLURT !== "1";

let wins = 0, turns = 0, planted = 0, multi = 0;
const booms: number[] = [];
const firedStake: number[] = [];
for (let i = 0; i < N; i++) {
  const chain = new MockChain();
  match = new Match({ matchId: "t" + i, callsign: "trace", chain, wallet: new SimWallet(), oracleUrl, seed: SEED + i });
  startCrowd(match, chain, { ...crowd, rnd: seeded(SEED * 7919 + i) });
  match.on("feed", (e: any) => {
    if (e.type === "multi_boom") multi++;
    if (N === 1 && e.type !== "state") console.log(JSON.stringify(e).slice(0, 160));
  });
  let state = await match.start();
  while (state.status === "live") {
    const mv = decide(state, { blurt });
    state = await match.act(mv.action, { word: mv.word, turn: state.turn });
  }
  if (state.status === "escaped") wins++;
  const fired = state.traps.filter((t) => t.status === "fired");
  booms.push(fired.length);
  firedStake.push(fired.reduce((n, t) => n + t.stake, 0));
  turns += state.turn; planted += state.traps.length;
  if (N === 1) { const pay = chain.finalize(); console.log("backer payouts", Object.fromEntries(pay), "vault", Number(chain.vault) / 1e6); }
}
const mean = (a: number[]) => a.reduce((n, x) => n + x, 0) / Math.max(1, a.length);
const pct = (x: number) => `${Math.round(100 * x)}%`;
console.log(`crowd: setters ${crowd.setters} · aggression ${crowd.aggression} · focus ${crowd.focus} · backers $${crowd.backerUsd} · driver ${blurt ? "fallible (blurts obvious)" : "smart (NO_BLURT)"}`);
console.log(`survival ${wins}/${N} (${pct(wins / N)}) · avg turns ${(turns / N).toFixed(1)} · mines planted/run ${(planted / N).toFixed(1)}`);
console.log(`detonations/run mean ${mean(booms).toFixed(2)} min ${Math.min(...booms)} max ${Math.max(...booms)} · zero-boom runs ${pct(booms.filter((b) => b === 0).length / N)} · multi-booms ${multi} · mean fired stake/run $${mean(firedStake).toFixed(2)}`);
srv.close();
