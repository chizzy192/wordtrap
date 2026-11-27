// Browser test for the board and the side page with a signed-in player (mocked Pollar, scripts/stake-mock-server.ts).
// Needs the stake build made with VITE_POLLAR_PUBLISHABLE_KEY=<anything> VITE_WT_MOCK_POLLAR=1, headless Chrome, node 22+.
//   node scripts/browser-watch.mjs http://127.0.0.1:8808 http://127.0.0.1:8809 docs/design_reference/captures/watch
// Part B: after backing, the side page offers "Watch the run"; the board shows the backer's banner (stake and pool,
//         live), the board, the play-by-play, and no planting controls; one side per run; anyone can "Just watch".
// Part C: a signed-in player takes a seat in one run and backs another with zero name prompts; the header shows the
//         Google name; "Change name" lives in the header panel only.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [BASE, MOCK, OUT] = [process.argv[2] ?? "http://127.0.0.1:8808", process.argv[3] ?? "http://127.0.0.1:8809", process.argv[4] ?? "docs/design_reference/captures/watch"];
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9352;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); log(ok ? "  ok " : "  FAIL", what); };
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${process.env.TEMP ?? "/tmp"}/wt-chrome-watch-${Date.now()}`, "--window-size=1366,768", "about:blank"], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const handlers = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d.result ?? d.error); pending.delete(d.id); } else handlers.get(d.method)?.(d.params); };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
await send("Page.enable"); await send("Runtime.enable"); await send("Page.bringToFront");
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
handlers.set("Runtime.exceptionThrown", (p) => errors.push((p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n")[0]));
const goto = async (url) => { const loaded = new Promise((r) => handlers.set("Page.loadEventFired", r)); await send("Page.navigate", { url }); await loaded; await sleep(300); };
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) errors.push("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0]); return r.result?.value; };
const shot = async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(r.data, "base64")); log("saved", file); };
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(250); } };
const post = (path, body = {}) => fetch(`${MOCK}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const waitUrl = (re, ms) => until(() => ev("location.href").then((u) => (re.test(u) ? u : null)), ms);
const namePrompts = () => ev(`(() => { const a = document.getElementById("namePrompt"); const b = [...document.querySelectorAll(".popover")].filter(p => p.textContent.includes("What should we call you")); return (a && !a.hidden ? 1 : 0) + b.filter(p => p !== a).length; })()`);

const st = await post("/reset");
const stats = await fetch(`${MOCK}/stats`).then((r) => r.json());
await post("/credit", { micro: 20_000_000 });
const run1 = await post("/runs", { callsign: "Ada" }); const run2 = await post("/runs", { callsign: "Bob" });
log("runs", run1.runId, run2.runId, "player", stats.player);
let prompts = 0;

// ---------- Part C: signed in, take a seat in run 1 and back run 2, with zero name prompts ----------
await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__wtPollarMock = ${JSON.stringify({ token: "mock-token", address: stats.player, chain: MOCK })};` });
{
  const name = "side-seat";
  await goto(`${BASE}/side/${run1.runId}?theme=light`);
  await until(() => ev(`document.querySelector(".account .who")?.textContent === "Emmanuel Ofodile"`), 6000);
  check((await ev(`document.querySelector(".account .who")?.textContent`)) === "Emmanuel Ofodile", `${name}: the header shows the Google name (${await ev(`document.querySelector(".account .who")?.textContent`)})`);
  check(await ev(`[...document.querySelectorAll(".account button")].some(b => b.textContent === "Change name")`), `${name}: "Change name" in the header panel`);
  check((await ev(`document.querySelectorAll(".popover").length`)) === 0, `${name}: no popover for a signed-in player`);
  prompts += await namePrompts();
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent === "Take a seat").click(); 1`);
  const url = await waitUrl(/\/watch\//, 8000);
  check(!!url && url.includes(`/watch/${run1.runId}`), `${name}: Take a seat lands on the board (${url})`);
  await sleep(2500);
  prompts += await namePrompts();
  check((await ev(`document.getElementById("namePrompt").hidden && document.getElementById("firstVisit").hidden`)), `${name}: no name prompt and no first-visit panel on the board`);
  check(await ev(`!!document.querySelector("#seats .seat.you")`), `${name}: the seat is taken`);
  check((await ev(`document.querySelector("#account .who")?.textContent`)) === "Emmanuel Ofodile", `${name}: the board header shows the Google name`);
  check(await ev(`!!document.getElementById("changeName") && !document.getElementById("editName")`), `${name}: Change name only in the header (no Edit name on the seat row)`);
  check(!(await ev(`document.getElementById("plantToggle").hidden`)), `${name}: a seated player keeps the planter`);
  await shot(join(OUT, `${name}.png`));
}
{
  const name = "side-back";
  await goto(`${BASE}/side/${run2.runId}?theme=light`);
  await until(() => ev(`[...document.querySelectorAll("button")].some(b => b.textContent === "Back Byte with $5")`), 6000);
  prompts += await namePrompts();
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent === "Back Byte with $5").click(); 1`);
  const receipt = await until(() => ev(`document.querySelector(".receipt .rtitle")?.textContent ?? null`), 6000);
  check(receipt === "You backed Byte with $5", `${name}: receipt "${receipt}"`);
  prompts += await namePrompts();
  check((await ev(`document.querySelectorAll(".popover").length`)) === 0, `${name}: no popover after backing`);
  const watch = await ev(`document.querySelector('[data-wt="watch-run"]')?.getAttribute("href")`);
  check(watch === `/watch/${run2.runId}`, `${name}: "Watch the run" leads to the board (${watch})`);
  const noSeat = await until(() => ev(`document.querySelector('[data-wt="no-seat"]')?.textContent ?? null`), 4000);
  check(noSeat === "You backed Byte in this run, so you can't take a seat here. One side per run.", `${name}: the seat side is closed with the sentence ("${noSeat}")`);
  check(!(await ev(`[...document.querySelectorAll("button")].some(b => b.textContent === "Take a seat")`)), `${name}: no Take a seat button for a backer`);
  await shot(join(OUT, `${name}.png`));
  await ev(`document.querySelector('[data-wt="watch-run"]').click(); 1`);
  const url = await waitUrl(new RegExp(`/watch/${run2.runId}`), 8000);
  check(!!url, `${name}: Watch the run opened the board (${url})`);
}
// ---------- Part B: the backer's board ----------
{
  const name = "watch-backer";
  const banner = await until(() => ev(`document.getElementById("backerBanner").classList.contains("on") ? document.getElementById("backerBanner").textContent : null`), 8000);
  check(banner === "You backed Byte with $5.00. In the pool now $5.00", `${name}: banner "${banner}"`);
  check(await ev(`getComputedStyle(document.getElementById("plantToggle")).display === "none" && getComputedStyle(document.getElementById("plantPanel")).display === "none"`), `${name}: no planting controls (really not displayed)`);
  check(await ev(`getComputedStyle(document.getElementById("privateRow")).display === "none" && getComputedStyle(document.getElementById("privateText")).display !== "none"`), `${name}: a non-host sees the room setting as text, not the toggle`);
  check(!(await ev(`!!document.getElementById("takeSeat")`)) && (await ev(`document.getElementById("noSeat")?.textContent ?? ""`)).startsWith("You backed Byte in this run"), `${name}: no Take a seat; the sentence instead`);
  check(await ev(`document.getElementById("trapLink").hidden`), `${name}: no "Set a trap" link for a backer`);
  check(await ev(`document.querySelectorAll("#hand .card").length > 0 && !!document.getElementById("ticker") && !!document.getElementById("bubble")`), `${name}: the normal board, Byte's speech and the play-by-play`);
  check(await ev(`!!document.querySelector("#seats .seat")`), `${name}: seats are shown read-only`);
  prompts += await namePrompts();
  // live: another $1 from this player (through the API) moves both numbers without a reload
  await ev(`window.__wtAlive = 1`);
  await fetch(`${BASE}/runs/${run2.runId}/back-fiat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer mock-token" }, body: JSON.stringify({ amount: 1 }) });
  const live = await until(() => ev(`document.getElementById("backerBanner").textContent`).then((x) => (x === "You backed Byte with $6.00. In the pool now $6.00" ? x : null)), 8000);
  check(live === "You backed Byte with $6.00. In the pool now $6.00", `${name}: banner updates live ("${live}")`);
  check((await ev(`window.__wtAlive`)) === 1, `${name}: no reload`);
  await shot(join(OUT, `${name}.png`));
}
// ---------- Part B: anyone can "Just watch" without signing in ----------
{
  const name = "watch-anon";
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "delete window.__wtPollarMock;" });
  await ev(`localStorage.clear(); 1`);
  await goto(`${BASE}/watch/${run2.runId}?theme=light`);
  await sleep(1500);
  check(!(await ev(`document.getElementById("firstVisit").hidden`)), `${name}: the first-visit panel offers Just watch`);
  await ev(`document.getElementById("justWatch").click(); 1`); await sleep(300);
  check(await ev(`document.getElementById("firstVisit").hidden && document.getElementById("namePrompt").hidden`), `${name}: Just watch closes it, nothing else asks`);
  check(await ev(`document.querySelectorAll("#hand .card").length > 0 && !document.getElementById("backerBanner").classList.contains("on")`), `${name}: the board plays for a viewer with no account`);
  check(await ev(`document.getElementById("signInBtn") !== null`), `${name}: a Sign in button, no identity`);
}
check(prompts === 0, `zero name prompts across the whole flow (${prompts})`);
log("page errors:", errors.length ? errors.slice(0, 8) : "none");
check(errors.length === 0, "no page script errors");
log(failures.length ? `FAILED ${failures.length}: ${failures.join(" | ")}` : "all checks passed");
ws.close(); chrome.kill(); setTimeout(() => process.exit(failures.length ? 1 : 0), 200);
