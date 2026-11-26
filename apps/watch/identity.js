// Player identity for the plain pages (watch, lobby). Served at /identity.js.
// The identity is a wallet address (Pollar wallet after Google sign-in, or a connected Wallet
// Standard wallet) or, in demo mode, a guest id made once and kept in localStorage.
// Shown as the display name, or the short address (first 4, …, last 4). The full address only in tooltips.
const KEY_ID = "wt.identity", KEY_MODE = "wt.identity.mode", KEY_NAME = "wt.profile.name", KEY_CHOICE = "wt.identity.choice";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};
export const short = (id) => (!id ? "" : id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);
export const NAME_RULE = "Names are 2 to 16 characters: letters, numbers, spaces and underscores.";
export const validName = (raw) => { const n = String(raw ?? "").trim().replace(/\s+/g, " "); return n.length >= 2 && n.length <= 16 && /^[A-Za-z0-9_][A-Za-z0-9 _]{0,15}$/.test(n) ? n : null; };

/** Copy text for the player: the clipboard API, else a hidden textarea + execCommand("copy"). Returns whether it worked. */
export async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}
/** The link that opens a room from the lobby: https://<host>/play?room=<code>. */
export const roomLink = (code) => `${location.origin}/play?room=${encodeURIComponent(code)}`;

/** What a player may read. Known raw server strings become sentences, sentences written for players pass through,
 *  anything else (protocol hints, stack-like text, codes) becomes the fallback. Never show a server body directly. */
export function friendly(raw, fallback = "That didn't work. Try again.") {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  if (/bearer|authorization|demo-credit|send \{user\}|sign in with (pollar|google)/i.test(s)) return "Sign in to play.";
  if (/insufficient balance/i.test(s)) return "Not enough funds. Add funds to play.";
  if (/dev credits only/i.test(s)) return "Test funds aren't available on this server. Sign in with Google to add funds.";
  if (/^[A-Z][^{}<>`]*[.!?]$/.test(s) && !/:\s*\S*(error|undefined|null)/i.test(s)) return s;
  return fallback;
}

function randomId() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "guest-" + [...b].map((x) => a[x % a.length]).join("");
}

export const identity = {
  /** Current id or null when the viewer has not chosen yet. */
  get id() { return store.get(KEY_ID); },
  get mode() { return store.get(KEY_MODE) || (this.id ? "guest" : null); },
  get name() { return store.get(KEY_NAME); },
  get chosen() { return !!store.get(KEY_CHOICE); },
  /** Mode "guest": make the guest id once. Mode "wallet": the address came from the Pollar / wallet flow. */
  choose(mode, address) {
    if (mode === "guest") { if (!this.id || this.mode !== "guest") store.set(KEY_ID, randomId()); store.set(KEY_MODE, "guest"); }
    else { store.set(KEY_ID, address); store.set(KEY_MODE, "wallet"); }
    store.set(KEY_CHOICE, "1");
    return this.id;
  },
  signOut() { store.set(KEY_ID, null); store.set(KEY_MODE, null); store.set(KEY_NAME, null); store.set(KEY_CHOICE, null); },
  /** What to show for this player: display name, else short address. */
  label(id, players = {}) { if (!id) return ""; if (id === this.id && this.name) return this.name; return players[id] || short(id); },
  /** Headers for the server: demo identity rides in x-user (the Pollar session token replaces it in wallet mode). */
  headers() { const h = { "content-type": "application/json" }; if (this.id) h["x-user"] = this.id; const t = store.get("wt.session.token"); if (t) h.authorization = `Bearer ${t}`; return h; },
  async fetchProfile() {
    if (!this.id) return null;
    const r = await fetch("/api/v1/profile", { headers: this.headers() });
    if (!r.ok) return null;
    const p = await r.json();
    store.set(KEY_NAME, p.name);
    return p;
  },
  async saveName(name) {
    const r = await fetch("/api/v1/profile", { method: "PUT", headers: this.headers(), body: JSON.stringify({ name }) });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(friendly(p.error, NAME_RULE));
    store.set(KEY_NAME, p.name);
    return p;
  },
  async balance() {
    if (!this.id) return null;
    const r = await fetch("/api/v1/fiat/balance", { headers: this.headers() });
    return r.ok ? r.json() : null;
  },
  /** Guest starting funds, credited exactly once per guest id (the payment id makes it idempotent). */
  async fundGuestOnce(amount) {
    if (this.mode !== "guest" || !(amount > 0)) return null;
    const r = await fetch("/dev/credit", { method: "POST", headers: this.headers(), body: JSON.stringify({ amount, paymentId: `guest-start-${this.id}` }) });
    return r.ok ? r.json() : null;
  },
  async addTestFunds(amount = 10) {
    const r = await fetch("/dev/credit", { method: "POST", headers: this.headers(), body: JSON.stringify({ amount }) });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(friendly(p.error, "Could not add funds."));
    return p;
  },
};
