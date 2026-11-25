import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, wordHash, toHex, trapFired, NO_CHALLENGE, tokenize, bountyFor, proRata } from "../src/index.ts";

test("hash vectors match the Rust program", () => {
  const c = commitment("apple", new Uint8Array(32).fill(7), new Uint8Array(32).fill(1));
  assert.equal(toHex(c), "b446aed69eb9e22cba84f7d432624e3bda5f7604b29f1e8cbaddea6266500cff");
  assert.equal(toHex(wordHash("apple")), "04582b2245265e936603c2b6db882d2f0f8b9f11d27b96a256358063ea370698");
});

test("trapFired mirrors the program", () => {
  assert.equal(trapFired([1, 2], NO_CHALLENGE, 3), false);
  assert.equal(trapFired([1, 3], NO_CHALLENGE, 3), true);
  assert.equal(trapFired([6], 4, 3), false);
  assert.equal(trapFired([3, 6], 4, 3), true);
  assert.equal(trapFired([6], 2, 3), true);
  assert.equal(trapFired([4], 4, 3), false);
});

test("tokenize normalizes speech", () => {
  assert.deepEqual(tokenize("Banana! banana—Kiwi's ok"), ["banana", "kiwis", "ok"]);
});

test("money math", () => {
  assert.equal(bountyFor(1_000_000n, 30_000, 10_000_000n), 2_000_000n);
  assert.equal(bountyFor(1_000_000n, 30_000, 500_000n), 500_000n);
  assert.equal(proRata(900n, 1n, 3n), 300n);
});
