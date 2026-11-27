// Headless Chrome over the DevTools protocol for browser tests. Skips cleanly when Chrome is not installed.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
export const chromeAvailable = () => existsSync(CHROME);

export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(method: string, handler: (params: any) => void): void;
  goto(url: string): Promise<void>;
  eval<T = any>(expression: string): Promise<T>;
  close(): void;
}

export async function launchChrome(o: { width?: number; height?: number } = {}): Promise<{ newPage(): Promise<Page>; close(): void }> {
  const dir = join(tmpdir(), `wt-chrome-test-${process.pid}-${Date.now()}`);
  const proc: ChildProcess = spawn(CHROME, ["--remote-debugging-port=0", "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${dir}`, `--window-size=${o.width ?? 1366},${o.height ?? 768}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = ""; const t = setTimeout(() => reject(new Error("Chrome did not report its DevTools port")), 20_000);
    proc.stderr!.on("data", (c) => { out += c; const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on("exit", () => { clearTimeout(t); reject(new Error("Chrome exited")); });
  });
  const close = () => { try { proc.kill(); } catch { /* gone */ } setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } }, 500); };
  async function newPage(): Promise<Page> {
    const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map<number, (v: any) => void>(); const handlers = new Map<string, ((p: any) => void)[]>();
    ws.onmessage = (m: MessageEvent) => { const d = JSON.parse(String(m.data)); if (d.id) { pending.get(d.id)?.(d.result ?? d.error); pending.delete(d.id); } else for (const h of handlers.get(d.method) ?? []) h(d.params); };
    const send = (method: string, params: Record<string, unknown> = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise<any>((r) => pending.set(i, r)); };
    const on = (method: string, h: (p: any) => void) => { handlers.set(method, [...(handlers.get(method) ?? []), h]); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Log.enable");
    return {
      send, on,
      goto: async (url) => { const loaded = new Promise<void>((r) => on("Page.loadEventFired", () => r())); await send("Page.navigate", { url }); await loaded; },
      eval: async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result?.value; },
      close: () => ws.close(),
    };
  }
  return { newPage, close };
}

/** Everything a page reports that a test must fail on: thrown errors, console errors, error-level log entries (CSP, failed loads), failed requests and 4xx/5xx answers. */
export function watchProblems(page: Page) {
  const list: { kind: string; text: string; at: number }[] = [];
  const add = (kind: string, text: string) => list.push({ kind, text, at: Date.now() });
  page.on("Runtime.exceptionThrown", (p) => add("exception", (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n").slice(0, 2).join(" ")));
  page.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error" || p.type === "assert") add("console.error", p.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)); });
  page.on("Log.entryAdded", (p) => { if (p.entry.level === "error") add(`log:${p.entry.source}`, `${p.entry.text} ${p.entry.url ?? ""}`.slice(0, 300)); });
  const urls = new Map<string, string>();
  page.on("Network.requestWillBeSent", (p) => urls.set(p.requestId, p.request.url));
  page.on("Network.loadingFailed", (p) => { if (!p.canceled && p.errorText !== "net::ERR_ABORTED") add("request failed", `${p.errorText} ${urls.get(p.requestId) ?? ""}`); });
  page.on("Network.responseReceived", (p) => { if (p.response.status >= 400) add(`http ${p.response.status}`, p.response.url); });
  return { list, since: (t: number) => list.filter((x) => x.at >= t), clear: () => list.splice(0) };
}
