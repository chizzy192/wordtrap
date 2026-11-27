// Funds page (/stake/): sign in through Pollar, move USDC from the Pollar wallet into the game balance, see the live
// room and your wallet activity. Pollar's own hooks do the wallet work (usePollar: login/logout, wallet, walletBalance,
// sendPayment, txHistory, modals); the server confirms every top-up on Solana before crediting (apps/server/src/fiat.ts).
// The identity helpers here are shared with the "Pick a side" page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePollar, useChains, addressForChain } from "@pollar/react";
import type { SubmitOutcome, TxHistoryState, WalletBalanceState } from "@pollar/core";
import { fmtUsd, toTokens, unitsOf } from "./units";
import { useMockPollar, mockPollarConfig } from "./mockPollar";

type Mode = "demo" | "pollar";
const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";
const POLL_MS = 2000;
/** The USDC devnet faucet Pollar's wallet balance modal links to. */
const FAUCET = "https://faucet.circle.com/";
const CHIPS = [1, 2, 5, 10];
/** Browser-test builds only (VITE_WT_MOCK_POLLAR=1): usePollar() is replaced by a mock when the test has set window.__wtPollarMock. */
const MOCK_POLLAR = import.meta.env.VITE_WT_MOCK_POLLAR === "1";
const CANCELLED = "Payment cancelled. Nothing was sent.";
const cancelled = () => new Error(CANCELLED);

interface Treasury { setter: string; pubkeyHex: string; chain: string; mode: string; address?: string; usdcMint?: string; network?: string; guestStartFunds?: number }
const RETURN_TO = (() => { const r = new URLSearchParams(location.search).get("return") ?? ""; return /^\/[^/\\]/.test(r) ? r : ""; })();   // same-origin path only
/** ?demo=signedout|empty|funded overlays presentation fixtures so every state can be reviewed and tested without a Pollar session; &ready=0 adds the "server cannot credit this wallet" state. */
const DEMO = new URLSearchParams(location.search).get("demo");

// ---- identity (I6): shared with the plain pages (/identity.js): "guest-" + 8 random characters, made once ----
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
/** Copy text for the player: the clipboard API, else a hidden textarea + execCommand("copy"). */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch { return false; }
}
/** The link that opens a room from the lobby. */
export const roomLink = (code: string) => `${location.origin}/play?room=${encodeURIComponent(code)}`;
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
/** USDC on Solana from the balance hook's records: Pollar reports integer base units, converted with the record's decimals. */
function usdcOf(b: WalletBalanceState | undefined): number | null {
  if (!b || b.step !== "loaded") return null;
  const r = b.data.balances.find((x) => String(x.chain ?? "").toUpperCase() === "SOLANA" && x.code.toUpperCase() === "USDC");
  if (!r) return 0;
  const raw = r.available ?? r.balance ?? "0";
  return /^\d+$/.test(String(raw)) ? toTokens(String(raw), r.decimals ?? 6) : Number(raw) || 0;
}

/**
 * Identity for both pages. Pollar mode is Pollar's own hooks: `usePollar()` (login/logout, wallet, walletBalance,
 * sendPayment, txHistory, getClient, the modals) and `useChains()` + `addressForChain` for the Solana address.
 * Demo mode is a guest id or a Wallet Standard address. `mode` never changes after mount, so the hook order is stable.
 */
export function useIdentity(mode: Mode) {
  const mock = MOCK_POLLAR && mode === "pollar" ? mockPollarConfig() : null;   // never set in a normal build
  const p: ReturnType<typeof usePollar> | null = mode === "pollar" ? (mock ? useMockPollar() : usePollar()) : null;
  const chains = mode === "pollar" && !mock ? useChains() : null;
  const [user, setUser] = useState<string>(() => (mode === "pollar" ? "" : readIdentity().id));
  const [displayName, setDisplayName] = useState<string>(() => readIdentity().name);
  const label = displayName || shortAddress(user);
  const [token, setToken] = useState<string | null>(null);
  const [pollarErr, setPollarErr] = useState<string | null>(null);

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
    signOut: () => { p?.logout(); try { localStorage.removeItem("wt.session.token"); localStorage.removeItem(ID_KEY); localStorage.removeItem(MODE_KEY); } catch { /* private */ } },
    usdc, walletStep: p?.walletBalance.step ?? "idle", refreshWallet, sendUsdc,
    txHistory: (p?.txHistory ?? { step: "idle" }) as TxHistoryState, loadHistory, openTxHistory: () => p?.openTxHistoryModal(),
    openWallet: () => p?.openWalletBalanceModal(), openSend: () => p?.openSendModal(), solAddress };
}

/**
 * Manners for Pollar's modals, which the SDK renders in place with its own overlay: close on Escape, keep keyboard
 * focus inside the open card, and put focus back where it was when the card goes away.
 */
function useModalManners(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let last: Element | null = null, card: HTMLElement | null = null;
    const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => e.offsetParent !== null);
    const onKey = (e: KeyboardEvent) => {
      if (!card) return;
      if (e.key === "Escape") { e.preventDefault(); (card.querySelector<HTMLElement>(".pollar-modal-close, [aria-label='Close']"))?.click(); return; }
      if (e.key === "Tab") {
        const f = focusables(card); if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    const sync = () => {
      const now = document.querySelector<HTMLElement>(".pollar-overlay .pollar-modal-card");
      if (now && now !== card) { last = document.activeElement; card = now; (focusables(now)[0] ?? now).focus(); }
      if (!now && card) { card = null; (last as HTMLElement | null)?.focus?.(); last = null; }
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    return () => { mo.disconnect(); document.removeEventListener("keydown", onKey, true); };
  }, [enabled]);
}

const usd = (n: number) => "$" + Number(n || 0).toFixed(2);
const money = (n: number) => (Number.isInteger(n) ? "$" + n : usd(n));
function when(iso: string | number) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${hm}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${hm}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${hm}`;
}
interface Row { id: string; text: string; amount: string | null; neg: boolean; at: string }
/** One Pollar history record as a sentence. Amounts are base units with the record's decimals (USDC: 6). A USDC
 *  transfer to the game treasury reads "Added $x to game" once our server has credited that signature, and
 *  "Payment sent, waiting for credit" until then. */
function rowOf(r: any, treasury: string | null | undefined, credited: Set<string>): Row {
  const sum = String(r.summary ?? r.operation ?? "Wallet activity");
  const d = r.details ?? {};
  const amtRaw = d.amount ?? r.amount ?? null;
  const decimals = typeof d.decimals === "number" ? d.decimals : 6;
  const amt = amtRaw != null && /^\d+$/.test(String(amtRaw)) ? fmtUsd(String(amtRaw), decimals) : null;
  const dest = String(d.destination ?? d.to ?? r.destination ?? "");
  const toTreasury = !!treasury && (dest === treasury || sum.includes(shortAddress(treasury)));
  const sig = String(r.hash ?? r.id ?? "");
  const text = toTreasury ? (credited.has(sig) && amt ? `Added ${amt} to game` : "Payment sent, waiting for credit") : sum.replace(/\.$/, "");
  return { id: String(r.id ?? r.hash), text, amount: amt ? `${toTreasury ? "+" : ""}${amt}` : null, neg: false, at: when(r.createdAt) };
}
/** Signatures the page is still trying to get credited, kept per player until the server answers credited. */
const pendingKey = (user: string) => `wt.pending.${user}`;
interface Pending { signature: string; amount: number; at?: number }
function loadPending(user: string): Pending[] { try { return JSON.parse(localStorage.getItem(pendingKey(user)) ?? "[]"); } catch { return []; } }
function savePending(user: string, list: Pending[]) { try { if (list.length) localStorage.setItem(pendingKey(user), JSON.stringify(list)); else localStorage.removeItem(pendingKey(user)); } catch { /* private */ } }

/** Fixtures for ?demo= (presentation only; nothing is sent to the server). */
function fixture(demo: string | null) {
  if (demo === "signedout") return { signedIn: false } as const;
  if (demo === "empty" || demo === "funded") {
    const funded = demo === "funded";
    const now = Date.now();
    return { signedIn: true, name: "Emmanuel", address: "BhPmKWjR5t2cq8ULqu9vnM3nGhtaJ6V", usdc: funded ? 8 : 0, game: funded ? 2 : 0,
      rows: funded ? [{ id: "a", text: "Added to game", amount: "+$2.00", neg: false, at: when(now - 5 * 60e3) }, { id: "b", text: "Test USDC received", amount: "+$10.00", neg: false, at: when(now - 9 * 60e3) }, { id: "c", text: "Signed in with Google", amount: null, neg: false, at: when(now - 12 * 60e3) }] : [],
      run: { runId: "demo", callsign: "Oly", turn: 9, fuse: 122, cleared: 3, tiles: 7, seatsOpen: 4 } } as const;
  }
  return null;
}

export function App({ mode }: { mode: Mode }) {
  const id = useIdentity(mode);
  useModalManners(mode === "pollar");
  const demo = fixture(DEMO);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [balance, setBalance] = useState<any>(null);
  const [run, setRun] = useState<{ runId: string; callsign: string; turn: number; fuse: number; cleared: number; tiles: number; seatsOpen: number } | null>(null);
  const [amount, setAmount] = useState(5);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  // "sending" only while Pollar's window is open; once a signature exists the button is free and the pending list carries the wait
  const [funding, setFunding] = useState<{ step: "idle" | "sending" | "done" | "refused"; text: string }>({ step: "idle", text: "" });
  const [copied, setCopied] = useState(false);
  const [, forceRender] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  // Readiness: the server says whether it can credit a payment from the wallet the SDK will pay from. Nothing is sent otherwise.
  const [ready, setReady] = useState<{ ready: boolean; reason: string; link: boolean; checked: boolean }>({ ready: false, reason: "", link: false, checked: false });
  const [link, setLink] = useState<{ step: "idle" | "starting" | "ready" | "paying" | "confirming" | "done" | "refused"; amountMicro: number; amountText: string; wording: string; text: string }>({ step: "idle", amountMicro: 0, amountText: "", wording: "", text: "" });
  const [cashout, setCashout] = useState<{ open: boolean; amount: string; step: "idle" | "sending" | "sent" | "pending" | "refunded" | "refused"; text: string }>({ open: false, amount: "", step: "idle", text: "" });
  const [checking, setChecking] = useState<{ busy: boolean; text: string }>({ busy: false, text: "" });

  /** Server call. `http` is the HTTP status (the body's own `status` field, "sent" or "credited", is kept as is). A refusal
   *  throws the player sentence with the HTTP status as `cause`; a dead connection throws an "Offline" error so callers can keep retrying. */
  const api = useCallback(async (path: string, body?: unknown) => {
    let r: Response;
    try { r = await fetch(SERVER + path, body === undefined ? { headers: id.headers(), cache: "no-store" } : { method: "POST", headers: id.headers(), body: JSON.stringify({ ...(body as object), ...(mode === "demo" ? { user: id.user } : {}) }) }); }
    catch { const e = new Error("The server didn't answer. Try again in a moment."); e.name = "Offline"; throw e; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(friendly(j.error), { cause: r.status });   // cause = the HTTP status
    return { http: r.status, ...j };
  }, [id.headers, id.user, mode]);
  const idRef = useRef(id); idRef.current = id;   // the latest hook values for timers, without re-subscribing them

  /** The success line under the buttons, shown for 6 s. */
  const doneTimer = useRef(0);
  const announce = useCallback((text: string) => {
    setFunding({ step: "done", text });
    clearTimeout(doneTimer.current);
    doneTimer.current = window.setTimeout(() => setFunding((f) => (f.step === "done" ? { step: "idle", text: "" } : f)), 6000);
  }, []);

  // Cash-out bookkeeping: the requestId (and amount) of a withdrawal this browser asked for is kept until the server
  // settles it, so a retry or a later refresh asks about the same withdrawal instead of starting another.
  const wdKey = useCallback(() => `wt.cashout.${id.user}`, [id.user]);
  const loadWd = useCallback((): { requestId: string; amount: string } | null => { try { const raw = localStorage.getItem(wdKey()); if (!raw) return null; return raw.startsWith("{") ? JSON.parse(raw) : { requestId: raw, amount: "0" }; } catch { return null; } }, [wdKey]);
  const clearWd = useCallback(() => { try { localStorage.removeItem(wdKey()); } catch { /* private */ } }, [wdKey]);
  const wdBusy = useRef(false);
  /** The wallet's balance lags the chain: after a cash-out it is read again after 5 s and 15 s (and right away by refreshAll). */
  const walletSoon = useCallback(() => { for (const ms of [5000, 15000]) setTimeout(() => idRef.current.refreshWallet(), ms); }, []);
  /** The server's answer to a withdrawal, fresh or re-asked by requestId: the game balance comes from the response at once. */
  const applyWithdrawAnswer = useCallback((r: any) => {
    if (typeof r.balanceMicro === "number") setBalance((b: any) => ({ ...(b ?? {}), balanceMicro: r.balanceMicro, balanceUsd: r.balanceUsd }));
    if (r.status === "sent") { clearWd(); setCashout({ open: false, amount: "", step: "sent", text: `Sent ${usd(r.micro / 1e6)} to your Pollar wallet` }); walletSoon(); }
    else if (r.status === "refunded") { clearWd(); setCashout((c) => ({ ...c, step: "refunded", text: friendly(r.reason, "The transfer did not go through. Your balance was restored.") })); }
    else setCashout((c) => ({ ...c, open: false, step: "pending", text: "Sending to your wallet…" }));   // 202: asked again every 5 s
  }, [clearWd, walletSoon]);

  /** One source of truth. Reloads the game balance (with the credited signatures), settles a pending withdrawal, and reads
   *  the Pollar wallet balance and activity. Called after every action, on window focus, every 5 s while anything is
   *  pending and every 30 s otherwise. A pending payment row never outlives its credit: any stored signature the server
   *  lists as credited is dropped here. */
  const refreshAll = useCallback(async () => {
    if (!id.user) return;
    try {
      const bal = await api("/api/v1/fiat/balance");
      setBalance(bal);
      if (mode === "pollar") {
        const credited = new Set<string>((bal.deposits ?? []).map(String));
        const list = loadPending(id.user), keep = list.filter((p) => !credited.has(p.signature));
        if (keep.length !== list.length) { savePending(id.user, keep); setPending(keep); announce(`Added ${usd(list.filter((p) => credited.has(p.signature)).reduce((a, p) => a + p.amount, 0))} to your game balance`); }
      }
    } catch { /* signed out or offline: the next refresh tries again */ }
    // a withdrawal still "pending" (or one this browser never heard the end of): a re-ask by requestId only looks it up, never sends again
    const w = loadWd();
    if (mode === "pollar" && w && !wdBusy.current) {
      try { applyWithdrawAnswer(await api("/api/v1/fiat/withdraw", { amount: "0", requestId: w.requestId })); }
      catch (e: any) { if (e.name !== "Offline" && e.cause !== 409) clearWd(); }   // the server never had it
    }
    await Promise.all([idRef.current.refreshWallet(), mode === "pollar" ? idRef.current.loadHistory() : Promise.resolve()]);
  }, [api, id.user, mode, announce, loadWd, clearWd, applyWithdrawAnswer]);
  const refreshRef = useRef(refreshAll); refreshRef.current = refreshAll;
  /** GET /api/v1/fiat/ready for the address the SDK would pay from. Called on sign-in and again right before a send. */
  const checkReady = useCallback(async (paying: string): Promise<{ ready: boolean; reason: string; link: boolean }> => {
    if (mode !== "pollar") return { ready: true, reason: "", link: false };
    if (DEMO) {   // review fixtures: ?ready=0 shows the not-ready state without a session
      return new URLSearchParams(location.search).get("ready") === "0" ? { ready: false, link: true, reason: "We couldn't find your Solana wallet with Pollar. Do the one-time wallet check below to link it." } : { ready: true, reason: "", link: false };
    }
    try {
      const r = await fetch(SERVER + "/api/v1/fiat/ready?address=" + encodeURIComponent(paying), { headers: id.token ? { authorization: `Bearer ${id.token}` } : {}, cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && typeof j.ready === "boolean") return { ready: j.ready, reason: j.ready ? "" : friendly(j.reason, "Payments are paused. Try again in a minute."), link: !!j.link };
      return { ready: false, reason: friendly(j.reason ?? j.error, "Sign in to add funds."), link: false };
    } catch { return { ready: false, reason: "The server didn't answer. Try again in a moment.", link: false }; }
  }, [mode, id.token]);
  useEffect(() => { fetch(SERVER + "/api/v1/treasury").then((r) => r.json()).then(setTreasury).catch(() => setTreasury(null)); }, []);
  useEffect(() => { if (mode === "pollar" && id.user) setPending(loadPending(id.user)); }, [mode, id.user]);   // what an earlier visit left waiting

  // Signatures sent but not yet credited: asked every 3 s for their first 90 s, then every 30 s, until the server says credited.
  useEffect(() => {
    if (mode !== "pollar" || !id.user || !id.token || !pending.length) return;
    let alive = true, timer = 0;
    const tick = async () => {
      const list = loadPending(id.user), keep: Pending[] = []; let creditedMicro = 0;
      for (const item of list) {
        try {
          const r = await api("/api/v1/fiat/confirm", { signature: item.signature, amount: item.amount });
          if (r.http === 200) creditedMicro += Number(r.micro) || Math.round(item.amount * 1e6); else keep.push(item);   // 202: still pending
        } catch (e: any) { if (e.name === "Offline") keep.push(item); else setFunding({ step: "refused", text: friendly(e.message) }); }   // a definite refusal drops it and says why
      }
      if (!alive) return;
      savePending(id.user, keep); setPending(keep);
      if (creditedMicro) { announce(`Added ${usd(creditedMicro / 1e6)} to your game balance`); refreshRef.current(); }
      if (keep.length) timer = window.setTimeout(tick, keep.some((k) => Date.now() - (k.at ?? 0) < 90_000) ? 3000 : 30_000);
    };
    timer = window.setTimeout(tick, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [mode, id.user, id.token, pending.length, api, announce]);
  // On sign-in, ask the server to credit any finalized deposit from this wallet it has not credited yet.
  const reconcile = useCallback(async (manual = false) => {
    if (mode !== "pollar" || !id.user || !id.token) return;
    if (manual) setChecking({ busy: true, text: "Checking recent payments…" });
    try {
      const r = await api("/api/v1/fiat/reconcile", {});
      const n = (r.credited ?? []).length;
      if (manual) setChecking({ busy: false, text: n ? `Found ${n} payment${n === 1 ? "" : "s"}: added ${usd((r.credited as any[]).reduce((a, c) => a + c.micro, 0) / 1e6)}.` : "No missing payments. Everything sent from your wallet is already in your game balance." });
      if (n) refreshRef.current();
    } catch (e: any) { if (manual) setChecking({ busy: false, text: friendly(e.message) }); }
  }, [mode, id.user, id.token, api]);
  useEffect(() => { if (mode === "pollar" && id.user && id.token) reconcile(false); }, [mode, id.user, id.token]);

  // the live room: the current run's name, turn, fuse, cleared tiles and open seats
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const c = await fetch(SERVER + "/api/v1/current").then((r) => r.json());
        if (!c.runId) { if (alive) setRun(null); return; }
        const { state: s } = await fetch(`${SERVER}/runs/${c.runId}/spectate?delay=0`).then((r) => r.json());
        if (!alive) return;
        if (s.status !== "live") { setRun(null); return; }
        setRun({ runId: c.runId, callsign: s.callsign || "Byte", turn: s.turn, fuse: s.fuse, cleared: s.tiles.filter((t: any) => t.cleared).length, tiles: s.tiles.length, seatsOpen: (s.seats ?? []).filter((x: any) => x.kind === "open" || x.kind === "bot").length });
      } catch { /* offline */ }
    };
    tick(); const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const toggleTheme = () => { const n = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", n); document.documentElement.classList.toggle("dark", n === "dark"); try { localStorage.setItem("wt.theme", n); } catch { /* private */ } forceRender((x) => x + 1); };
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);   // Pollar's stylesheet keys its dark palette off html.dark

  // what the page shows: live values, or the ?demo fixture
  const signedIn = demo ? demo.signedIn : !!id.user;
  const name = demo && demo.signedIn ? demo.name : id.displayName;
  const address = demo && demo.signedIn ? demo.address : id.user;
  const usdc: number | null = demo && demo.signedIn ? demo.usdc : (mode === "pollar" ? id.usdc : null);
  const gameUsd = demo && demo.signedIn ? demo.game : (balance?.balanceMicro ?? 0) / 1e6;
  const live = demo && demo.signedIn ? demo.run : run;
  const amt = showCustom && custom.trim() !== "" ? Number(custom) : amount;
  const walletEmpty = mode === "pollar" && usdc !== null && usdc < amt;
  const paying = demo && demo.signedIn ? demo.address : id.solAddress;
  useEffect(() => { if (!signedIn) return; let alive = true; checkReady(paying).then((r) => { if (alive) setReady({ ...r, checked: true }); }); return () => { alive = false; }; }, [signedIn, paying, checkReady, link.step === "done"]);
  const canAdd = signedIn && amt > 0 && funding.step !== "sending" && !walletEmpty && !(mode === "pollar" && !treasury?.address) && (mode !== "pollar" || ready.ready);
  const creditedSigs = useMemo(() => new Set<string>([...(balance?.deposits ?? []), ...(balance?.history ?? []).filter((h: any) => (h.reason === "pollar payment" || h.reason === "deposit") && h.ref).map((h: any) => String(h.ref))].map(String)), [balance]);
  const rows: Row[] = demo && demo.signedIn ? [...demo.rows] : (id.txHistory.step === "loaded" ? id.txHistory.data.records.map((r: any) => rowOf(r, treasury?.address, creditedSigs)) : []);
  const confirming = pending.length > 0;
  const pendingUsd = pending.reduce((a, p) => a + p.amount, 0);
  // refreshAll on load, on window focus, every 5 s while a payment or withdrawal is pending, every 30 s otherwise
  const busy = pending.length > 0 || funding.step === "sending" || cashout.step === "sending" || cashout.step === "pending";
  useEffect(() => {
    if (!id.user) return;
    refreshRef.current();
    const t = setInterval(() => refreshRef.current(), busy ? 5000 : 30_000);
    const onFocus = () => refreshRef.current();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [id.user, id.token, busy]);

  async function copyAddress() { if (await copyText(address)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }

  /** Cash-out: game balance back to the player's own Pollar wallet. The requestId is kept until the server settles it,
   *  so a retry after a dropped connection asks about the same withdrawal instead of starting another. */
  async function withdraw() {
    const prior = loadWd();   // an earlier request this browser never heard the end of is asked about, never repeated
    const amt = prior?.amount ?? cashout.amount.trim();
    const requestId = prior?.requestId ?? "wd-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { localStorage.setItem(wdKey(), JSON.stringify({ requestId, amount: amt })); } catch { /* private */ }
    setCashout((c) => ({ ...c, step: "sending", text: "Sending to your wallet…" }));
    wdBusy.current = true;
    try { applyWithdrawAnswer(await api("/api/v1/fiat/withdraw", { amount: amt, requestId })); }
    catch (e: any) { if (e.name !== "Offline" && e.cause !== 409) clearWd(); setCashout((c) => ({ ...c, step: "refused", text: friendly(e.message) })); }
    finally { wdBusy.current = false; refreshRef.current(); }   // both balances now; the wallet again at 5 s and 15 s
  }
  /** One-time wallet check: the server names an exact amount; the user pays it from the wallet they claim; the server
   *  links the address only when that exact, finalized payment arrives from it, then credits it as a deposit. */
  async function startLink() {
    setLink((l) => ({ ...l, step: "starting", text: "" }));
    try {
      const r = await api("/api/v1/fiat/link/start", {});
      if (r.linked) { setLink((l) => ({ ...l, step: "done", text: "Your wallet is already known." })); return; }
      setLink({ step: "ready", amountMicro: r.amountMicro, amountText: r.amountText, wording: r.wording, text: "" });
    } catch (e: any) { setLink((l) => ({ ...l, step: "refused", text: friendly(e.message) })); }
  }
  async function payLink() {
    if (!link.amountMicro) return;
    setLink((l) => ({ ...l, step: "paying", text: `Sending $${l.amountText} USDC…` }));
    try {
      const fresh: Treasury = await fetch(SERVER + "/api/v1/treasury", { cache: "no-store" }).then((r) => r.json());
      if (!fresh.address || !fresh.usdcMint) throw new Error("The server has no treasury address or USDC mint for this network yet.");
      const out = await id.sendUsdc(fresh.address, link.amountMicro, fresh.usdcMint);
      if (out.status === "error") throw new Error(friendly((out as any).details ?? (out as any).message, "The payment was not sent."));
      if (out.status === "cosign_pending") throw new Error("The payment is waiting for another device's approval.");
      setLink((l) => ({ ...l, step: "confirming", text: "Confirming your payment…" }));
      for (let i = 0; i < 60; i++) {
        const res = await fetch(SERVER + "/api/v1/fiat/link/confirm", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${id.token}` }, body: JSON.stringify({ signature: out.hash, address: id.solAddress }) });
        const j = await res.json().catch(() => ({}));
        if (res.status === 200) { setLink((l) => ({ ...l, step: "done", text: `Wallet linked. Added $${(j.credited / 1e6).toFixed(2)} to your game balance.` })); await refreshRef.current(); return; }
        if (res.status !== 202) throw new Error(friendly(j.reason ?? j.error));
        await new Promise((r) => setTimeout(r, 3000));
      }
      setLink((l) => ({ ...l, step: "refused", text: "Solana has not finalized that payment yet. Try the check again in a minute." }));
    } catch (e: any) { setLink((l) => ({ ...l, step: "refused", text: friendly(e.message) })); }
  }
  /** Add funds: USDC from the Pollar wallet to the treasury (sendPayment), then the server confirms it on Solana. */
  async function addFunds() {
    if (!canAdd) return;
    const micro = Math.round(amt * 1e6);
    setFunding({ step: "sending", text: "" });
    try {
      if (mode === "demo") {
        const r = await api("/dev/credit", { amount: amt });
        announce(`Added ${usd(r.micro / 1e6)} to your game balance`);
        await refreshRef.current(); return;
      }
      // never send before the server can credit: readiness is asked again right now, for the wallet the SDK pays from
      const gate = await checkReady(paying);
      setReady({ ...gate, checked: true });
      if (!gate.ready) throw new Error(gate.reason || "Payments are paused. Nothing was sent.");
      // the destination is read from the server right now, never from an earlier load
      const fresh: Treasury & { withdrawals?: string } = await fetch(SERVER + "/api/v1/treasury", { cache: "no-store" }).then((r) => r.json());
      setTreasury(fresh);
      if (fresh.mode === "pollar" && fresh.withdrawals !== "ready") throw new Error("This server has no treasury wallet set up yet, so adding funds is paused. Nothing was sent.");
      if (!fresh.address || !fresh.usdcMint) throw new Error("The server has no treasury address or USDC mint for this network yet.");
      // sendPayment takes integer base units for Solana (the mint's smallest unit): $5.00 of USDC is "5000000"
      let out: SubmitOutcome;
      try { out = await id.sendUsdc(fresh.address, micro, fresh.usdcMint); }
      catch { throw cancelled(); }   // Pollar's window was closed, or the SDK gave up before anything was signed
      if (out.status === "error") throw out.hash ? new Error(friendly(out.details ?? out.message, "The payment was not sent.")) : cancelled();   // declined = nothing was sent
      if (out.status === "cosign_pending") throw new Error("The payment is waiting for another device's approval.");
      // sent: the button is free again right now; the signature waits in the pending list until the server says credited
      const mine = [...loadPending(id.user), { signature: out.hash, amount: amt, at: Date.now() }]; savePending(id.user, mine); setPending(mine);
      setFunding({ step: "idle", text: "" });
    } catch (e: any) { setFunding({ step: "refused", text: friendly(e.message) }); }
  }

  const header = (
    <header>
      <a className="wordmark" href="/play"><img className="wm-light" src="/wordtrap-wordmark-light.png" alt="WordTrap" width={120} height={32} /><img className="wm-dark" src="/wordtrap-wordmark-dark.png" alt="WordTrap" width={120} height={32} /></a>
      <a className="nav" href="/play">Rooms</a>
      <a className="nav current" href="/stake/" aria-current="page">Funds</a>
      <span className="hright">
        {signedIn && mode === "pollar" && <span className="pill" aria-label="Pollar wallet balance"><small>Pollar wallet</small><b>{usdc === null ? "…" : usd(usdc)}</b></span>}
        {signedIn && <span className="pill yellow" aria-label="Game balance"><small>Game balance</small><b>{usd(gameUsd)}</b></span>}
        {mode === "pollar" && (signedIn
          ? <button type="button" className="walletbtn" data-wt="wallet" onClick={id.openWallet} aria-label={`Wallet ${shortAddress(address)}, open wallet`}><i aria-hidden="true"></i>{shortAddress(address)}</button>
          : <button type="button" className="walletbtn" data-wt="wallet" onClick={id.openSignIn}><i aria-hidden="true"></i>Sign in</button>)}
        <button id="themeBtn" type="button" aria-pressed={dark} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
          {dark ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>
                : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3a9 9 0 1 0 6 15.5A8 8 0 0 1 15 3z"/></svg>}
        </button>
      </span>
    </header>
  );

  if (!signedIn) {
    return (
      <div className="wrap">
        {header}
        <div className="strip"><h1>Sign in to add funds</h1></div>
        <section className="panel hero" aria-labelledby="heroh">
          <h2 id="heroh">Your Pollar wallet pays for mines and backing</h2>
          <p>Sign in with Google and Pollar makes you a wallet. Move USDC from it into the game, then set traps or back Byte in any room.</p>
          <div className="actions">
            {mode === "pollar"
              ? <><button type="button" className="btn blue" onClick={id.signInGoogle}>Sign in with Google</button><button type="button" className="btn outline" onClick={id.openSignIn}>Other ways to sign in</button></>
              : <button type="button" className="btn blue" onClick={() => { id.setDemoUser(); forceRender((x) => x + 1); }}>Play as guest</button>}
            <a className="btn text" href="/play">Play as guest with test funds</a>
          </div>
          {id.pollarErr && <p className="status err">{id.pollarErr}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="wrap">
      {header}
      {mode === "demo" && <div className="banner"><b>Test funds only.</b> No Pollar key is configured, so balances are play money.</div>}
      {id.pollarErr && <div className="banner err">{id.pollarErr}</div>}
      <div className="strip"><h1>Your funds</h1></div>
      <div className="grid">
        <section className="panel" aria-labelledby="acch">
          <h2 id="acch">Your account</h2>
          <div className="who">
            <span className="name">{name || shortAddress(address)}</span>
            <button type="button" className="addr" onClick={copyAddress} aria-label={`Copy wallet address ${address}`}>{copied ? "Copied" : shortAddress(address)}<span aria-hidden="true">⧉</span></button>
            {mode === "pollar" ? <button type="button" className="btn text" onClick={() => { id.signOut(); forceRender((x) => x + 1); }}>Sign out</button> : <span className="empty">Guest</span>}
          </div>
          <div className="tiles">
            <div className="tile"><div className="k">{mode === "pollar" ? "Pollar wallet" : "Test funds"}</div><div className="v">{mode === "pollar" ? (usdc === null ? "…" : usd(usdc)) : usd(treasury?.guestStartFunds ?? 10)}</div><div className="s">{mode === "pollar" ? `USDC on Solana ${treasury?.network ?? "devnet"}` : "play money, added below"}</div></div>
            <div className="arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square"><path d="M3 12h16M13 5l7 7-7 7"/></svg></div>
            <div className="tile yellow"><div className="k">Game balance</div><div className="v">{usd(gameUsd)}</div><div className="s">What you can stake</div></div>
          </div>
          <p className="sentence">Move USDC from your Pollar wallet into the game to play.</p>
          <hr className="divider" />
          <h2 id="addh">Add funds</h2>
          {mode === "pollar" && ready.checked && !ready.ready && !ready.link && <p className="notice err" role="alert" data-wt="not-ready">{ready.reason}</p>}
          {mode === "pollar" && ready.checked && ready.link && link.step !== "done" && (
            <div className="notice" role="group" aria-label="One-time wallet check" data-wt="link">
              <p>{ready.reason}</p>
              {link.step === "idle" || link.step === "starting" || link.step === "refused"
                ? <button type="button" className="btn blue" disabled={link.step === "starting"} onClick={startLink}>Start the wallet check</button>
                : <>
                    <p><b>{link.wording}</b></p>
                    {(link.step === "ready") && <button type="button" className="btn blue" disabled={walletEmpty} onClick={payLink}>Confirm ${link.amountText}</button>}
                    {(link.step === "paying" || link.step === "confirming") && <div className="status" role="status">{link.text}<div className="progress" aria-hidden="true"></div></div>}
                  </>}
              {link.step === "refused" && <p className="status err" role="alert">{link.text}</p>}
            </div>
          )}
          {link.step === "done" && <p className="status ok" role="status">{link.text}</p>}
          {walletEmpty && <p className="notice" role="status">Your Pollar wallet is empty. <a href={FAUCET} target="_blank" rel="noreferrer">Get test USDC</a> (devnet test money), then come back.</p>}
          <div className="chips" role="group" aria-label="Amount">
            {CHIPS.map((v) => <button key={v} type="button" className={`chip${!showCustom && amount === v ? " on" : ""}`} aria-pressed={!showCustom && amount === v} onClick={() => { setAmount(v); setShowCustom(false); }}>${v}</button>)}
            {showCustom
              ? <input className="custom" inputMode="decimal" placeholder="0.00" aria-label="Custom amount in dollars" autoFocus value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
              : <button type="button" className="chip dashed" onClick={() => setShowCustom(true)}>Other amount</button>}
          </div>
          {mode === "pollar" && amt > 0 && !walletEmpty && <p className="units">You're adding {usd(amt)} (Pollar shows this as {unitsOf(amt)} units of USDC)</p>}
          <div className="actions">
            <button type="button" className="btn red" disabled={!canAdd} aria-busy={funding.step === "sending"} onClick={addFunds}>{`Add ${money(amt > 0 ? amt : 0)} to game`}</button>
            {mode === "pollar" && <button type="button" className="btn outline" disabled={gameUsd < 1 || cashout.step === "sending"} onClick={() => setCashout((c) => ({ ...c, open: !c.open, amount: c.amount || Math.min(gameUsd, 5).toFixed(2), text: "" }))}>Withdraw</button>}
            {mode === "pollar" && <button type="button" className="btn outline" disabled={checking.busy} onClick={() => reconcile(true)}>Check for missing payments</button>}
          </div>
          {cashout.open && (
            <div className="cashout" role="group" aria-label="Withdraw to your Pollar wallet">
              <label>Withdraw <input className="custom" inputMode="decimal" aria-label="Amount in dollars" value={cashout.amount} onChange={(e) => setCashout((c) => ({ ...c, amount: e.target.value.replace(/[^0-9.]/g, "") }))} /> to your Pollar wallet</label>
              <button type="button" className="btn blue" disabled={cashout.step === "sending" || !(Number(cashout.amount) >= 1) || Number(cashout.amount) > gameUsd} onClick={withdraw}>{`Withdraw ${money(Number(cashout.amount) || 0)}`}</button>
              <span className="foot">Minimum $1.00, up to {usd(gameUsd)}. USDC lands in the wallet you signed in with.</span>
            </div>
          )}
          {(cashout.step === "sending" || cashout.step === "pending") && <div className="status" role="status" aria-live="polite" data-wt="withdrawing">{cashout.text}<div className="progress" aria-hidden="true"></div></div>}
          {cashout.step === "sent" && <p className="status ok" role="status" aria-live="polite" data-wt="withdrawn">{cashout.text}</p>}
          {(cashout.step === "refunded" || cashout.step === "refused") && <p className="status err" role="alert">{cashout.text}</p>}
          {confirming && <div className="status" role="status" aria-live="polite" data-wt="confirming">Confirming your payment… {usd(pendingUsd)}<div className="progress" aria-hidden="true"></div></div>}
          {checking.text && <p className="status" role="status">{checking.text}</p>}
          {funding.step === "done" && <p className="status ok" role="status" aria-live="polite" data-wt="funded">{funding.text}</p>}
          {funding.step === "refused" && <p className="status err" role="alert" data-wt="refused">{funding.text}</p>}
          <p className="foot">{mode === "pollar" ? "Pollar pays the network fee. Your balance updates in about 20 seconds." : "Play money for this server only."}</p>
        </section>

        <div className="stack">
          <section className="panel blue live" aria-labelledby="liveh">
            {live ? (
              <>
                <span className="tag">Turn {live.turn}</span>
                <div className="eyebrow"><i aria-hidden="true"></i>Live room</div>
                <h2 id="liveh">{live.callsign} is playing</h2>
                <div className="facts">
                  <div>Fuse left<b className="red">{live.fuse}</b></div>
                  <div>Tiles cleared<b>{live.cleared} of {live.tiles}</b></div>
                  <div>Seats open<b>{live.seatsOpen}</b></div>
                </div>
                <div className="pair">
                  <a className="btn yellow" href={`/side/${encodeURIComponent(live.runId)}`}>Set traps</a>
                  <a className="btn blue" href={`/side/${encodeURIComponent(live.runId)}`}>Back Byte</a>
                </div>
              </>
            ) : (
              <>
                <div className="eyebrow"><i aria-hidden="true"></i>Live room</div>
                <h2 id="liveh">No room is live right now</h2>
                <p className="empty">A room opens when a Byte agent starts a run, or start one yourself from the lobby.</p>
                <a className="btn yellow" href="/play">See rooms</a>
              </>
            )}
          </section>
          <section className="panel" aria-labelledby="acth">
            <h2 id="acth" className="rule">Your activity</h2>
            {rows.length
              ? <ul className="rows">{rows.map((r) => <li key={r.id}><span>{r.text}</span><span className={`amt${r.neg ? " neg" : ""}`}>{r.amount ?? ""}</span><time>{r.at}</time></li>)}</ul>
              : <p className="empty">{mode === "pollar" && id.txHistory.step === "loading" ? "Loading…" : "No activity yet. Your top-ups and payouts will show here."}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
