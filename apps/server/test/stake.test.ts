// Funds page (/stake/): Pollar's stylesheet is imported first at both app entries, the page uses the shonen system
// (no monospace, no purple, no all-caps labels, no rounded corners), the sections carry the agreed wording, the
// signature box is gone, and every error goes through friendly(). The browser test is scripts/browser-stake.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("stake: Pollar's stylesheet comes first at both entries and is themed to our tokens", () => {
  for (const rel of ["../../stake/src/main.tsx", "../../stake/src/side.tsx"]) {
    const src = read(rel);
    const pollar = src.indexOf('import "@pollar/react/styles.css"'), ours = src.search(/import "\.\/(stake|side)\.css"/);
    assert.ok(pollar >= 0 && ours > pollar, `${rel}: @pollar/react/styles.css before our css`);
  }
  for (const rel of ["../../stake/src/stake.css", "../../stake/src/side.css"]) {
    const css = read(rel);
    assert.ok(css.includes("--pollar-brand-bg:var(--sheet) !important") && css.includes("--pollar-brand-modal-border-radius:0px !important"), `${rel}: Pollar modals themed`);
    assert.ok(css.includes("--pollar-font-family:var(--sans) !important"), `${rel}: Pollar font`);
  }
});

test("stake: the shonen system, no monospace, purple or all-caps labels, no rounded corners", () => {
  const css = read("../../stake/src/stake.css");
  assert.ok(css.includes('"Barlow Condensed"') && css.includes('"Barlow"'), "fonts");
  assert.ok(!/monospace|IBM Plex|Bungee/i.test(css), "no monospace or display font");
  assert.ok(!/#9b7bff|purple/i.test(css), "no purple");
  assert.ok(!/text-transform:\s*uppercase/.test(css), "no all-caps labels");
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) assert.ok(/^(0|0px|50%)$/.test(m[1].trim()) || m[1].includes("!important"), `rounded corner: ${m[0]}`);
  assert.ok(css.includes("prefers-reduced-motion"), "reduced motion honoured");
  for (const state of [".btn:hover:not(:disabled)", ".btn:active:not(:disabled)", ".btn:disabled", ".btn:focus-visible"]) assert.ok(css.includes(state), `button state ${state}`);
  assert.ok(/@media \(min-width:760px\) \{ \.grid \{ grid-template-columns:/.test(css), "one column under 760px");
});

test("stake: sections and wording, no signature box, errors through friendly()", () => {
  const app = read("../../stake/src/App.tsx");
  for (const s of ['>Your account<', '>Add funds<', '>Your activity<', 'Move USDC from your Pollar wallet into the game to play.', 'Confirming your payment…', 'Your Pollar wallet is empty. <a href={FAUCET}', '(devnet test money)', 'No room is live right now', '>See rooms<', '>Set traps<', '>Back Byte<', 'No activity yet. Your top-ups and payouts will show here.', '>Sign in to add funds<', 'Play as guest with test funds', '"https://faucet.circle.com/"']) {
    assert.ok(app.includes(s), `wording: ${s}`);
  }
  assert.ok(app.includes('{`Add ${money(amt > 0 ? amt : 0)} to game`}'), "Add $n to game button");
  assert.ok(app.includes("setFunding({ step: \"done\", text: `Added ${usd("), "success line");
  assert.ok(!/transaction signature|confirmManual|Cash top-ups|Treasury: \{/.test(app), "signature box, manual confirm, roadmap and treasury sentences removed");
  assert.ok(!/plant\(|back-fiat|plant-fiat/.test(app), "no inline plant or back forms");
  assert.ok(app.includes("throw new Error(friendly(j.error))") && app.includes('setFunding({ step: "refused", text: friendly(e.message) })'), "errors through friendly()");
  assert.ok(app.includes("openWalletBalanceModal") && app.includes('data-wt="wallet"'), "our wallet button opens the SDK wallet modal");
  assert.ok(app.includes('useModalManners'), "Escape, focus trap and focus return for Pollar modals");
  // the server money endpoints are untouched
  const main = read("../src/main.ts");
  assert.ok(main.includes('p === "/api/v1/fiat/confirm"') && main.includes("confirmUsdcPayment("), "confirm endpoint kept");
});
