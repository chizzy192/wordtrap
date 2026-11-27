// "Pick a side": fund either side of a run. Backers go through /runs/:id/back-fiat; trap setters
// take a seat and are sent to the watch page planter. Money state comes from the live (undelayed)
// spectate feed and GET /runs/:id/my-position. ?demo=open|closed|full|over overlays fixtures for review.
// Identity: the wallet address (Pollar / connected wallet) or a guest id made once; shown as the
// display name or the short address. Watching never needs an account.
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentity, shortAddress, friendly, copyText, roomLink } from "./App";

type Mode = "demo" | "pollar";
const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";
const POLL_MS = 1500;
const usd = (n: number) => "$" + Number(n || 0).toFixed(2);
const money = (n: number) => (Number.isInteger(n) ? "$" + n : usd(n));
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEMO = new URLSearchParams(location.search).get("demo");
const MULTIPLIER = 3;        // the program pays stake + 2x bounty: 3 times the stake (30_000 bps)
const MIN_STAKE = 0.05;
const NAME_RULE = "Names are 2 to 16 characters: letters, numbers, spaces and underscores.";
const validName = (raw: string) => { const n = raw.trim().replace(/\s+/g, " "); return n.length >= 2 && n.length <= 16 && /^[A-Za-z0-9_][A-Za-z0-9 _]{0,15}$/.test(n) ? n : null; };

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

type Popover = null | "first" | "name" | "funds";

export function Side({ mode }: { mode: Mode }) {
  const id = useIdentity(mode);
  const runId = (location.pathname.match(/^\/side\/([^/]+)/) || [])[1] || null;
  const [state, setState] = useState<any>(null);
  const [players, setPlayers] = useState<Record<string, string>>({});
  const [pos, setPos] = useState<any>(null);
  const [balance, setBalance] = useState<any>(null);
  const [treasury, setTreasury] = useState<any>(null);
  const [amount, setAmount] = useState(5);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [flash, setFlash] = useState(false);
  const [stamp, setStamp] = useState(false);
  const [closedSlam, setClosedSlam] = useState(false);
  const [pop, setPop] = useState<Popover>(() => (id.chosen ? null : "first"));
  const [nameDraft, setNameDraft] = useState("");
  const [nameMsg, setNameMsg] = useState("");
  const [fundsMsg, setFundsMsg] = useState("");
  const [googleHelp, setGoogleHelp] = useState("");
  const [copied, setCopied] = useState(false);
  async function copyLink() {
    if (!runId) return;
    if (await copyText(roomLink(runId))) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
    else setMsg("Couldn't copy. The link is " + roomLink(runId));
  }
  const pending = useRef<null | "back" | "seat">(null);
  const prevBonus = useRef<number | null>(null);
  const prevOpen = useRef<boolean | null>(null);
  const [, forceRender] = useState(0);
  const signedIn = !!id.user;
  const balMicro = balance ? (balance.balanceMicro as number) : 0;

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
    if (DEMO !== "closed" && DEMO !== "over") return p;
    const base = p ?? { stakeMicro: 0, stakeUsd: 0, sharePct: 0, payoutNowMicro: 0, payoutNowUsd: 0, minesPaidUsd: 0 };
    return { ...base, stakeUsd: 5, stakeMicro: 5e6, sharePct: 20, payoutNowUsd: 5.6, payoutNowMicro: 5.6e6, backingClosed: "Backing closed when Byte cleared the first tile." };
  };

  useEffect(() => { fetch(SERVER + "/api/v1/treasury").then((r) => r.json()).then(setTreasury).catch(() => setTreasury(null)); }, []);

  // live money state: decisions happen against the real, undelayed game
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const tick = async () => {
      try { const r = await fetch(`${SERVER}/runs/${runId}/spectate?delay=0`); if (!r.ok) return; const j = await r.json(); if (alive) { setState(withDemo(j.state)); if (j.players) setPlayers(j.players); } }
      catch { /* retry next tick */ }
    };
    tick(); const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  const refresh = useCallback(async () => {
    if (!id.user) return;
    try { setBalance(await api("/api/v1/fiat/balance")); } catch { /* not signed in */ }
    if (!runId) return;
    try { setPos(demoPos(await api(`/runs/${runId}/my-position`))); } catch { setPos(demoPos(null)); }
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
  const needFunds = signedIn && balance !== null && balMicro < Math.round(amt * 1e6);
  const label = (who: string) => players[who] || (who === id.user && id.displayName) || shortAddress(who);

  async function playAsGuest() {
    id.setDemoUser();
    setPop(null);
    const guest = (() => { try { return localStorage.getItem("wt.identity"); } catch { return null; } })();
    if (guest && treasury?.guestStartFunds > 0) {
      await fetch(SERVER + "/dev/credit", { method: "POST", headers: { "content-type": "application/json", "x-user": guest }, body: JSON.stringify({ user: guest, amount: treasury.guestStartFunds, paymentId: `guest-start-${guest}` }) }).catch(() => {});
    }
    await refresh();
    if (!id.displayName) setPop("name"); else resume();
  }
  function resume() { const p = pending.current; pending.current = null; if (p === "back") back(); if (p === "seat") takeSeat(); }
  async function saveName() {
    const n = validName(nameDraft);
    if (!n) return setNameMsg(NAME_RULE);
    try { await id.saveName(n); setNameMsg(""); setPop(null); resume(); } catch (e: any) { setNameMsg(e.message); }
  }
  async function addTestFunds() {
    try { await api("/dev/credit", { amount: 10 }); await refresh(); setFundsMsg("Added $10."); setTimeout(() => { setPop(null); setFundsMsg(""); resume(); }, 700); }
    catch (e: any) { setFundsMsg(e.message); }
  }
  async function back() {
    if (!runId) return;
    if (!signedIn) { pending.current = "back"; return setPop("first"); }
    if (!id.displayName) { pending.current = "back"; return setPop("name"); }
    if (!(amt > 0)) { setMsg("Choose an amount first."); return; }
    if (needFunds) { pending.current = "back"; return setPop("funds"); }
    setBusy(true); setMsg("");
    try { await api(`/runs/${runId}/back-fiat`, { amount: amt }); await refresh(); if (!reduced) { setStamp(true); setTimeout(() => setStamp(false), 300); } }
    catch (e: any) { setMsg(e.message); if (/not enough funds|insufficient/i.test(e.message)) { pending.current = "back"; setPop("funds"); } }
    finally { setBusy(false); }
  }
  async function takeSeat() {
    if (!runId) return;
    if (!signedIn) { pending.current = "seat"; return setPop("first"); }
    if (!id.displayName) { pending.current = "seat"; return setPop("name"); }
    setBusy(true);
    try {
      const r = await fetch(`${SERVER}/runs/${runId}/seat`, { method: "POST", headers: id.headers(), body: JSON.stringify({ action: "take", ...(mode === "demo" ? { user: id.user } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(friendly(j.error, "Could not take a seat.")); setBusy(false); return; }   // e.g. "All four seats are taken. You can still back Byte."
      try { localStorage.setItem(`wt.seat.${runId}`, j.token); } catch { /* private mode */ }    // the watch page planter sends this token
    } catch { setMsg("The server didn't answer. Try again in a moment."); setBusy(false); return; }
    location.href = `/watch/${runId}?plant=1`;
  }
  const toggleTheme = () => { const n = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", n); document.documentElement.classList.toggle("dark", n === "dark"); try { localStorage.setItem("wt.theme", n); } catch { /* private */ } forceRender((x) => x + 1); };
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);   // Pollar's stylesheet keys its dark palette off html.dark

  const seats: any[] = state?.seats ?? [{ kind: "open" }, { kind: "open" }, { kind: "open" }, { kind: "open" }];
  const free = seats.filter((s) => s.kind === "open" || s.kind === "bot").length;   // bots step aside for people
  const armed = state ? state.traps.filter((t: any) => t.status === "armed") : [];
  const armedStake = armed.reduce((n: number, t: any) => n + t.stake, 0);
  const hasPosition = !!pos && pos.stakeMicro > 0;
  const minesPaid = pos?.minesPaidUsd ?? 0;
  const who = state?.callsign || "Byte";
  const live = state?.status === "live";
  const over = !!state && !live;
  const fundsKind = treasury?.mode === "pollar" && mode === "pollar" ? "Pollar wallet" : "Test funds";
  const backLabel = !signedIn ? "Sign in to play" : needFunds ? "Add funds to play" : `Back Byte with ${money(amt)}`;

  return (
    <div className="wrap">
      <header>
        <a className="wordmark" href="/play"><img className="wm-light" src="/wordtrap-wordmark-light.png" alt="WordTrap" width={120} height={32} /><img className="wm-dark" src="/wordtrap-wordmark-dark.png" alt="WordTrap" width={120} height={32} /></a>
        <a className="nav" href="/play">Rooms</a>
        <span className="meta">{state ? (live ? `${who} is playing, turn ${state.turn}` : `${who} finished on turn ${state.turn}`) : "Waiting for a run"}</span>
        <span className="hright">
          {runId && <a className="back" href={`/watch/${runId}`}>Back to the board</a>}
          <span className="livewrap"><span className={`dot${live ? "" : " off"}`} role="img" aria-label={live ? "live" : "over"}></span>{live ? "Live" : state ? "Over" : "Waiting"}</span>
          <span className="account">
            {signedIn
              ? <><span className="who" title={id.user}>{id.label}</span><span className="bal">{usd(balMicro / 1e6)}<small>{fundsKind}</small></span>{mode === "pollar" && <span className="bal"><span>{id.usdc === null ? "…" : usd(id.usdc)}</span><small>Wallet USDC</small></span>}<button type="button" className="btn small yellow" onClick={() => setPop("funds")}>Add funds</button></>
              : <button type="button" className="btn small" onClick={() => setPop("first")}>Sign in</button>}
          </span>
          <button id="themeBtn" type="button" aria-pressed={dark} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
            {dark ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3a9 9 0 1 0 6 15.5A8 8 0 0 1 15 3z"/></svg>}
          </button>
        </span>
      </header>

      <div className="strip"><h1>Pick a side</h1></div>

      {mode === "demo" && <div className="banner"><b>Test funds only.</b> No Pollar key is configured, so balances are play money.</div>}
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
            <dl className="poolrows" aria-label="The backers' pool">
              <div><dt>Backers put in</dt><dd>{usd(state?.backerTotal ?? 0)}</dd></div>
              <div><dt>Bonuses paid</dt><dd>−{usd(state?.bonusesPaid ?? 0)}</dd></div>
              <div><dt>Quiet mines</dt><dd>+{usd(state?.unfiredStake ?? 0)}</dd></div>
            </dl>
            <p className="poollabel">In the pool now</p>
            <div className="figure">{usd(pool)}</div>
            <p className="soft under">from {state?.backerCount ?? 0} backer{state?.backerCount === 1 ? "" : "s"}{live ? ". Quiet mines join the pool when the run ends." : ""}</p>
            {hasPosition ? (
              <>
                <div className={`receipt${stamp ? " stamp" : ""}`} role="status">
                  <p className="rtitle">You backed Byte with {money(pos.stakeUsd)}</p>
                  <p>Your share of the pool is {pos.sharePct}%.</p>
                  <hr />
                  <p>If the run ended now you would get <b className="bluetext">{usd(pos.payoutNowUsd)}</b></p>
                </div>
                {state?.backingOpen
                  ? <div className="row"><button className="btn blue" disabled={busy} onClick={back}>{needFunds ? "Add funds to play" : `Add ${money(amt)} more`}</button><span className="soft">Wallet balance {usd(balMicro / 1e6)}</span></div>
                  : <p className="closedline">{pos.backingClosed ?? "Backing closed when Byte cleared the first tile."}</p>}
              </>
            ) : state?.backingOpen === false ? (
              <p className="closedline">{pos?.backingClosed ?? "Backing closed when Byte cleared the first tile."}</p>
            ) : !signedIn ? (
              <>
                <button className="btn blue wide" onClick={() => { pending.current = "back"; setPop("first"); }}>Sign in to back Byte</button>
                <p className="soft">{treasury?.mode === "pollar" ? "Sign in with Google to back Byte from your wallet." : "Sign in with Google, or play as a guest with test funds."}</p>
              </>
            ) : (
              <>
                <div className="chips" role="group" aria-label="Amount">
                  {[1, 5, 10].map((v) => <button key={v} type="button" className={`chip${!showCustom && amount === v ? " on" : ""}`} aria-pressed={!showCustom && amount === v} onClick={() => { setAmount(v); setShowCustom(false); }}>${v}</button>)}
                  {showCustom
                    ? <input className="custom" inputMode="decimal" placeholder="0.00" aria-label="Custom amount in dollars" autoFocus value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
                    : <button type="button" className="chip dashed" onClick={() => setShowCustom(true)}>Other amount</button>}
                </div>
                <p className="soft">{`${fundsKind} balance ${usd(balMicro / 1e6)}`}</p>
                <button className="btn blue wide" disabled={busy || !(amt > 0)} onClick={back}>{backLabel}</button>
              </>
            )}
            {msg && state?.backingOpen !== false && <p className="msg" role="alert">{msg}</p>}
          </section>

          <section className="panel setters" aria-labelledby="seth">
            <div className="band" aria-hidden="true"></div>
            <h2 id="seth" className="title">Set traps</h2>
            <p className="line">You win when Byte plays your word.</p>
            <div className="seats" role="list" aria-label="Seats">
              {seats.map((s, i) => <span key={i} role="listitem" className={`seat ${s.kind}`} title={s.address ?? s.name ?? ""} aria-label={s.kind === "open" ? `Seat ${i + 1}, open` : s.kind === "bot" ? `Seat ${i + 1}, bot` : `Seat ${i + 1}, taken by ${label(s.address ?? s.name)}`}>{s.kind === "open" ? "Open" : s.kind === "bot" ? "Bot" : label(s.address ?? s.name)}</span>)}
            </div>
            <p className="soft">{free} of 4 seats free <button type="button" className="btn text" onClick={copyLink}>{copied ? "Link copied" : "Copy room link"}</button></p>
            <ul className="facts">
              <li><b>{usd(armedStake)}</b> is armed on {armed.length} hidden word{armed.length === 1 ? "" : "s"}</li>
              <li>A mine that goes off pays <b>{MULTIPLIER} times</b> its stake</li>
              <li>Smallest stake is <b>{usd(MIN_STAKE)}</b></li>
            </ul>
            {free > 0
              ? <button className="btn yellow wide" disabled={busy} onClick={takeSeat}>{signedIn ? "Take a seat" : "Sign in to play"}</button>
              : <p className="closedline">Seats are full. You can still back Byte.</p>}
          </section>
        </main>
      )}

      <section className="how" aria-label="How the money moves">
        <div><h3>A mine goes off</h3><p>Its setter gets their stake back plus a bonus from the pool.</p></div>
        <div><h3>A mine stays quiet</h3><p>Its stake goes to the backers.</p></div>
        <div><h3>The run ends</h3><p>Backers share whatever is left in the pool.</p></div>
      </section>

      {pop === "first" && (
        <div className="popover" role="dialog" aria-labelledby="fvTitle">
          <h2 id="fvTitle">Play or just watch</h2>
          <button type="button" className="btn blue wide" onClick={() => { if (mode === "pollar") id.signInGoogle(); else setGoogleHelp("Google sign-in isn't set up on this server yet. Play as a guest for now."); }}>Sign in with Google</button>
          {mode === "pollar" && <button type="button" className="btn text" onClick={() => { setPop(null); id.openSignIn(); }}>Other ways to sign in</button>}
          {googleHelp && <div className="help">{googleHelp}</div>}
          <button type="button" className="btn yellow wide" onClick={playAsGuest}>Play as guest</button>
          <div className="help">Guests play with test funds.</div>
          <button type="button" className="btn text" onClick={() => { setPop(null); try { localStorage.setItem("wt.identity.choice", "1"); } catch { /* private */ } }}>Just watch</button>
        </div>
      )}
      {pop === "name" && (
        <div className="popover" role="dialog" aria-labelledby="npTitle">
          <h2 id="npTitle">What should we call you?</h2>
          <input value={nameDraft} maxLength={16} autoFocus aria-label="Display name" placeholder="2 to 16 characters" onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveName(); }} />
          <div className="help">Letters, numbers, spaces and underscores. Shown on your seat and your mines.</div>
          <div className="row"><button type="button" className="btn yellow" onClick={saveName}>Save</button><button type="button" className="btn text" onClick={() => { setPop(null); resume(); }}>Later</button></div>
          {nameMsg && <div className="help err">{nameMsg}</div>}
        </div>
      )}
      {pop === "funds" && (
        <div className="popover" role="dialog" aria-labelledby="fpTitle">
          <h2 id="fpTitle">Add funds</h2>
          <div className="balance">Balance <b>{usd(balMicro / 1e6)}</b> <small>{fundsKind}</small></div>
          {treasury?.mode === "pollar" && mode === "pollar"
            ? <a className="btn blue wide" href={`/stake/?run=${encodeURIComponent(runId ?? "")}`}>Top up with Pollar</a>
            : <><button type="button" className="btn yellow wide" onClick={addTestFunds}>Add test funds</button><div className="help">Adds $10 of play money to your balance.</div></>}
          {fundsMsg && <div className="help">{fundsMsg}</div>}
          <button type="button" className="btn text" onClick={() => setPop(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
