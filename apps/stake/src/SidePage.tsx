// "Pick a side": fund either side of a run. Backers go through /runs/:id/back-fiat; trap setters
// take a seat and are sent to the watch page planter. Money state comes from the live (undelayed)
// spectate feed and GET /runs/:id/my-position. ?demo=closed|full|over overlays fixtures for review.
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentity } from "./App";

type Mode = "demo" | "pollar";
const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";
const POLL_MS = 1500;
const usd = (n: number) => "$" + Number(n || 0).toFixed(2);
const money = (n: number) => { const s = usd(n); return s.endsWith(".00") && Number.isInteger(n) ? "$" + Math.round(n) : s; };
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEMO = new URLSearchParams(location.search).get("demo");
const MULTIPLIER = 3;        // the program pays stake + 2x bounty: 3 times the stake (30_000 bps)
const MIN_STAKE = 0.05;

function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) { setShown(value); from.current = value; return; }
    const start = from.current, t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 300); setShown(start + (value - start) * k); if (k < 1) raf = requestAnimationFrame(step); else from.current = value; };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

export function Side({ mode }: { mode: Mode }) {
  const id = useIdentity(mode);
  const runId = (location.pathname.match(/^\/side\/([^/]+)/) || [])[1] || null;
  const [state, setState] = useState<any>(null);
  const [pos, setPos] = useState<any>(null);
  const [balance, setBalance] = useState<any>(null);
  const [amount, setAmount] = useState(5);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [flash, setFlash] = useState(false);
  const [stamp, setStamp] = useState(false);
  const [closedSlam, setClosedSlam] = useState(false);
  const prevBonus = useRef<number | null>(null);
  const prevOpen = useRef<boolean | null>(null);
  const [, forceRender] = useState(0);
  const signedIn = !!id.user;

  const api = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(SERVER + path, body === undefined ? { headers: id.headers() } : { method: "POST", headers: id.headers(), body: JSON.stringify({ ...(body as object), ...(mode === "demo" ? { user: id.user } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(j.error ?? `${r.status}`);
    return j;
  }, [id.headers, id.user, mode]);

  const withDemo = (s: any) => {
    if (!s || !DEMO) return s;
    const d = { ...s, seats: [{ name: "chizzy", kind: "human" }, { name: "ada", kind: "human" }, { kind: "open" }, { kind: "open" }] };
    if (DEMO === "open") { d.backingOpen = true; d.status = "live"; }
    if (DEMO === "closed") { d.backingOpen = false; d.position = Math.max(1, d.position); d.status = "live"; }
    if (DEMO === "full") { d.seats = [{ name: "chizzy", kind: "human" }, { name: "ada", kind: "human" }, { name: "Bot", kind: "bot" }, { name: "mia", kind: "human" }]; d.status = "live"; d.backingOpen = true; }
    if (DEMO === "over") { d.status = "escaped"; d.backingOpen = false; }
    return d;
  };
  const demoPos = (p: any) => {
    if (DEMO !== "closed" && DEMO !== "over") return p;   // only those two fixtures carry a position
    const base = p ?? { stakeMicro: 0, stakeUsd: 0, sharePct: 0, payoutNowMicro: 0, payoutNowUsd: 0, minesPaidUsd: 0 };
    return { ...base, stakeUsd: 5, stakeMicro: 5e6, sharePct: 20, payoutNowUsd: 5.6, payoutNowMicro: 5.6e6, backingClosed: "Backing closed when Byte cleared the first tile." };
  };

  // live money state: decisions happen against the real, undelayed game
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const tick = async () => {
      try { const r = await fetch(`${SERVER}/runs/${runId}/spectate?delay=0`); if (!r.ok) return; const { state: s } = await r.json(); if (alive) setState(withDemo(s)); }
      catch { /* retry next tick */ }
    };
    tick(); const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  const refresh = useCallback(async () => {
    if (!runId || !id.user) return;
    try { setPos(demoPos(await api(`/runs/${runId}/my-position`))); } catch { setPos(demoPos(null)); }
    try { setBalance(await api("/api/v1/fiat/balance")); } catch { /* not signed in */ }
  }, [api, runId, id.user]);
  useEffect(() => { refresh(); const t = setInterval(refresh, POLL_MS); return () => clearInterval(t); }, [refresh]);

  // causes → effects: a bonus paid elsewhere flashes the pool; backing closing slams the tag
  useEffect(() => {
    if (!state) return;
    if (prevBonus.current !== null && state.bonusesPaid > prevBonus.current && !reduced) { setFlash(true); setTimeout(() => setFlash(false), 180); }
    prevBonus.current = state.bonusesPaid;
    if (prevOpen.current === true && !state.backingOpen && !reduced) { setClosedSlam(true); setTimeout(() => setClosedSlam(false), 400); }
    prevOpen.current = state.backingOpen;
  }, [state?.bonusesPaid, state?.backingOpen]);

  const pool = useCountUp(state?.poolNow ?? 0);
  const amt = showCustom && custom.trim() !== "" ? Number(custom) : amount;

  async function back() {
    if (!runId || !(amt > 0)) { setMsg("Choose an amount first."); return; }
    setBusy(true); setMsg("");
    try { await api(`/runs/${runId}/back-fiat`, { amount: amt }); await refresh(); if (!reduced) { setStamp(true); setTimeout(() => setStamp(false), 300); } }
    catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  }
  async function takeSeat() {
    if (!runId) return;
    setBusy(true);
    try { await fetch(`${SERVER}/runs/${runId}/seat`, { method: "POST", headers: id.headers(), body: JSON.stringify({ action: "take", ...(mode === "demo" ? { user: id.user } : {}) }) }); } catch { /* seats may not exist on this server yet */ }
    location.href = `/watch/${runId}?plant=1`;
  }
  async function addFunds() { try { await api("/dev/credit", { amount: 10 }); await refresh(); setMsg(""); } catch (e: any) { setMsg(e.message); } }
  const toggleTheme = () => { const n = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", n); try { localStorage.setItem("wt.theme", n); } catch { /* private */ } forceRender((x) => x + 1); };
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  const seats: any[] = state?.seats ?? [{ kind: "open" }, { kind: "open" }, { kind: "open" }, { kind: "open" }];
  const free = seats.filter((s) => s.kind === "open").length;
  const armed = state ? state.traps.filter((t: any) => t.status === "armed") : [];
  const armedStake = armed.reduce((n: number, t: any) => n + t.stake, 0);
  const hasPosition = !!pos && pos.stakeMicro > 0;
  const minesPaid = pos?.minesPaidUsd ?? 0;
  const who = state?.callsign || "Byte";
  const live = state?.status === "live";
  const over = !!state && !live;
  const signIn = (
    mode === "pollar"
      ? <button className="btn blue wide" onClick={id.signInGoogle}>Sign in with Google to play</button>
      : <div className="row"><input value={id.user} placeholder="Your name" aria-label="Your name" onChange={(e) => id.setDemoUser(e.target.value.trim())} /><span className="soft">Type a name to play with test funds.</span></div>
  );

  return (
    <div className="wrap">
      <header>
        <div className="wordmark">Word<b>Trap</b></div>
        <span className="meta">{state ? (live ? `${who} is playing, turn ${state.turn}` : `${who} finished on turn ${state.turn}`) : "Waiting for a run"}</span>
        <span className="hright">
          {runId && <a className="back" href={`/watch/${runId}`}>Back to the board</a>}
          <span className="livewrap"><span className={`dot${live ? "" : " off"}`} role="img" aria-label={live ? "live" : "over"}></span>{live ? "Live" : state ? "Over" : "Waiting"}</span>
          <button id="themeBtn" type="button" aria-pressed={dark} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
            {dark ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3a9 9 0 1 0 6 15.5A8 8 0 0 1 15 3z"/></svg>}
          </button>
        </span>
      </header>

      <div className="strip"><h1>Pick a side</h1></div>

      {mode === "demo" && <div className="banner"><b>Test funds only.</b> No Pollar key is configured, so balances are play money.{signedIn && <button className="btn small" onClick={addFunds}>Add test funds</button>}</div>}
      {id.pollarErr && <div className="banner err">{id.pollarErr}</div>}

      <div className="status">
        <span>Fuse left <b className="red">{state?.fuse ?? "—"}</b></span>
        <span>Tiles cleared <b>{state ? state.tiles.filter((t: any) => t.cleared).length : "—"} of {state?.tiles.length ?? "—"}</b></span>
        <span>Mines armed <b>{state ? armed.length : "—"}</b></span>
        <span>Bonuses paid <b>{usd(state?.bonusesPaid ?? 0)}</b></span>
      </div>

      {over ? (
        <section className="result">
          <h2 className={state.status === "escaped" ? "blue" : "red"}>{state.status === "escaped" ? "Byte escaped" : "Byte detonated"}</h2>
          {hasPosition && <p className="big">You get {usd(pos.payoutNowUsd)}</p>}
          {minesPaid > 0 && <p className="big">Your mines paid {usd(minesPaid)}</p>}
          {!hasPosition && minesPaid === 0 && <p className="soft">{signedIn ? "You had nothing on this run." : "Sign in to see what you won."}</p>}
          <a className="btn yellow" href="/play">Find another room</a>
        </section>
      ) : (
        <main className="sides">
          <section className={`panel backers${flash ? " flash" : ""}`} aria-labelledby="backh">
            {state && !state.backingOpen && <span className={`tag${closedSlam ? " slam" : ""}`}>Closed</span>}
            <h2 id="backh" className="title blue">Back Byte</h2>
            <p className="line">You win when the mines stay quiet.</p>
            <div className="figure">{usd(pool)}</div>
            <p className="soft under">in the pool from {state?.backerCount ?? 0} backer{state?.backerCount === 1 ? "" : "s"}</p>
            {!signedIn ? signIn : hasPosition ? (
              <>
                <div className={`receipt${stamp ? " stamp" : ""}`} role="status">
                  <p className="rtitle">You backed Byte with {money(pos.stakeUsd)}</p>
                  <p>Your share of the pool is {pos.sharePct}%.</p>
                  <hr />
                  <p>If the run ended now you would get <b className="bluetext">{usd(pos.payoutNowUsd)}</b></p>
                </div>
                {state?.backingOpen
                  ? <div className="row"><button className="btn blue" disabled={busy} onClick={back}>Add {money(amt)} more</button><span className="soft">Wallet balance {usd(balance ? balance.balanceMicro / 1e6 : 0)}</span></div>
                  : <p className="closedline">{pos.backingClosed ?? "Backing closed when Byte cleared the first tile."}</p>}
              </>
            ) : state?.backingOpen === false ? (
              <p className="closedline">{pos?.backingClosed ?? "Backing closed when Byte cleared the first tile."}</p>
            ) : (
              <>
                <div className="chips" role="group" aria-label="Amount">
                  {[1, 5, 10].map((v) => <button key={v} type="button" className={`chip${!showCustom && amount === v ? " on" : ""}`} aria-pressed={!showCustom && amount === v} onClick={() => { setAmount(v); setShowCustom(false); }}>${v}</button>)}
                  {showCustom
                    ? <input className="custom" inputMode="decimal" placeholder="0.00" aria-label="Custom amount in dollars" autoFocus value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
                    : <button type="button" className="chip dashed" onClick={() => setShowCustom(true)}>Other amount</button>}
                </div>
                <p className="soft">Pollar wallet balance {usd(balance ? balance.balanceMicro / 1e6 : 0)}</p>
                <button className="btn blue wide" disabled={busy || !(amt > 0)} onClick={back}>Back Byte with {money(amt)}</button>
              </>
            )}
            {msg && <p className="msg" role="alert">{msg}</p>}
          </section>

          <section className="panel setters" aria-labelledby="seth">
            <div className="band" aria-hidden="true"></div>
            <h2 id="seth" className="title">Set traps</h2>
            <p className="line">You win when Byte plays your word.</p>
            <div className="seats" role="list" aria-label="Seats">
              {seats.map((s, i) => <span key={i} role="listitem" className={`seat ${s.kind}`} aria-label={s.kind === "open" ? `Seat ${i + 1}, open` : s.kind === "bot" ? `Seat ${i + 1}, bot` : `Seat ${i + 1}, taken by ${s.name}`}>{s.kind === "open" ? "Open" : s.kind === "bot" ? "Bot" : s.name}</span>)}
            </div>
            <p className="soft">{free} of 4 seats free</p>
            <ul className="facts">
              <li><b>{usd(armedStake)}</b> is armed on {armed.length} hidden word{armed.length === 1 ? "" : "s"}</li>
              <li>A mine that goes off pays <b>{MULTIPLIER} times</b> its stake</li>
              <li>Smallest stake is <b>{usd(MIN_STAKE)}</b></li>
            </ul>
            {!signedIn ? signIn : free > 0
              ? <button className="btn yellow wide" disabled={busy} onClick={takeSeat}>Take a seat</button>
              : <p className="closedline">Seats are full. You can still back Byte.</p>}
          </section>
        </main>
      )}

      <section className="how" aria-label="How the money moves">
        <div><h3>A mine goes off</h3><p>Its setter gets their stake back plus a bonus from the pool.</p></div>
        <div><h3>A mine stays quiet</h3><p>Its stake goes to the backers.</p></div>
        <div><h3>The run ends</h3><p>Backers share whatever is left in the pool.</p></div>
      </section>
    </div>
  );
}
