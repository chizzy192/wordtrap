// Ten-minute soak of the board inside the Byte Arena embed: DOM nodes, listeners, JS heap, documents, layout and
// script time are sampled every minute from Chrome's Performance metrics for a run played by the house Byte and the
// bots, then for the idle board after the run ends. Prints one line per sample and a verdict on growth.
//   node scripts/browser-embed-soak.mjs [minutes]          (needs headless Chrome; starts its own server)
import { MockChain } from "../apps/server/src/chain/mock.ts";
import { createApp } from "../apps/server/src/main.ts";
import { launchChrome, watchProblems } from "../apps/server/test/chrome.ts";

const MINUTES = Number(process.argv[2] ?? 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hdr = (user) => ({ "content-type": "application/json", "x-user": user });
const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 9, fuse: 600 }, bots: true, crowd: { setters: 4, aggression: 0.6, focus: 0.8, backerUsd: 20 }, houseDelayMs: 2500, firecrawl: null, datamuse: null, curatedDecks: [] });
const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr("guest-SOAKHOST1"), body: JSON.stringify({ amount: 20 }) });
const room = await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: hdr("guest-SOAKHOST1"), body: "{}" }).then((r) => r.json());
log("run", room.runId, "at", base);
const chrome = await launchChrome();
const page = await chrome.newPage();
const problems = watchProblems(page);
const host = `<!doctype html><meta charset="utf-8"><title>soak</title><body style="background:#111"><iframe id="f" src="${base}/watch/${room.runId}?theme=dark" width="640" height="360" style="border:0"></iframe></body>`;
await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/__soak*", requestStage: "Request" }] });
page.on("Fetch.requestPaused", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(host).toString("base64") }));
await page.send("Performance.enable");
await page.goto(`${base}/__soak`);
const sample = async () => {
  const m = Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const inFrame = await page.eval(`(() => { const d = document.getElementById("f").contentDocument; return { nodes: d.getElementsByTagName("*").length, ticker: d.getElementById("ticker").children.length, mines: d.getElementById("mines").children.length, meta: d.getElementById("meta").textContent }; })()`);
  const st = (await fetch(`${base}/runs/${room.runId}/spectate?delay=0`).then((r) => r.json())).state;
  return { t: Date.now(), nodes: m.Nodes, listeners: m.JSEventListeners, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), documents: m.Documents, frames: m.Frames, layouts: m.LayoutCount, script: +m.ScriptDuration.toFixed(1), task: +m.TaskDuration.toFixed(1), frameNodes: inFrame.nodes, ticker: inFrame.ticker, mines: inFrame.mines, meta: inFrame.meta, turn: st.turn, status: st.status };
};
const samples = [];
for (let i = 0; i <= MINUTES; i++) {
  const s = await sample(); samples.push(s);
  const prev = samples.at(-2);
  log(`min ${i}: nodes ${s.nodes} (frame ${s.frameNodes}) listeners ${s.listeners} heap ${s.heapMB} MB docs ${s.documents} script ${s.script}s${prev ? ` (+${(s.script - prev.script).toFixed(1)}s/min)` : ""} layouts ${s.layouts}${prev ? ` (+${s.layouts - prev.layouts})` : ""} · ${s.status} turn ${s.turn} · ticker ${s.ticker} mines ${s.mines} · ${s.meta}`);
  if (i < MINUTES) await sleep(60_000);
}
const idle = samples.filter((s) => s.status !== "live");
const first = idle[0] ?? samples.at(-1), last = samples.at(-1);
log(`problems: ${problems.list.length}`); for (const p of problems.list.slice(0, 10)) log("  ", p.kind, p.text);
log(`idle growth over ${idle.length - 1} min: nodes ${last.nodes - first.nodes}, listeners ${last.listeners - first.listeners}, heap ${(last.heapMB - first.heapMB).toFixed(1)} MB, script ${(last.script - first.script).toFixed(1)}s, layouts ${last.layouts - first.layouts}`);
page.close(); chrome.close(); await app.close(); process.exit(0);
