// Stake page: top up, plant fiat mines on Byte's hand, back Byte, and auto-reveal when Byte plays
// a mined card. The salt and word never leave this browser until the word has been played (I2);
// commitments are computed with the server TREASURY pubkey because the treasury is the on-chain
// setter for every fiat mine (I1).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePollar, useChains, addressForChain, WalletButton } from "@pollar/react";
import type { SubmitOutcome, TxHistoryState, WalletBalanceState } from "@pollar/core";

type Mode = "demo" | "pollar";
const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";
const POLL_MS = 1500;
const SECRETS_KEY = "wt.fiat.secrets";
const USER_KEY = "wt.demo.user";

interface Secret { word: string; saltHex: string; runId: string; armedTurn: number }
interface Treasury { setter: string; pubkeyHex: string; chain: string; mode: string; address?: string; usdcMint?: string; network?: string }
const RETURN_TO = (() => { const r = new URLSearchParams(location.search).get("return") ?? ""; return /^\/[^/\\]/.test(r) ? r : ""; })();   // same-origin path only

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
// Guest identity shared with the plain pages (/identity.js): "guest-" + 8 random characters, made once.
const ID_KEY = "wt.identity", MODE_KEY = "wt.identity.mode", NAME_KEY = "wt.profile.name", CHOICE_KEY = "wt.identity.choice";
function newGuestId() { const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; return "guest-" + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => a[x % a.length]).join(""); }
/** What a player may read: known raw server strings become sentences, player sentences pass through, anything else falls back. */
export function friendly(raw: unknown, fallback = "That didn't work. Try again."): string {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  if (/bearer|authorization|demo-credit|send \{user\}|sign in with (pollar|google)/i.test(s)) return "Sign in to play.";
  if (/insufficient balance/i.test(s)) return "Not enough funds. Add funds to play.";
  if (/dev credits only/i.test(s)) return "Test funds aren't available on this server. Sign in with Google to add funds.";
  if (/^[A-Z][^{}<>`]*[.!?]$/.test(s) && !/:\s*\S*(error|undefined|null)/i.test(s)) return s;
  return fallback;
}
export const shortAddress = (id: string) => (!id ? "" : id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);
export function readIdentity() { try { return { id: localStorage.getItem(ID_KEY) ?? "", mode: localStorage.getItem(MODE_KEY) ?? "", name: localStorage.getItem(NAME_KEY) ?? "", chosen: !!localStorage.getItem(CHOICE_KEY) }; } catch { return { id: "", mode: "", name: "", chosen: false }; } }
export function chooseGuest(): string { const cur = readIdentity(); const id = cur.mode === "guest" && cur.id ? cur.id : newGuestId(); try { localStorage.setItem(ID_KEY, id); localStorage.setItem(MODE_KEY, "guest"); localStorage.setItem(CHOICE_KEY, "1"); } catch { /* private */ } return id; }

/** The SDK persists its session as `pollar:<apiKeyHash>:session` ({ token: { accessToken, expiresAt } }); it exposes
 *  no token getter, so this is how the server gets a token to verify with POST /v3/tokens/verify. */
function readSdkToken(client: any): string | null {
  try {
    const hash = client?.apiKeyHash;
    if (!hash) return null;
    const row = JSON.parse(localStorage.getItem(`pollar:${hash}:session`) ?? "null");
    const t = row?.token?.accessToken;
    const exp = Number(row?.token?.expiresAt ?? 0);
    if (!t || (exp && (exp < 1e12 ? exp * 1000 : exp) < Date.now())) return null;
    return String(t);
  } catch { return null; }
}
/** USDC on Solana from the balance hook's records (decimal units), or null while unknown. */
function usdcOf(b: WalletBalanceState | undefined): number | null {
  if (!b || b.step !== "loaded") return null;
  const r = b.data.balances.find((x) => String(x.chain ?? "").toUpperCase() === "SOLANA" && x.code.toUpperCase() === "USDC");
  const v = Number(r?.available ?? r?.balance ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Identity for both pages. Pollar mode is Pollar's own hooks: `usePollar()` (login/logout, wallet, walletBalance,
 * sendPayment, txHistory, getClient) and `useChains()` + `addressForChain` for the Solana address. Demo mode is a
 * guest id or a Wallet Standard address. `mode` never changes after mount, so the hook order is stable.
 */
export function useIdentity(mode: Mode) {
  const p = mode === "pollar" ? usePollar() : null;
  const chains = mode === "pollar" ? useChains() : null;
  const [user, setUser] = useState<string>(() => (mode === "pollar" ? "" : readIdentity().id));
  const [displayName, setDisplayName] = useState<string>(() => readIdentity().name);
  const label = displayName || shortAddress(user);
  const [token, setToken] = useState<string | null>(null);
  const [pollarErr, setPollarErr] = useState<string | null>(null);

  // signed in through Pollar: the Solana wallet is the identity; the access token goes to the server as Bearer
  const solAddress = p ? (addressForChain(p.wallets, "SOLANA") || (chains?.primaryChain === "SOLANA" ? chains.primaryAddress : "") || p.wallet?.address || "") : "";
  useEffect(() => {
    if (!p) return;
    if (!p.isAuthenticated) { setUser(""); setToken(null); try { localStorage.removeItem("wt.session.token"); } catch { /* private */ } return; }
    setUser(solAddress);
    const t = readSdkToken(p.getClient());
    setToken(t);
    setPollarErr(t ? null : "Signed in, but no Pollar access token was found in this browser. Sign in again.");
    if (solAddress && t) {
      // the plain pages (watch, lobby) read the same keys and send the token as Authorization: Bearer
      try { localStorage.setItem(ID_KEY, solAddress); localStorage.setItem(MODE_KEY, "wallet"); localStorage.setItem(CHOICE_KEY, "1"); localStorage.setItem("wt.session.token", t); } catch { /* private */ }
      if (RETURN_TO) location.replace(RETURN_TO);   // back to the page the player came from, signed in
    }
  }, [p?.isAuthenticated, p?.verified, solAddress]);
  // wallet balance (USDC on Solana) from the balance hook; loaded once signed in, refreshed by refreshWallet()
  useEffect(() => { if (p?.isAuthenticated && p.walletBalance.step === "idle") p.refreshWalletBalance().catch(() => {}); }, [p?.isAuthenticated, p?.walletBalance.step]);
  const usdc = useMemo(() => usdcOf(p?.walletBalance), [p?.walletBalance]);
  const refreshWallet = useCallback(async () => { if (p?.isAuthenticated) await p.refreshWalletBalance().catch(() => {}); }, [p?.isAuthenticated, p?.refreshWalletBalance]);
  // transaction history from the history hook (reactive `txHistory`, loaded by the client's fetchTxHistory)
  const loadHistory = useCallback(async () => { if (p?.isAuthenticated) await p.getClient().fetchTxHistory({ limit: 20, offset: 0 }).catch(() => {}); }, [p?.isAuthenticated]);
  useEffect(() => { if (p?.isAuthenticated) loadHistory(); }, [p?.isAuthenticated, loadHistory]);

  /** Demo mode: the identity is a guest id made once, never a typed handle. */
  const setDemoUser = () => setUser(chooseGuest());
  const saveName = async (name: string) => {
    const r = await fetch(SERVER + "/api/v1/profile", { method: "PUT", headers: { "content-type": "application/json", ...(mode === "demo" ? { "x-user": user } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ name }) });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(friendly(p.error, "Could not save the name."));
    setDisplayName(p.name); try { localStorage.setItem(NAME_KEY, p.name); } catch { /* private */ }
    return p.name as string;
  };
  useEffect(() => {                                   // pick up a name saved on another page
    if (!user) return;
    fetch(SERVER + "/api/v1/profile", { headers: { ...(mode === "demo" ? { "x-user": user } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }).then((r) => r.ok ? r.json() : null).then((p) => { if (p?.name) { setDisplayName(p.name); try { localStorage.setItem(NAME_KEY, p.name); } catch { /* private */ } } }).catch(() => {});
  }, [user, token, mode]);
  const connectWallet = async () => {
    const { getWallets } = await import("@wallet-standard/app");
    const wallets = getWallets().get().filter((w: any) => w.features["standard:connect"] && w.chains.some((c: string) => c.startsWith("solana:")));
    if (!wallets.length) throw new Error("No Solana wallet was found. Install Phantom, Solflare or Backpack.");
    const w: any = wallets[0];
    const { accounts } = await w.features["standard:connect"].connect();
    if (!accounts?.length) throw new Error("The wallet did not share an account.");
    const addr = String(accounts[0].address);                       // a connected wallet IS the identity
    setUser(addr); try { localStorage.setItem(ID_KEY, addr); localStorage.setItem(MODE_KEY, "wallet"); localStorage.setItem(CHOICE_KEY, "1"); } catch { /* private */ }
  };

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mode === "pollar" && token) h.authorization = `Bearer ${token}`;
    if (mode === "demo" && user) h["x-user"] = user;
    return h;
  }, [mode, token, user]);

  /** USDC to the game treasury through the SDK's payment call (embedded wallets); returns the SubmitOutcome (`hash` = signature). */
  const sendUsdc = useCallback((destination: string, micro: number, mint: string): Promise<SubmitOutcome> => {
    if (!p) return Promise.reject(new Error("Pollar wallet unavailable"));
    return p.sendPayment({ chain: "SOLANA", destination, amount: String(micro), mint });
  }, [p?.sendPayment]);

  return { mode, user, token, pollar: p, pollarErr, setDemoUser, connectWallet, headers, label, displayName, saveName, chosen: readIdentity().chosen,
    signInGoogle: () => p?.login({ provider: "google" }), openSignIn: () => p?.openLoginModal(),
    signOut: () => { p?.logout(); try { localStorage.removeItem("wt.session.token"); } catch { /* private */ } },
    usdc, walletStep: p?.walletBalance.step ?? "idle", refreshWallet, sendUsdc,
    txHistory: (p?.txHistory ?? { step: "idle" }) as TxHistoryState, loadHistory, openTxHistory: () => p?.openTxHistoryModal() };
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
    if (!r.ok && r.status !== 202) throw new Error(friendly(j.error));
    return j;
  }, [id.headers, id.user, mode]);

  const say = (s: string) => { setToast(s); setTimeout(() => setToast(""), 6000); };
  const refreshBalance = useCallback(async () => { if (!id.user) return; try { setBalance(await api("/api/v1/fiat/balance")); } catch { /* not signed in */ } await id.refreshWallet(); if (mode === "pollar") id.loadHistory(); }, [api, id.user, id.refreshWallet, id.loadHistory, mode]);

  useEffect(() => { fetch(SERVER + "/api/v1/treasury").then((r) => r.json()).then(setTreasury).catch(() => setTreasury(null)); }, []);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  // poll the public spectator feed; auto-reveal our mines once Byte has played the word on an armed turn
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        let rid = runId;
        if (!rid) { const c = await fetch(SERVER + "/api/v1/current").then((r) => r.json()); if (!c.runId) return; rid = c.runId; setRunId(rid); }
        const r = await fetch(`${SERVER}/runs/${rid}/spectate?delay=0`);   // planters act on the real, undelayed game
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

  // Add funds: the Pollar payment call sends USDC from the player's wallet to the game treasury, then the transaction
  // signature goes to our server, which confirms it on Solana before crediting. Cash top-ups (ramp orders): [ROADMAP].
  async function doTopUp() {
    try {
      if (mode === "demo") { const r = await api("/dev/credit", { amount: topUp }); say(`demo credit +$${topUp} (payment ${r.paymentId})`); refreshBalance(); return; }
      if (!treasury?.address || !treasury.usdcMint) throw new Error("The server has no treasury address or USDC mint for this network yet.");
      const micro = Math.round(topUp * 1e6);
      if (!(micro > 0)) throw new Error("Choose an amount.");
      say(`sending $${topUp.toFixed(2)} USDC to the treasury…`);
      const out = await id.sendUsdc(treasury.address, micro, treasury.usdcMint);
      if (out.status === "error") throw new Error((out as any).details ?? (out as any).message ?? "The payment was not sent.");
      if (out.status === "cosign_pending") throw new Error("The payment is waiting for another device's approval. Confirm it there, then paste the signature below.");
      const r = await api("/api/v1/fiat/confirm", { signature: out.hash, amount: topUp });
      say(r.status === "credited" ? `credited $${(r.micro / 1e6).toFixed(2)}` : `payment ${out.hash.slice(0, 8)}… is ${r.status}; the server re-checks it until it is final`);
      refreshBalance();
    } catch (e: any) { say(e.message); }
  }
  async function confirmManual() {
    try { const r = await api("/api/v1/fiat/confirm", mode === "demo" ? { paymentId } : { signature: paymentId, amount: topUp }); say(`payment ${paymentId.slice(0, 12)}…: ${r.status}${r.duplicate ? " (already credited)" : ""}`); setPaymentId(""); refreshBalance(); }
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
        <a className="logo" href="/play"><img src="/wordtrap-wordmark-dark.png" alt="WordTrap" width={120} height={32} /><b>· STAKE</b></a>
        {runId && <a className="dim" href={`${SERVER}/watch/${runId}`} target="_blank" rel="noreferrer">watch run {runId} ↗</a>}
        {mode === "pollar" && signedIn && <span className="dim">wallet USDC {id.usdc === null ? "…" : `$${id.usdc.toFixed(2)}`} · game balance ${((balance?.balanceMicro ?? 0) / 1e6).toFixed(2)}</span>}
        {mode === "pollar" && <WalletButton />}
        <span className="meta">{state ? `turn ${state.turn} · fuse ${state.fuse} · ${state.status}` : "waiting for a run…"}</span>
      </header>
      <main>
        {mode === "demo" && <div className="banner wide">DEMO CREDITS — no Pollar key configured (VITE_POLLAR_PUBLISHABLE_KEY). Balances are play money from /dev/credit; everything else is the real flow.</div>}
        {id.pollarErr && <div className="banner err wide">{id.pollarErr}</div>}

        <section className="panel">
          <div className="label">You</div>
          {mode === "pollar" ? (
            signedIn ? <div className="row"><span className="ok" title={id.user}>{id.label}</span><button className="ghost" onClick={id.signOut}>sign out</button></div>
              : <div className="row"><button onClick={id.signInGoogle}>Sign in with Google</button><button className="ghost" onClick={id.openSignIn}>Other ways to sign in</button><span className="dim">creates your Pollar wallet</span></div>
          ) : (
            <div className="row">
              {id.user ? <span className="ok" title={id.user}>{id.label}</span> : <button onClick={() => id.setDemoUser()}>Play as guest</button>}
              <button className="ghost" onClick={() => id.connectWallet().then(() => say("wallet connected")).catch((e) => say(e.message))}>or connect a Solana wallet</button>
            </div>
          )}
          <div className="label" style={{ marginTop: 14 }}>Pollar wallet balance</div>
          <div className="big">${balance ? (balance.balanceMicro / 1e6).toFixed(2) : "0.00"}</div>
          <div className="row">
            <input type="number" min={1} step={1} value={topUp} onChange={(e) => setTopUp(Number(e.target.value))} style={{ width: 90 }} />
            <button className="safe" disabled={!signedIn} onClick={doTopUp}>Add test funds</button>
          </div>
          {mode === "pollar" && <div className="row"><input value={paymentId} placeholder="transaction signature (re-check)" onChange={(e) => setPaymentId(e.target.value)} /><button className="ghost" disabled={!paymentId} onClick={confirmManual}>confirm</button></div>}
          <div className="dim" style={{ marginTop: 8, fontSize: 11 }}>Credits only land after the server confirms the USDC transfer on Solana{treasury?.network ? ` (${treasury.network})` : ""}. Treasury: {treasury ? `${(treasury.address ?? treasury.pubkeyHex).slice(0, 10)}…` : "…"}. Cash top-ups: roadmap.</div>
          {mode === "pollar" && signedIn && (
            <div style={{ marginTop: 14 }}>
              <div className="label">Your activity <button className="ghost" onClick={id.loadHistory}>refresh</button> <button className="ghost" onClick={id.openTxHistory}>open</button></div>
              {id.txHistory.step === "loaded"
                ? (id.txHistory.data.records.length
                  ? <ul className="activity">{id.txHistory.data.records.map((r) => <li key={r.id}><span>{r.summary}</span><span className="dim">{r.status.toLowerCase()} · {new Date(r.createdAt).toLocaleString()}</span></li>)}</ul>
                  : <div className="dim">No wallet activity yet.</div>)
                : id.txHistory.step === "error" ? <div className="dim">{id.txHistory.message}</div> : <div className="dim">Loading…</div>}
            </div>
          )}
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
