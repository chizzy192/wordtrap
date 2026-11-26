// No single failed request or background task may take the server down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { commitment, toHex } from "@wordtrap/shared";
import { MockChain } from "../src/chain/mock.ts";
import { createApp, installProcessGuards } from "../src/main.ts";
import { startCrowd } from "../src/crowd.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function boot() {
  const app = createApp({ sim: false, makeChain: async () => { const c = new MockChain(); await c.backByte("alice", 10); return c; }, ledgerPath: null, cfg: { tiles: 2 }, spectateDelay: 0 });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { runId, apiKey, state } = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "r" }) }).then((r) => r.json());
  const auth = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  const healthy = async () => { const r = await fetch(`${base}/healthz`); assert.equal(r.status, 200); return r.json(); };
  const current = async () => fetch(`${base}/api/v1/runs/${runId}/state`, { headers: auth }).then((r) => r.json());
  return { app, base, port, runId, apiKey, auth, state, healthy, current };
}
/** Sends raw bytes of a request and drops the connection before it is complete. */
function dropMidRequest(port: number, raw: string, afterMs = 80) {
  return new Promise<void>((resolve) => {
    const s = connect(port, "127.0.0.1", () => { s.write(raw); setTimeout(() => { s.destroy(); resolve(); }, afterMs); });
    s.on("error", () => resolve());
  });
}

test("a client that disconnects mid-request during /play, /spectate and /plant-fiat leaves the server and the run intact", async () => {
  const { app, port, base, runId, apiKey, auth, healthy, current } = await boot();
  const before = await current();
  // /play: headers promise a body that never arrives, then the socket dies
  await dropMidRequest(port, `POST /api/v1/runs/${runId}/play HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${apiKey}\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{"word":"`);
  // /spectate: request line only, no terminating blank line
  await dropMidRequest(port, `GET /runs/${runId}/spectate?after=0 HTTP/1.1\r\nHost: x\r\n`);
  // /spectate: complete request, connection dropped before the response is read
  await dropMidRequest(port, `GET /runs/${runId}/spectate HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`, 5);
  // /plant-fiat: half a JSON body
  await dropMidRequest(port, `POST /runs/${runId}/plant-fiat HTTP/1.1\r\nHost: x\r\nx-user: guest-DROPDROP1\r\nContent-Type: application/json\r\nContent-Length: 120\r\n\r\n{"commitmentHex":"ab`);
  await sleep(150);
  assert.deepEqual(await healthy(), { ok: true });
  const after = await current();
  assert.equal(after.turn, before.turn, "no move was applied");
  assert.deepEqual(after.traps, before.traps, "no mine was planted");
  assert.deepEqual(after.hand, before.hand);
  // and a normal request still works afterwards
  const play = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: before.hand.find((w: string) => w !== before.safe) }) });
  assert.equal(play.status, 200);
  assert.equal((await play.json()).turn, before.turn + 1);
  await app.close();
});

test("a bot whose plant call fails, or whose hook throws, cannot fail Byte's move", async () => {
  const { app, base, runId, auth, healthy, current } = await boot();
  const run = app.runs.get(runId)!;
  const chain = run.chain as MockChain;
  // bots: every plant blows up
  const realPlant = chain.plantTrap.bind(chain);
  chain.plantTrap = async () => { throw new Error("rpc down"); };
  startCrowd(run.match, chain, { aggression: 1 });
  // and a viewer hook that throws outright, on both the turn and the reveal path
  run.match.turnHooks.push(async () => { throw new Error("bot exploded"); });
  run.match.afterWords.push(async () => { throw new Error("revealer exploded"); });
  const before = await current();
  const errors: string[] = [];
  const orig = console.error; console.error = (...a: unknown[]) => { errors.push(String(a[0])); };
  let res: Response;
  try { res = await fetch(`${base}/api/v1/runs/${runId}/play`, { method: "POST", headers: auth, body: JSON.stringify({ word: before.hand.find((w: string) => w !== before.safe) }) }); }
  finally { console.error = orig; }
  assert.equal(res!.status, 200);
  const after = await res!.json();
  assert.equal(after.turn, before.turn + 1, "Byte's move went through");
  assert.equal(after.spoken.length, 1);
  assert.ok(errors.some((l) => /hook failed/.test(l)), "the failure was logged, not swallowed");
  assert.deepEqual(await healthy(), { ok: true });
  chain.plantTrap = realPlant;
  await app.close();
});

test("a failed oracle call during buy_hint burns the fuse, leaves hint empty, and the server keeps answering", async () => {
  const { app, base, runId, auth, healthy, current } = await boot();
  const before = await current();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).includes("/oracle/risk")) throw new TypeError("fetch failed: oracle unreachable");
    return realFetch(input, init);
  }) as typeof fetch;
  let hint: any;
  try { hint = await realFetch(`${base}/api/v1/runs/${runId}/hint`, { method: "POST", headers: auth, body: "{}" }).then((r) => r.json()); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(hint.turn, before.turn + 1);
  assert.equal(hint.fuse, before.fuse - 3, "the cost is still paid");
  assert.deepEqual(hint.hint, {}, "no scores, run continues");
  assert.equal(hint.status, "live");
  assert.deepEqual(await healthy(), { ok: true });
  const feed = await realFetch(`${base}/runs/${runId}/spectate`).then((r) => r.json());
  assert.ok(feed.events.some((e: any) => e.type === "action" && /hint failed/.test(e.detail)), "the failure is visible in the feed");
  await app.close();
});

test("process guards: a real unhandled rejection and a real uncaught exception are logged with stacks and the process stays alive", async () => {
  // Runs in a child process so the rejection and exception are genuine (the test runner would otherwise intercept them).
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const mainUrl = new URL("../src/main.ts", import.meta.url).href;
  const script = `
    import { installProcessGuards } from ${JSON.stringify(mainUrl)};
    installProcessGuards();
    installProcessGuards();   // idempotent
    setTimeout(() => { Promise.reject(new Error("boom from a timer")); }, 10);
    setTimeout(() => { throw new Error("boom from a listener"); }, 30);
    setTimeout(() => { console.log("still alive", process.listenerCount("unhandledRejection"), process.listenerCount("uncaughtException")); process.exit(0); }, 120);
  `;
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 }, (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout, stderr })));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /still alive 1 1/, "process reached the end with exactly one guard each");
  assert.match(stderr, /unhandled rejection \(server keeps running\)[\s\S]*boom from a timer[\s\S]*\n\s+at /, "rejection logged with its stack");
  assert.match(stderr, /uncaught exception \(server keeps running\)[\s\S]*boom from a listener[\s\S]*\n\s+at /, "exception logged with its stack");
  assert.equal(typeof installProcessGuards, "function");
});
