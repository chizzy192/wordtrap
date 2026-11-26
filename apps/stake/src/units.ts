// Token amounts from Pollar are integer base units (USDC: 6 decimals). Everything shown to a player goes through here.
// No floats on the way: the string is split, never multiplied.

/** "5000000" with 6 decimals -> "5" ; "250000" -> "0.25". Accepts a number or string of base units. */
export function fromBase(base: string | number | bigint, decimals = 6): string {
  const s = String(base ?? "").trim().replace(/^\+/, "");
  if (!/^-?\d+$/.test(s)) return "0";
  const neg = s.startsWith("-"); const digits = s.replace("-", "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const frac = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
/** Base units as a dollar string with two decimals: 5000000 -> "$5.00", 250000 -> "$0.25", 123456 -> "$0.12". */
export function fmtUsd(base: string | number | bigint, decimals = 6): string {
  const dec = fromBase(base, decimals);
  const neg = dec.startsWith("-"); const [w, f = ""] = dec.replace("-", "").split(".");
  return `${neg ? "-" : ""}$${w}.${(f + "00").slice(0, 2)}`;
}
/** Base units as a plain number of tokens (for comparisons in the page, never for money math on the server). */
export function toTokens(base: string | number | bigint, decimals = 6): number { return Number(fromBase(base, decimals)); }
/** A dollar amount typed by the player ("5", "0.25") as integer base units, exactly: "0.25" -> 250000. */
export function toBase(amount: string | number, decimals = 6): number | null {
  const s = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return Number(w + f.padEnd(decimals, "0"));
}
/** What a player's dollars look like as the units Pollar shows: "$5.00" -> 5000000. */
export const unitsOf = (amount: string | number, decimals = 6) => toBase(amount, decimals) ?? 0;
