// The board inside the Byte Arena embed. A real run driven over the API (house Byte, bots, a planted mine, a backer, a
// detonation, 25+ turns, a run that ends) is watched by an anonymous viewer in iframes at Byte Arena's sizes, with
// the tab hidden for a while, across a server restart, plus the preview page and a run that does not exist. Fails on
// any console error, thrown error, failed request or 4xx/5xx answer. Skips when Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { commitment, toHex } from "@wordtrap/shared";
import { PollarServerApi } from "../src/fiat.ts";
import { MockChain } from "../src/chain/mock.ts";
import { createApp, FRAME_CSP } from "../src/main.ts";
import { MemoryRunStore } from "../src/persist.ts";
import { chromeAvailable, launchChrome, watchProblems } from "./chrome.ts";

const hdr = (user: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-user": user, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[420, 320], [640, 360], [960, 540]];
const boot = (store: MemoryRunStore, port = 0) => {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 9, fuse: 600 }, bots: true, crowd: { setters: 4, aggression: 0.6, focus: 0.8, backerUsd: 20 }, houseDelayMs: 350, runStore: store, firecrawl: null, datamuse: null, curatedDecks: [] });
  return app.listen(port).then((p) => ({ app, port: p, base: `http://127.0.0.1:${p}` }));
};
const hostPage = (base: string, runId: string) => `<!doctype html><meta charset="utf-8"><title>embed host</title><body style="background:#111">${SIZES.map(([w, h]) => `<iframe id="f${w}" src="${base}/watch/${runId}?theme=dark" width="${w}" height="${h}" style="border:0;display:block;margin:4px"></iframe>`).join("")}</body>`;

test("embed: an anonymous viewer watches a whole run in the Byte Arena iframe sizes, hidden too, across a restart, with zero console errors and zero failed requests; preview and an unknown run never throw", { timeout: 480_000, skip: chromeAvailable() ? false : `Chrome not found at ${process.env.CHROME ?? "the default path"}` }, async () => {
  const store = new MemoryRunStore();
  let { app, port, base } = await boot(store);
  const chrome = await launchChrome();
  try {
    // ---- the run: a house room with bots, a seated guest who plants two mines, a backer ----
    const host = "guest-EMBEDHOST", backer = "guest-EMBEDBACK";
    for (const u of [host, backer]) await fetch(`${base}/dev/credit`, { method: "POST", headers: hdr(u), body: JSON.stringify({ amount: 20 }) });
    const room = await fetch(`${base}/api/v1/rooms`, { method: "POST", headers: hdr(host), body: "{}" }).then((r) => r.json());
    const runId: string = room.runId;
    const key = Uint8Array.from(Buffer.from((await fetch(`${base}/api/v1/treasury`).then((r) => r.json())).pubkeyHex, "hex"));
    const picker = await fetch(`${base}/runs/${runId}/picker`, { headers: hdr(host) }).then((r) => r.json());
    const items = (picker.nextHand?.hand ?? []).filter((w: string) => w !== picker.nextHand?.safe).slice(0, 2).map((w: string) => ({ commitmentHex: toHex(commitment(w, new Uint8Array(32).fill(7), key)), stake: 0.5 }));
    const planted = await fetch(`${base}/runs/${runId}/plant-fiat-batch`, { method: "POST", headers: hdr(host, { "x-seat-token": room.token }), body: JSON.stringify({ items }) }).then((r) => r.json());
    assert.ok(planted.results?.every((x: any) => x.ok), "mines planted");
    assert.equal((await fetch(`${base}/runs/${runId}/back-fiat`, { method: "POST", headers: hdr(backer), body: JSON.stringify({ amount: 5 }) })).status, 200, "backed");

    // ---- the viewer: a host page framing the board three times, served from the same origin so frame-ancestors 'self' admits it ----
    const page = await chrome.newPage();
    const problems = watchProblems(page);
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/__embed*", requestStage: "Request" }] });
    page.on("Fetch.requestPaused", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(hostPage(base, runId)).toString("base64") }));
    let spectates = 0; page.on("Network.requestWillBeSent", (p) => { if (p.request.url.includes("/spectate")) spectates++; });
    await page.goto(`${base}/__embed`);
    await sleep(4000);
    const framesUp = await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument?.querySelector("#hand")?.children.length ?? -1)`);
    assert.ok(framesUp.every((n: number) => n > 0), `every frame renders a hand (${framesUp})`);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll("iframe")].map((f) => [f.contentDocument.getElementById("firstVisit").hidden, f.contentDocument.getElementById("namePrompt").hidden])`), SIZES.map(() => [true, true]), "no panel asks an embedded viewer for anything");
    // light on the GPU inside the embed: the light class, nothing animating while idle, the flat background
    assert.deepEqual(await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument.body.classList.contains("light") && f.contentDocument.body.classList.contains("embed"))`), SIZES.map(() => true), "body.light and body.embed in every frame");
    assert.deepEqual(await page.eval(`[...document.querySelectorAll("iframe")].map((f) => getComputedStyle(f.contentDocument.body).backgroundImage)`), SIZES.map(() => "none"), "no halftone texture in the embed");
    // every link to the full site opens a new tab with an absolute address; the address is shown as text; nothing calls window.open
    const links = await page.eval(`[...document.getElementById("f640").contentDocument.querySelectorAll('a[href*="/play"], a[href*="/side/"], a[href*="/stake/"]')].map((a) => [a.getAttribute("href"), a.target, a.rel])`);
    assert.ok(links.length >= 4 && links.every(([h, t, r]: string[]) => /^http:\/\/127\.0\.0\.1:\d+\//.test(h) && t === "_blank" && r === "noopener"), `site links are absolute, target _blank, rel noopener (${JSON.stringify(links)})`);
    assert.equal(await page.eval(`document.getElementById("f640").contentDocument.getElementById("playAt").textContent`), `Play at 127.0.0.1:${port}/play`, "the address as text");

    // ---- hidden tab: polling goes on ----
    await page.send("Page.setWebLifecycleState", { state: "hidden" });
    const before = spectates; await sleep(6000);
    assert.ok(spectates - before >= 6, `polling continues while hidden (${spectates - before} spectate requests in 6 s)`);
    await page.send("Page.setWebLifecycleState", { state: "active" });

    // ---- the run plays out: 25+ turns, a detonation, a backer ----
    let s: any = null;
    for (let i = 0; i < 400; i++) { s = (await fetch(`${base}/runs/${runId}/spectate?delay=0`).then((r) => r.json())).state; if (s.status !== "live") break; await sleep(500); }
    assert.ok(s && s.status !== "live", `the run ended (${s?.status})`);
    assert.ok(s.turn >= 25, `at least 25 turns (${s.turn})`);
    assert.ok(s.traps.some((t: any) => t.status === "fired"), "a mine went off");
    assert.ok(s.backerTotal >= 5, `backers in the pool ($${s.backerTotal})`);
    // the frames catch up (events are paced on the page) and show the end
    let shown: any = null;
    for (let i = 0; i < 300; i++) { shown = await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument?.getElementById("end")?.className ?? "")`); if (shown.some((c: string) => c.includes("show"))) break; await sleep(1000); }
    assert.ok(shown.some((c: string) => c.includes("show")), `a frame shows the end (${shown})`);
    await sleep(3000);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument.getAnimations().filter((a) => a.playState === "running").length)`), SIZES.map(() => 0), "nothing animates once the run is over and the feed is replayed");
    const fused = await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument?.getElementById("fuseSec")?.textContent)`);
    assert.ok(fused.every((f: string) => /^\d+$/.test(f)), `every frame shows the fuse (${fused})`);
    assert.deepEqual(problems.list, [], `zero console errors, exceptions, failed requests or 4xx/5xx for the whole run:\n${problems.list.map((p) => `${p.kind}: ${p.text}`).join("\n")}`);

    // ---- a restart: the run comes back on the same port and the frames keep polling it ----
    const t0 = Date.now();
    await app.close();
    ({ app, port, base } = await boot(store, port));
    assert.ok(app.runs.get(runId)?.restored, "restored");
    await sleep(5000);
    const afterRestart = problems.since(t0).filter((p) => !/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_FAILED|ERR_EMPTY_RESPONSE/.test(p.text));   // the seconds the server was down are expected to fail
    assert.deepEqual(afterRestart, [], `nothing thrown around the restart:\n${afterRestart.map((p) => `${p.kind}: ${p.text}`).join("\n")}`);
    const metas = await page.eval(`[...document.querySelectorAll("iframe")].map((f) => f.contentDocument?.getElementById("meta")?.textContent)`);
    assert.ok(metas.every((m: string) => /finished on turn/.test(m)), `the frames follow the restored run (${metas})`);
    const feed = await fetch(`${base}/runs/${runId}/spectate?after=${s.turn}`).then((r) => r.json());
    assert.ok(feed.seq > 0 && Array.isArray(feed.events), "the cursor still works after the restart");

    // ---- the preview page and a run that does not exist: nothing throws ----
    const t1 = Date.now();
    await page.eval(`document.getElementById("f420").src = "${base}/watch/preview?theme=dark"; document.getElementById("f640").src = "${base}/watch/nope12345?theme=dark"; 1`);
    await sleep(5000);
    const thrown = problems.since(t1).filter((p) => !/nope12345/.test(p.text));   // a missing run answers 404 to the poll, by design, and the page says so; the preview must be clean
    assert.deepEqual(thrown, [], `preview and an unknown run never throw:\n${thrown.map((p) => `${p.kind}: ${p.text}`).join("\n")}`);
    const texts = await page.eval(`[...document.querySelectorAll("iframe")].slice(0, 2).map((f) => f.contentDocument?.getElementById("meta")?.textContent)`);
    assert.ok(/is playing, turn 1/.test(texts[0]) && /not available \(404\)/.test(texts[1]), `the preview shows a sample board and the unknown run says so (${texts})`);
    assert.ok((await page.eval(`document.getElementById("f420").contentDocument.querySelectorAll("#hand .card").length`)) > 0, "the preview deals a hand");
    page.close();
  } finally { chrome.close(); await app.close(); }
});

test("embed: the live 401 case: a viewer whose wallet identity has no session token (Pollar mode) gets no 4xx at all, framed or not; my-position is never asked in the embed and is 200 for anyone", { timeout: 120_000, skip: chromeAvailable() ? false : "Chrome not found" }, async () => {
  // Pollar mode with a verify stub that rejects every token: the server behaves as the live one did for a stale session
  const verify = createServer((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "TOKEN_INVALID", success: false })); });
  await new Promise<void>((r) => verify.listen(0, "127.0.0.1", r));
  const gw = new PollarServerApi({ secretKey: "sec_testnet_mock0000000000000000", baseUrl: `http://127.0.0.1:${(verify.address() as any).port}/v3`, log: () => {} });
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, pollar: gw, supabase: null, firecrawl: null, datamuse: null, curatedDecks: [], bots: false });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const chrome = await launchChrome();
  try {
    const { runId } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "Ada" }) }).then((r) => r.json());
    const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    // the server side of the fix: no identity, a wallet with no token, and an expired token all get 200 from my-position
    for (const headers of [{}, { "x-user": WALLET }, { authorization: "Bearer stale-token" }]) {
      const r = await fetch(`${base}/runs/${runId}/my-position`, { headers }); assert.equal(r.status, 200, JSON.stringify(headers));
      const j = await r.json(); assert.equal(j.side, "none"); assert.equal(j.user, null); assert.equal(j.canWatch, true);
    }
    const page = await chrome.newPage();
    const problems = watchProblems(page);
    let mypos = 0, spectates = 0; page.on("Network.requestWillBeSent", (p) => { if (p.request.url.includes("/my-position")) mypos++; if (p.request.url.includes("/spectate")) spectates++; });
    const stale = `localStorage.clear(); localStorage.setItem("wt.identity", "${WALLET}"); localStorage.setItem("wt.identity.mode", "wallet"); localStorage.setItem("wt.identity.choice", "1");`;
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/__embed*", requestStage: "Request" }] });
    page.on("Fetch.requestPaused", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(`<!doctype html><meta charset="utf-8"><title>h</title><script>${stale}</script><body><iframe id="f640" src="${base}/watch/${runId}?theme=dark" width="640" height="360" style="border:0"></iframe></body>`).toString("base64") }));
    await page.goto(`${base}/__embed`); await sleep(7000);
    assert.equal(mypos, 0, "my-position is never asked from the embed");
    assert.ok(spectates >= 3, `the board polls (${spectates})`);
    assert.deepEqual(problems.list, [], `no 4xx, no errors, framed:\n${problems.list.map((p) => `${p.kind}: ${p.text}`).join("\n")}`);
    assert.ok(await page.eval(`[...document.getElementById("f640").contentDocument.querySelectorAll("#account a, #account button")].some((e) => e.textContent === "Sign in")`), "the stale identity reads as signed out");
    // the same viewer at the top level (not framed): still no 4xx; the stale identity is forgotten, so nothing asks for a profile or a balance
    problems.clear(); mypos = 0;
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stale });
    await page.goto(`${base}/watch/${runId}?theme=dark`); await sleep(7000);
    assert.equal(mypos, 0, "no identity, so my-position is not asked");
    assert.deepEqual(problems.list, [], `no 4xx, no errors, top level:\n${problems.list.map((p) => `${p.kind}: ${p.text}`).join("\n")}`);
    assert.equal(await page.eval(`localStorage.getItem("wt.identity")`), null, "the stale wallet identity was forgotten");
    page.close();
  } finally { chrome.close(); await app.close(); verify.close(); }
});

test("embed: the board answers with text/html and the frame-ancestors policy; no script navigates the top window or opens a dialog", async () => {
  const store = new MemoryRunStore();
  const { app, base } = await boot(store);
  try {
    const r = await fetch(`${base}/watch/anything`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type")!.startsWith("text/html"), "text/html");
    assert.equal(r.headers.get("content-security-policy"), FRAME_CSP);
    assert.ok(/frame-ancestors[^;]*https:\/\/app\.bytearena\.fun/.test(FRAME_CSP), "frame-ancestors https://app.bytearena.fun");
    assert.equal((await fetch(`${base}/watch/preview`)).status, 200);
  } finally { await app.close(); }
  const html = readFileSync(fileURLToPath(new URL("../../watch/index.html", import.meta.url)), "utf8");
  const script = html.slice(html.indexOf("<script type=\"module\">"));
  assert.ok(!/\btop\.location|window\.top\.(location|postMessage)|parent\.location/.test(script), "never navigates the top window");
  assert.ok(!/\balert\(|\bconfirm\(|\bprompt\(/.test(script), "no alert, confirm or prompt");
  assert.ok(!/window\.open\(/.test(script), "nothing calls window.open");
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  for (const bad of ["backdrop-filter:", "mix-blend-mode:", "will-change:"]) assert.ok(!css.includes(bad) || css.includes(`body.light * { will-change: auto`), `no ${bad} in the board CSS`);
  assert.ok(/body\.light #spark\.idle::before, body\.light #spark\.idle::after, body\.light #fuseSec\.low/.test(css), "the continuous animations are off in light mode");
  assert.ok(/window\.addEventListener\("error"/.test(script) && /unhandledrejection/.test(script), "one global handler for errors and rejections");
  assert.ok(/Reconnecting…/.test(script) && /QUEUE_MAX/.test(script) && /EMBEDDED/.test(script), "backoff, a bounded queue, embed awareness");
});
