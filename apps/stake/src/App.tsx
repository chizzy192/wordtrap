// Stake page: top up, plant fiat mines on Byte's hand, back Byte, and auto-reveal when Byte plays
// a mined card. The salt and word never leave this browser until the word has been played (I2);
// commitments are computed with the server TREASURY pubkey because the treasury is the on-chain
// setter for every fiat mine (I1).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Mode = "demo" | "pollar";
const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";
const POLL_MS = 1500;
const SECRETS_KEY = "wt.fiat.secrets";
const USER_KEY = "wt.demo.user";

interface Secret { word: string; saltHex: string; runId: string; armedTurn: number }
interface Treasury { setter: string; pubkeyHex: string; chain: string; mode: string }

// ---- crypto: identical to packages/shared + the Rust program ----
const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
async function sha256(...parts: Uint8Array[]) {
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
const commitment = (word: string, salt: Uint8Array, setter: Uint8Array) => sha256(enc.encode("wordtrap:v1"), enc.encode(word), salt, setter);

function loadSecrets(): Record<string, Secret> { try { return JSON.parse(localStorage.getItem(SECRETS_KEY) ?? "{}"); } catch { return {}; } }
function saveSecrets(s: Record<string, Secret>) { try { localStorage.setItem(SECRETS_KEY, JSON.stringify(s)); } catch { /* private mode */ } }

// ---- identity (I6): Pollar session in pollar mode, plain user / wallet address in demo mode ----
function useIdentity(mode: Mode) {
  const [user, setUser] = useState<string>(() => { try { return localStorage.getItem(USER_KEY) ?? ""; } catch { return ""; } });
  const [token, setToken] = useState<string | null>(null);
  const [pollarErr, setPollarErr] = useState<string | null>(null);
  const [pollar, setPollar] = useState<any>(null);

  // In pollar mode the hook module exists; load it dynamically so demo builds never touch the SDK.
  useEffect(() => {
    if (mode !== "pollar") return;
    import("@pollar/react").then((m) => setPollar(() => (m as any).usePollar)).catch((e) => setPollarErr(String(e)));
  }, [mode]);

  const p = pollar ? pollar() : null;   // usePollar(): { isAuthenticated, wallet, login, logout, getClient, openCardModal, ... }
  useEffect(() => {
    if (!p?.isAuthenticated) { if (mode === "pollar") { setUser(""); setToken(null); } return; }
    const addr = p.wallet?.address ?? "";
    setUser(addr);
    // The SDK keeps DPoP-bound access tokens internally; which accessor exposes one is not documented
    // in the open-source README. Try the plausible shapes; otherwise say so instead of pretending.
    (async () => {
      try {
        const c = p.getClient?.();
        const t = (await c?.getAccessToken?.()) ?? c?.session?.accessToken ?? c?.tokens?.access ?? c?.accessToken ?? null;
        setToken(t ? String(t) : null);
        setPollarErr(t ? null : "Signed in, but the Pollar SDK exposed no session token for server verification. Server calls will be refused (401) until the token accessor is confirmed against docs.pollar.xyz.");
      } catch (e) { setPollarErr(String(e)); }
    })();
  }, [p?.isAuthenticated, p?.wallet?.address]);

  const setDemoUser = (u: string) => { setUser(u); try { localStorage.setItem(USER_KEY, u); } catch { /* ignore */ } };
  const connectWallet = async () => {
    const { getWallets } = await import("@wallet-standard/app");
    const wallets = getWallets().get().filter((w: any) => w.features["standard:connect"] && w.chains.some((c: string) => c.startsWith("solana:")));
    if (!wallets.length) throw new Error("no Wallet Standard wallet found (install Phantom, Solflare or Backpack)");
    const w: any = wallets[0];
    const { accounts } = await w.features["standard:connect"].connect();
    if (!accounts?.length) throw new Error("wallet returned no account");
    setDemoUser(accounts[0].address);
  };

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mode === "pollar" && token) h.authorization = `Bearer ${token}`;
    if (mode === "demo" && user) h["x-user"] = user;
    return h;
  }, [mode, token, user]);

  return { mode, user, token, pollar: p, pollarErr, setDemoUser, connectWallet, headers,
    signInGoogle: () => p?.login?.({ provider: "google" }), signOut: () => p?.logout?.() };
}

export function App({ mode }: { mode: Mode }) {
  const id = useIdentity(mode);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [runId, setRunId] = useState<string | null>(() => new URLSearchParams(location.search).get("run"));
  const [state, setState] = useState<any>(null);
  const [balance, setBalance] = useState<any>(null);
  const [secrets, setSecrets] = useState<Record<string, Secret>>(loadSecrets);
  const [toast, setToast] = useState<string>("");
  const [word, setWord] = useState("");
  const [stake, setStake] = useState(0.25);
  const [topUp, setTopUp] = useState(5);
  const [backAmt, setBackAmt] = useState(2);
  const [paymentId, setPaymentId] = useState("");
  const revealing = useRef(new Set<string>());

  const api = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(SERVER + path, body === undefined ? { headers: id.headers() } : { method: "POST", headers: id.headers(), body: JSON.stringify({ ...(body as object), ...(mode === "demo" ? { user: id.user } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(j.error ?? `${r.status}`);
    return j;
  }, [id.headers, id.user, mode]);

  const say = (s: string) => { setToast(s); setTimeout(() => setToast(""), 6000); };
  const refreshBalance = useCallback(async () => { if (!id.user) return; try { setBalance(await api("/api/v1/fiat/balance")); } catch { /* not signed in */ } }, [api, id.user]);

  useEffect(() => { fetch(SERVER + "/api/v1/treasury").then((r) => r.json()).then(setTreasury).catch(() => setTreasury(null)); }, []);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  // poll the public spectator feed; auto-reveal our mines once Byte has played the word on an armed turn
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        let rid = runId;
        if (!rid) { const c = await fetch(SERVER + "/api/v1/current").then((r) => r.json()); if (!c.runId) return; rid = c.runId; setRunId(rid); }
        const r = await fetch(`${SERVER}/runs/${rid}/spectate`);
        if (!r.ok) { if (r.status === 404) setRunId(null); return; }
        const { state: s } = await r.json();
        if (!alive) return;
        setState(s);
        for (const [trapId, sec] of Object.entries(loadSecrets())) {
          if (sec.runId !== rid || revealing.current.has(trapId)) continue;
          if (!s.spoken.some((w: any) => w.word === sec.word && w.turn >= sec.armedTurn)) continue;
          revealing.current.add(trapId);
          api(`/runs/${rid}/reveal-fiat`, { trapId, word: sec.word, saltHex: sec.saltHex })
            .then((res) => { if (res.status === "paid") { say(`💥 YOUR MINE "${sec.word.toUpperCase()}" FIRED · +$${(res.payoutMicro / 1e6).toFixed(2)}`); } const all = loadSecrets(); delete all[trapId]; saveSecrets(all); setSecrets(all); refreshBalance(); })
            .catch((e) => { revealing.current.delete(trapId); console.warn("reveal", e); });
        }
        if (s.status !== "live") setRunId(null);
      } catch { /* offline */ }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [runId, api, refreshBalance]);

  const fired = useMemo(() => new Set((state?.traps ?? []).filter((t: any) => t.word).map((t: any) => t.word)), [state]);

  async function doTopUp() {
    try {
      if (mode === "demo") { const r = await api("/dev/credit", { amount: topUp }); say(`demo credit +$${topUp} (payment ${r.paymentId})`); }
      else if (id.pollar?.openCardModal) {
        id.pollar.openCardModal({ panel: "fund", amount: String(topUp), chain: "SOLANA", onFunded: async (f: any) => { const r = await api("/api/v1/fiat/confirm", { paymentId: f.id }); say(r.status === "credited" ? `credited $${(r.micro / 1e6).toFixed(2)}` : `payment ${f.id} ${r.status}; the server re-checks it`); refreshBalance(); } });
        return;
      } else throw new Error("Pollar modal unavailable");
      refreshBalance();
    } catch (e: any) { say(e.message); }
  }
  async function confirmManual() {
    try { const r = await api("/api/v1/fiat/confirm", { paymentId }); say(`payment ${paymentId}: ${r.status}${r.duplicate ? " (already credited)" : ""}`); setPaymentId(""); refreshBalance(); }
    catch (e: any) { say(e.message); }
  }
  async function plant() {
    try {
      if (!treasury || !runId) throw new Error("no live run");
      const w = word.toLowerCase().replace(/[^a-z]/g, "");
      if (w.length < 3) throw new Error("word must be 3+ letters a–z");
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const c = hex(await commitment(w, salt, unhex(treasury.pubkeyHex)));
      const r = await api(`/runs/${runId}/plant-fiat`, { commitmentHex: c, stake });
      const all = loadSecrets(); all[r.trap.id] = { word: w, saltHex: hex(salt), runId, armedTurn: r.trap.armedTurn }; saveSecrets(all); setSecrets(all);
      say(`armed "${w}" for $${stake} · live from turn ${r.trap.armedTurn} · only this browser knows the word`);
      setWord(""); refreshBalance();
    } catch (e: any) { say(e.message); }
  }
  async function back() {
    try { if (!runId) throw new Error("no live run"); const r = await api(`/runs/${runId}/back-fiat`, { amount: backAmt }); say(`backed Byte with $${backAmt} · pool now $${r.backerTotal.toFixed(2)}`); refreshBalance(); }
    catch (e: any) { say(e.message); }
  }

  const tile = state?.tiles?.[state.position];
  const signedIn = !!id.user;
  return (
    <>
      <header>
        <div className="logo">WORD<b>TRAP</b> · STAKE</div>
        {runId && <a className="dim" href={`${SERVER}/watch/${runId}`} target="_blank" rel="noreferrer">watch run {runId} ↗</a>}
        <span className="meta">{state ? `turn ${state.turn} · fuse ${state.fuse} · ${state.status}` : "waiting for a run…"}</span>
      </header>
      <main>
        {mode === "demo" && <div className="banner wide">DEMO CREDITS — no Pollar key configured (VITE_POLLAR_PUBLISHABLE_KEY). Balances are play money from /dev/credit; everything else is the real flow.</div>}
        {id.pollarErr && <div className="banner err wide">{id.pollarErr}</div>}

        <section className="panel">
          <div className="label">You</div>
          {mode === "pollar" ? (
            signedIn ? <div className="row"><span className="ok">{id.user}</span><button className="ghost" onClick={id.signOut}>sign out</button></div>
              : <div className="row"><button onClick={id.signInGoogle}>Sign in with Google</button><span className="dim">creates your Pollar wallet</span></div>
          ) : (
            <div className="row">
              <input value={id.user} placeholder="your name" onChange={(e) => id.setDemoUser(e.target.value.trim())} />
              <button className="ghost" onClick={() => id.connectWallet().then(() => say("wallet connected")).catch((e) => say(e.message))}>or connect a Solana wallet</button>
            </div>
          )}
          <div className="label" style={{ marginTop: 14 }}>Pollar wallet balance</div>
          <div className="big">${balance ? (balance.balanceMicro / 1e6).toFixed(2) : "0.00"}</div>
          <div className="row">
            <input type="number" min={1} step={1} value={topUp} onChange={(e) => setTopUp(Number(e.target.value))} style={{ width: 90 }} />
            <button className="safe" disabled={!signedIn} onClick={doTopUp}>Add test funds</button>
          </div>
          {mode === "pollar" && <div className="row"><input value={paymentId} placeholder="payment / funding id" onChange={(e) => setPaymentId(e.target.value)} /><button className="ghost" disabled={!paymentId} onClick={confirmManual}>confirm</button></div>}
          <div className="dim" style={{ marginTop: 8, fontSize: 11 }}>Credits only land after the server verifies the payment with Pollar. Treasury: {treasury ? `${treasury.pubkeyHex.slice(0, 10)}… (${treasury.chain})` : "…"}</div>
        </section>

        <section className="panel">
          <div className="label">Back Byte · you sweep the mines that never fire</div>
          <div className="dim">Pool ${state ? state.backerTotal.toFixed(2) : "0.00"} · mines staked ${state ? state.trapTotal.toFixed(2) : "0.00"}</div>
          <div className="row">
            {[1, 2, 5, 10].map((v) => <button key={v} className={backAmt === v ? "" : "ghost"} onClick={() => setBackAmt(v)}>${v}</button>)}
            <button className="safe" disabled={!signedIn || !runId || state?.status !== "live"} onClick={back}>Back Byte ${backAmt}</button>
          </div>
        </section>

        <section className="panel wide">
          <div className="label">Plant a mine · {tile ? `"${tile.prompt}"` : "no live run"}</div>
          <div className="hand">
            {(state?.hand ?? []).map((w: string) => <div key={w} className={`card ${word === w ? "sel" : ""} ${fired.has(w) ? "boom" : ""}`} onClick={() => setWord(w)}>{w}</div>)}
          </div>
          <div className="row">
            <input value={word} placeholder="or any word Byte might play" onChange={(e) => setWord(e.target.value)} />
            {[0.1, 0.25, 0.5, 1].map((v) => <button key={v} className={stake === v ? "" : "ghost"} onClick={() => setStake(v)}>${v}</button>)}
            <button className="hot" disabled={!signedIn || !runId || !word || state?.status !== "live"} onClick={plant}>Arm mine ${stake}</button>
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>Mines arm on Byte's next turn. The word and salt stay in this browser; when Byte plays the card, this page reveals it and the treasury pays you stake + bounty.</div>
        </section>

        <section className="panel wide">
          <div className="label">Your mines</div>
          <div className="mines">
            {(balance?.traps ?? []).length === 0 && <span className="dim">none yet</span>}
            {(balance?.traps ?? []).map((t: any) => (
              <div key={t.trapId} className={`mine ${t.status === "paid" ? "paid" : secrets[t.trapId] ? "wait" : ""}`}>
                <span>{secrets[t.trapId]?.word ? `“${secrets[t.trapId].word}”` : "▒▒▒▒▒▒"} · run {t.runId}</span>
                <span>${(t.stake / 1e6).toFixed(2)} · {t.status === "paid" ? <b className="ok">paid +${(t.payout / 1e6).toFixed(2)}</b> : secrets[t.trapId] ? <span className="warn">armed · watching</span> : <span className="dim">armed · salt not on this device</span>}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
      {toast && <div className="banner" style={{ position: "fixed", bottom: 16, left: 16, right: 16, textAlign: "center" }} onClick={() => setToast("")}>{toast}</div>}
    </>
  );
}
