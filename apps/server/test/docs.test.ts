// Byte and docs: items 17–19 of the "rooms and rules" audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

test("17: the bytearena document starts with the JSON block, then prose under 2,500 characters that explains the four rules", () => {
  const doc = readFileSync(root("docs/BYTEARENA_SUBMISSION.md"), "utf8");
  assert.ok(doc.startsWith("```json\n"), "JSON block first");
  const end = doc.indexOf("\n```\n", 8);
  assert.ok(end > 0);
  const spec = JSON.parse(doc.slice(8, end));
  assert.deepEqual(spec, JSON.parse(readFileSync(root("byte.game.json"), "utf8")), "the JSON block is byte.game.json, verbatim");
  const prose = doc.slice(end + 5).trim();
  assert.ok(prose.length > 0 && prose.length <= 2500, `prose is ${prose.length} characters`);
  for (const term of ["safe card", "shield", "once", "nextHand"]) assert.ok(new RegExp(term, "i").test(prose), `prose explains: ${term}`);
  const playDesc = spec.api.actions.find((a: any) => a.name === "play_word").description;
  for (const term of ["safeCard", "shielded", "once per word", "nextHand"]) assert.ok(playDesc.includes(term), `play_word description mentions ${term}`);
  const gameSpec = readFileSync(root("docs/GAME_SPEC.md"), "utf8");
  for (const term of ["Safe card", "One penalty per word", "Shield", "nextHand"]) assert.ok(gameSpec.includes(term), `GAME_SPEC explains ${term}`);
});

test("18: watchUrl points at the dark, delayed watch page", () => {
  const spec = JSON.parse(readFileSync(root("byte.game.json"), "utf8"));
  // the server's default delay is already 4 s (SPECTATE_DELAY_SECONDS), so the query may carry it or leave it implicit
  assert.match(spec.api.watchUrl, /^https:\/\/wordtrap\.onrender\.com\/watch\/\{\{runId\}\}\?theme=dark(&delay=4)?$/);
  assert.equal(spec.api.baseUrl, "https://wordtrap.onrender.com");
});

test("19: ARCHITECTURE states that seats are enforced by the server, not on-chain", () => {
  const arch = readFileSync(root("docs/ARCHITECTURE.md"), "utf8");
  assert.match(arch, /Seats are enforced by the server, not on-chain/);
});
