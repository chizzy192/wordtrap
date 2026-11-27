// Browser test for the funds page (/stake/). Needs a running server (arg 1) whose apps/stake build was made WITH a
// VITE_POLLAR_PUBLISHABLE_KEY (any value: the SDK mounts and its login modal opens without a real key), headless Chrome,
// and node 22+. Saves captures to docs/design_reference/captures/stake/ (arg 2). Exits 1 on any failed check.
//   node scripts/browser-stake.mjs http://127.0.0.1:8802 docs/design_reference/captures/stake
// Part A: the Pollar modal opened from the wallet button sits inside the viewport over a fixed dimmed backdrop, no svg or
//         img inside it is wider than 200 px, focus is inside it, Escape and the X close it.
// Part B: signed-out hero, empty-wallet and funded states (via ?demo= fixtures) at 1366x768 and 390x844, light and dark.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [BASE, OUT] = [process.argv[2] ?? "http://127.0.0.1:8802", process.argv[3] ?? "docs/design_reference/captures/stake"];
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9350;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); log(ok ? "  ok " : "  FAIL", what); };
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${process.env.TEMP ?? "/tmp"}/wt-chrome-stake-test`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const handlers = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d.result ?? d.error); pending.delete(d.id); } else handlers.get(d.method)?.(d.params); };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
await send("Page.enable"); await send("Runtime.enable"); await send("Page.bringToFront");
handlers.set("Runtime.exceptionThrown", (p) => errors.push((p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n")[0]));
const goto = async (url) => { const loaded = new Promise((r) => handlers.set("Page.loadEventFired", r)); await send("Page.navigate", { url }); await loaded; await send("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>1)", awaitPromise: true }); };
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) errors.push("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0]); return r.result?.value; };
const vp = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
const shot = async (file, full = false) => { const m = await send("Page.getLayoutMetrics"); const h = full ? Math.min(6000, Math.ceil(m.cssContentSize.height)) : m.cssLayoutViewport.clientHeight; const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, clip: { x: 0, y: 0, width: m.cssLayoutViewport.clientWidth, height: h, scale: 1 } }); writeFileSync(file, Buffer.from(r.data, "base64")); log("saved", file); };
const press = async (k, code, vk) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); };
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const modalProbe = `(() => { const card = document.querySelector(".pollar-overlay .pollar-modal-card"); if (!card) return { open: false }; const r = card.getBoundingClientRect(); const media = [...card.querySelectorAll("svg, img")].map(e => Math.round(e.getBoundingClientRect().width)); const overlay = card.closest(".pollar-overlay"); const os = getComputedStyle(overlay); const cs = getComputedStyle(card); return { open: true, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, widestMedia: Math.max(0, ...media), mediaCount: media.length, overlayPosition: os.position, overlayBg: os.backgroundColor, overlayZ: os.zIndex, focusInside: card.contains(document.activeElement), radius: cs.borderRadius, font: cs.fontFamily.slice(0, 30), bg: cs.backgroundColor }; })()`;

// ---------- Part B: the three states, both themes, both sizes ----------
for (const theme of ["light", "dark"]) {
  for (const [w, h] of [[1366, 768], [390, 844]]) {
    for (const state of ["signedout", "empty", "funded"]) {
      await vp(w, h);
      await goto(`${BASE}/stake/?demo=${state}&theme=${theme}`); await sleep(1500);
      const name = `after-${state}-${theme}-${w}x${h}`;
      log(name);
      check(!(await ev("document.documentElement.scrollWidth > innerWidth")), `${name}: no horizontal scroll`);
      check((await ev(`getComputedStyle(document.body).fontFamily`)).includes("Barlow"), `${name}: Barlow body font`);
      check(await ev(`!!document.querySelector("header .wordmark img") && !!document.querySelector('header a.nav[href="/play"]') && !!document.getElementById("themeBtn")`), `${name}: shared header (wordmark, Rooms, theme switch)`);
      if (state === "signedout") {
        check((await text(".strip h1")) === "Sign in to add funds", `${name}: hero title`);
        check(await ev(`[...document.querySelectorAll("button")].some(b => b.textContent === "Sign in with Google")`), `${name}: sign-in button`);
        check(await ev(`[...document.querySelectorAll("a")].some(a => a.textContent === "Play as guest with test funds" && a.getAttribute("href") === "/play")`), `${name}: guest link to /play`);
        check(!(await ev(`!!document.querySelector(".tiles")`)), `${name}: no account card while signed out`);
      } else {
        const order = await ev(`[...document.querySelectorAll("main h2, .panel h2")].map(h => h.textContent)`);
        check(JSON.stringify(order) === JSON.stringify(["Your account", "Add funds", "Oly is playing", "Your activity"]), `${name}: sections in order (${order})`);
        check((await text(".sentence")) === "Move USDC from your Pollar wallet into the game to play.", `${name}: account sentence`);
        check(await ev(`[...document.querySelectorAll(".chip")].map(c => c.textContent).join(",") === "$1,$2,$5,$10,Other amount"`), `${name}: amount chips`);
        const btn = await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /^Add \\$5 to game$/.test(b.textContent)); return b ? { disabled: b.disabled } : null; })()`);
        check(btn !== null, `${name}: "Add $5 to game" button`);
        check(!(await ev(`document.body.textContent.includes("transaction signature") || document.body.textContent.includes("Cash top-ups") || document.body.textContent.includes("Treasury:")`)), `${name}: no signature box, treasury sentence or roadmap line`);
        check(await ev(`[...document.querySelectorAll("a.btn")].filter(a => a.getAttribute("href") === "/side/demo").map(a => a.textContent).join(",") === "Set traps,Back Byte"`), `${name}: live room buttons go to /side/<runId>`);
        check(await ev(`[...document.querySelectorAll("button")].some(b => b.textContent === "Sign out")`), `${name}: Sign out`);
        if (state === "empty") {
          check(btn?.disabled === true, `${name}: add button disabled with an empty wallet`);
          check((await text(".notice"))?.startsWith("Your Pollar wallet is empty. Get test USDC (devnet test money)") ?? false, `${name}: empty-wallet notice`);
          check((await ev(`document.querySelector(".notice a")?.getAttribute("href")`)) === "https://faucet.circle.com/", `${name}: faucet link`);
          check((await text(".rows, .panel .empty")) === "No activity yet. Your top-ups and payouts will show here.", `${name}: empty activity`);
        } else {
          check(btn?.disabled === false, `${name}: add button enabled when funded`);
          check(await ev(`[...document.querySelectorAll(".rows li")].length === 3 && document.querySelector(".rows li").textContent.includes("Added to game")`), `${name}: activity rows`);
          check((await ev(`document.querySelector(".pill b")?.textContent`)) === "$8.00" && (await ev(`document.querySelector(".pill.yellow b")?.textContent`)) === "$2.00", `${name}: header balances`);
        }
      }
      await shot(join(OUT, `${name}.png`), true);
    }
  }
}

// ---------- Part A: the Pollar modal (login modal from the wallet button while signed out) ----------
for (const theme of ["light", "dark"]) {
  await vp(1366, 768);
  await goto(`${BASE}/stake/?theme=${theme}`); await sleep(1800);
  const name = `after-modal-${theme}`;
  const wb = await ev(`(() => { const b = document.querySelector('[data-wt="wallet"]'); if (!b) return null; const r = b.getBoundingClientRect(); const h = document.querySelector("header").getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), header: Math.round(h.height), text: b.textContent }; })()`);
  log(name, "wallet button", JSON.stringify(wb));
  check(wb && wb.h <= 40, `${name}: wallet button is 40 px tall (${wb?.h})`);
  await ev(`document.querySelector('[data-wt="wallet"]').click(); 1`); await sleep(1500);
  const m = await ev(modalProbe);
  log(name, JSON.stringify(m));
  check(m.open, `${name}: modal opens`);
  if (m.open) {
    check(m.inside, `${name}: modal box inside the viewport ${JSON.stringify(m.box)}`);
    check(m.widestMedia <= 200, `${name}: widest svg/img ${m.widestMedia}px ≤ 200`);
    check(m.overlayPosition === "fixed" && m.overlayBg !== "rgba(0, 0, 0, 0)", `${name}: fixed dimmed backdrop (${m.overlayPosition}, ${m.overlayBg})`);
    check(m.focusInside, `${name}: focus inside the modal`);
    check(m.radius === "0px" && m.font.includes("Barlow"), `${name}: themed (radius ${m.radius}, font ${m.font})`);
    await shot(join(OUT, `${name}.png`));
    await press("Tab", "Tab", 9); await press("Tab", "Tab", 9);
    check(await ev(`!!document.querySelector(".pollar-overlay .pollar-modal-card")?.contains(document.activeElement)`), `${name}: focus stays inside after Tab`);
    await press("Escape", "Escape", 27); await sleep(500);
    check(!(await ev(modalProbe)).open, `${name}: Escape closes`);
    await ev(`document.querySelector('[data-wt="wallet"]').click(); 1`); await sleep(1200);
    await ev(`document.querySelector('.pollar-overlay .pollar-modal-close, .pollar-overlay [aria-label="Close"]')?.click(); 1`); await sleep(500);
    check(!(await ev(modalProbe)).open, `${name}: X closes`);
  }
}
// ---------- Part C: the readiness gate. When the server cannot credit (the 428 case), nothing is sent. ----------
{
  await vp(1366, 768);
  let sendCalls = 0, confirmCalls = 0;
  // Any payment or claim the page might send is counted and failed; the readiness gate must keep both at zero.
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/wallet/solana/transfer*", requestStage: "Request" }, { urlPattern: "*/api/v1/fiat/confirm*", requestStage: "Request" }] });
  handlers.set("Fetch.requestPaused", (p) => {
    if (p.request.url.includes("/wallet/solana/transfer")) sendCalls++; else confirmCalls++;
    return send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" });
  });
  await goto(`${BASE}/stake/?demo=funded&ready=0&theme=light`); await sleep(1500);   // the 428 case: the server has no wallet it can credit
  const name = "after-gate-428";
  const btn = await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /^Add \\$5 to game$/.test(b.textContent)); return b ? { disabled: b.disabled } : null; })()`);
  check(btn !== null, `${name}: add button present`);
  check(btn?.disabled === true, `${name}: add button disabled while the server cannot credit`);
  check((await ev(`document.querySelector('[data-wt="link"] p')?.textContent ?? ""`)).startsWith("We couldn't find your Solana wallet with Pollar."), `${name}: the server's sentence is shown`);
  check(await ev(`[...document.querySelectorAll("button")].some(b => b.textContent === "Start the wallet check")`), `${name}: the one-time wallet check is offered`);
  await ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => /^Add \\$5 to game$/.test(b.textContent)); if (b) { b.disabled = false; b.click(); } })()`); await sleep(1200);
  check(sendCalls === 0 && confirmCalls === 0, `${name}: a forced click sends nothing (transfer calls ${sendCalls}, confirm calls ${confirmCalls})`);
  await shot(join(OUT, `${name}.png`), true);
  await send("Fetch.disable");
}
log("page errors:", errors.length ? errors.slice(0, 8) : "none");
check(errors.length === 0, "no page script errors");
log(failures.length ? `FAILED ${failures.length}: ${failures.join(" | ")}` : "all checks passed");
ws.close(); chrome.kill(); setTimeout(() => process.exit(failures.length ? 1 : 0), 200);
