// Frames composited per second by the board inside the embed while idle, measured in headless Chrome with no GPU
// (--disable-gpu, software compositing) from the DevTools timeline (DrawFrame events) over a 10 s window, in two
// idle states: a live run with Byte not moving, and a finished run once the page has replayed its feed.
//   node scripts/browser-embed-fps.mjs
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { createApp } from "../apps/server/src/main.ts";
import { launchChrome } from "../apps/server/test/chrome.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const WINDOW_MS = 10_000;
const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, bots: false, firecrawl: null, datamuse: null, curatedDecks: [] });
const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
const chrome = await launchChrome();
const page = await chrome.newPage();
let hostHtml = "";
const host = (runId) => `<!doctype html><meta charset="utf-8"><title>fps</title><body style="background:#111;margin:0"><iframe id="f" src="${base}/watch/${runId}?theme=dark" width="640" height="360" style="border:0"></iframe></body>`;
await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/__fps*", requestStage: "Request" }] });
page.on("Fetch.requestPaused", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(hostHtml).toString("base64") }));
const events = []; page.on("Tracing.dataCollected", (p) => events.push(...p.value));
async function measure(label) {
  events.length = 0;
  await page.send("Tracing.start", { traceConfig: { includedCategories: ["disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.timeline"], excludedCategories: ["*"] }, transferMode: "ReportEvents" });
  await sleep(WINDOW_MS);
  const done = new Promise((r) => page.on("Tracing.tracingComplete", () => r()));
  await page.send("Tracing.end"); await done;
  const count = (name) => events.filter((e) => e.name === name).length;
  const r = { draws: count("DrawFrame"), main: count("BeginMainThreadFrame"), raf: count("FireAnimationFrame"), layout: count("Layout"), paint: count("Paint") };
  log(`${label}: ${(r.draws / (WINDOW_MS / 1000)).toFixed(1)} composited frames/s (DrawFrame ${r.draws}, main-thread frames ${r.main}, rAF callbacks ${r.raf}, layouts ${r.layout}, paints ${r.paint} in ${WINDOW_MS / 1000} s)`);
  return r;
}
const caughtUp = async () => { for (let i = 0; i < 120; i++) { const [a, b] = [await page.eval(`document.getElementById("f").contentDocument.getElementById("ticker").innerHTML`), await (sleep(1500), page.eval(`document.getElementById("f").contentDocument.getElementById("ticker").innerHTML`))]; if (a === b) return; } };
// 1. a live run, Byte not moving
const live = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Idle" }) }).then((r) => r.json());
hostHtml = host(live.runId);
await page.goto(`${base}/__fps`); await sleep(6000); await caughtUp();
const liveIdle = await measure("live run, Byte not moving");
// 2. a finished run, once the page has replayed the feed
const done = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Fin" }) }).then((r) => r.json());
let s = done.state; const auth = { "content-type": "application/json", authorization: `Bearer ${done.apiKey}` };
while (s.status === "live") s = await fetch(`${base}/api/v1/runs/${done.runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ turn: s.turn, word: s.hand[0] }) }).then((r) => r.json());
hostHtml = host(done.runId);
await page.goto(`${base}/__fps`); await sleep(4000);
for (let i = 0; i < 200; i++) { if ((await page.eval(`document.getElementById("f").contentDocument.getElementById("end").className`)).includes("show")) break; await sleep(1000); }
await sleep(3000); await caughtUp();
const finished = await measure("finished run, feed replayed");
console.log(JSON.stringify({ liveIdle, finished }));
page.close(); chrome.close(); await app.close(); process.exit(0);
