// Player profiles. A player is identified by their wallet address (Pollar wallet after Google
// sign-in, or a connected Wallet Standard wallet) or, in demo mode, by a guest id the browser
// made once ("guest-" + 8 random characters). The display name is set once and shown on seats,
// mines, payouts and the log; with no name the page shows the short address (first 4, …, last 4).
// The store is an interface so it can move from memory to a database without touching routes.

export interface Profile { address: string; name: string | null; createdAt: number; updatedAt: number }

export interface ProfileStore {
  get(address: string): Promise<Profile | null>;
  put(address: string, name: string | null): Promise<Profile>;
  /** Display names for a set of addresses (missing ones are omitted). */
  names(addresses: Iterable<string>): Promise<Record<string, string>>;
}

export const NAME_RULE = "Names are 2 to 16 characters: letters, numbers, spaces and underscores.";
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9 _]{0,15}$/;

/** Trim and validate a display name; returns the clean name or an error message. */
export function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 16 || !NAME_RE.test(name)) return { ok: false, error: NAME_RULE };
  return { ok: true, name };
}

export function isAddressLike(id: string): boolean { return /^(guest-[A-Za-z0-9]{8}|[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/.test(id); }

/** Short form shown when a player has no name: `A9Do…Ej3i`. Short ids (sim viewers) are shown as they are. */
export function shortAddress(id: string): string { return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`; }

export class MemoryProfileStore implements ProfileStore {
  private readonly m = new Map<string, Profile>();
  async get(address: string) { return this.m.get(address) ?? null; }
  async put(address: string, name: string | null) {
    const now = Date.now();
    const p: Profile = { address, name, createdAt: this.m.get(address)?.createdAt ?? now, updatedAt: now };
    this.m.set(address, p);
    return p;
  }
  async names(addresses: Iterable<string>) {
    const out: Record<string, string> = {};
    for (const a of addresses) { const p = this.m.get(a); if (p?.name) out[a] = p.name; }
    return out;
  }
}
