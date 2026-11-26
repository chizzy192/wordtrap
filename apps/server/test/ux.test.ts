// Player-facing surfaces: no raw server error reaches a player, the lobby never auto-joins, the header carries a
// Rooms link, and /healthz says whether Pollar is configured by variable NAME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { PollarServerApi } from "../src/fiat.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("friendly(): raw server strings become plain sentences, player sentences pass through, junk falls back", async () => {
  const { friendly } = await import("../../watch/identity.js");
  assert.equal(friendly("sign in with Pollar: send Authorization: Bearer <session token>"), "Sign in to play.");
  assert.equal(friendly("demo-credit mode: send {user}"), "Sign in to play.");
  assert.equal(friendly("insufficient balance: have $0.00, need $5.00"), "Not enough funds. Add funds to play.");
  assert.equal(friendly("dev credits only exist in mock mode"), "Test funds aren't available on this server. Sign in with Google to add funds.");
  assert.equal(friendly("All four seats are taken. You can still back Byte."), "All four seats are taken. You can still back Byte.");
  assert.equal(friendly("Only the host can make the room private."), "Only the host can make the room private.");
  assert.equal(friendly("Names are 2 to 16 characters: letters, numbers, spaces and underscores."), "Names are 2 to 16 characters: letters, numbers, spaces and underscores.");
  for (const junk of ["unknown run abc", "Solana RPC: error", "TypeError: fetch failed", "500", "", undefined, null, "\"commitmentHex\" must be 64 hex chars"]) {
    assert.equal(friendly(junk), "That didn't work. Try again.", String(junk));
  }
  assert.equal(friendly(undefined, "Could not save the name."), "Could not save the name.");
});

test("the server's own identity errors are sentences, not protocol hints", async () => {
  const demo = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 } });
  const port = await demo.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/fiat/balance`);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "Sign in to play.");
  } finally { await demo.close(); }
});

test("pages print errors only through friendly(); the side page offers sign-in instead of an error and shows only the closed line when backing is closed", () => {
  for (const rel of ["../../watch/index.html", "../../watch/play.html"]) {
    const html = read(rel);
    assert.ok(/identity\.js"/.test(html) && html.includes("friendly"), `${rel} imports friendly`);
    assert.ok(!/textContent = (j|r|res|p)\.error\b/.test(html), `${rel} never prints a raw error body`);
    assert.ok(!/textContent = err\.message/.test(html) || !/throw new Error\(p\.error\b/.test(read("../../watch/identity.js")), `${rel} error messages come through friendly`);
  }
  const side = read("../../stake/src/SidePage.tsx");
  assert.ok(side.includes("Sign in to back Byte"), "sign-in button on the Back Byte card");
  assert.ok(side.includes('{msg && state?.backingOpen !== false && <p className="msg"'), "no message under the closed line");
  assert.ok(!/setMsg\(j\.error\b/.test(side), "no raw seat error");
  const app = read("../../stake/src/App.tsx");
  assert.ok(app.includes("throw new Error(friendly(j.error"), "api() throws friendly errors");
});

test("navigation: Rooms link beside the logo on the board and the side page, hidden in the small embed; the lobby never auto-joins without ?room=", () => {
  const watch = read("../../watch/index.html");
  assert.ok(watch.includes('<a class="nav" href="/play">Rooms</a>'), "watch header Rooms link");
  assert.ok(/\.nav \{ display: none;[^}]*\}/.test(watch) && /@media \(min-width: 760px\) and \(min-height: 480px\) \{[^@]*\.nav \{ display: inline-block; \}/.test(watch), "hidden in the small embed");
  const side = read("../../stake/src/SidePage.tsx");
  assert.ok(side.includes('<a className="nav" href="/play">Rooms</a>'), "side page Rooms link");
  const play = read("../../watch/play.html");
  assert.ok(play.includes('searchParams.get("room")'), "?room= opens that room");
  const script = play.slice(play.indexOf('<script type="module">'));
  // go() is only reached from a click, a submit, or the ?room= parameter: never from load
  const calls = [...script.matchAll(/\bgo\(/g)].length;
  assert.equal(calls, 4, "go() is defined once and called from join, code form and ?room= only");
  assert.ok(!/location\.(href|replace)\(?[^;]*\/side\//.test(script.replace(/function go\(code\)[^\n]*\n/, "")), "no other redirect into a side page");
});

test("/healthz reports Pollar by variable name only, never a value", async () => {
  const demo = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 } });
  const port = await demo.listen(0);
  try {
    const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(h.pollar, "missing");
    assert.ok(h.pollarMissing.includes("POLLAR_SECRET_KEY"));
    assert.ok(h.pollarMissing.some((m: string) => m.startsWith("VITE_POLLAR_PUBLISHABLE_KEY")));
  } finally { await demo.close(); }
  const secret = "sec_testnet_THISVALUEMUSTNEVERLEAK";
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, pollar: new PollarServerApi({ secretKey: secret, baseUrl: "http://127.0.0.1:1/v3" }), rpc: { getTransaction: async () => null, getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" } });
  const port2 = await app.listen(0);
  try {
    const raw = await fetch(`http://127.0.0.1:${port2}/healthz`).then((r) => r.text());
    assert.ok(!raw.includes(secret), "no key value in /healthz");
    const h = JSON.parse(raw);
    assert.ok(!h.pollarMissing.includes("POLLAR_SECRET_KEY"), "the server side is configured");
    assert.ok(["configured", "missing"].includes(h.pollar));
    const root = await fetch(`http://127.0.0.1:${port2}/api/v1/treasury`).then((r) => r.text());
    assert.ok(!root.includes(secret));
  } finally { await app.close(); }
});
