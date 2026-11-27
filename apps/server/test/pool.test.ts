// The backers' pool is shown as three numbers plus the total on the board and the side page, and quiet mines'
// stakes join it only when the run ends (match.ts: unfiredStake is 0 while live).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("pool: the board and the side page show backers put in, bonuses paid, quiet mines and the total", () => {
  const board = read("../../watch/index.html");
  for (const s of ["Backers put in", "Bonuses paid", "Quiet mines", "In the pool now", 'id="poolIn"', 'id="poolBonus"', 'id="poolQuiet"', 'id="poolNow"', "Quiet mines join the pool when the run ends."]) assert.ok(board.includes(s), `board: ${s}`);
  assert.ok(board.includes('$("poolQuiet").textContent = "+" + fmt(s.unfiredStake ?? 0);') && board.includes('$("poolBonus").textContent = "−" + fmt(s.bonusesPaid ?? 0);'), "board rows come from the state");
  const side = read("../../stake/src/SidePage.tsx");
  for (const s of ["Backers put in", "Bonuses paid", "Quiet mines", "In the pool now", "state?.unfiredStake", "state?.bonusesPaid", "state?.backerTotal", "Quiet mines join the pool when the run ends."]) assert.ok(side.includes(s), `side: ${s}`);
});

test("pool: quiet mines' stakes count only once the run has ended, never when a tile is passed", () => {
  const match = read("../src/match.ts");
  assert.ok(match.includes('this.state.unfiredStake = this.state.status === "live" ? 0 : round6(s.traps.filter((t) => t.status !== "fired").reduce((n, t) => n + t.stake, 0));'), "unfiredStake is 0 while live");
  assert.ok(match.includes("this.state.poolNow = round6(this.state.backerTotal - this.state.bonusesPaid + this.state.unfiredStake);"), "poolNow = in − bonuses + quiet mines");
});
