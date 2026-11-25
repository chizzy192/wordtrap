// Semantic Risk Oracle, sold per request over x402. It never sees trap contents (nobody does);
// it scores how "mine-able" a word is from public signals:
//   - how obvious the word is for the current prompt (crowds mine the obvious)
//   - whether the word has already detonated or been revealed this match
//   - crowd heat: how much stake was armed this window
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaymentRequirement } from "./wallet.ts";
import type { Tile } from "./content.ts";

export const PRICE_ATOMIC = "1000"; // $0.001 USDC per call
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface RiskContext { tile: Tile; firedWords: Set<string>; armedStakeThisWindow: number; armedCountThisWindow: number }

export function scoreWords(words: string[], ctx: RiskContext): Record<string, number> {
  const heat = Math.min(1, ctx.armedCountThisWindow / 6) * 0.25;
  const out: Record<string, number> = {};
  for (const w of words) {
    const rank = ctx.tile.obvious.indexOf(w);
    let s = rank >= 0 ? 0.85 - rank * 0.07 : 0.12;
    if (ctx.firedWords.has(w)) s += 0.3;      // copycats re-mine known hits
    if (w.length <= 4) s += 0.05;               // short words get spoken a lot
    out[w] = Math.round(Math.min(0.99, s + heat) * 100) / 100;
  }
  return out;
}

export interface PaymentVerifier { verify(header: string, req: PaymentRequirement): Promise<{ ok: boolean; txSig?: string; reason?: string }> }

/** Sim: trust the header shape. */
export const simVerifier: PaymentVerifier = {
  async verify(header, req) {
    try {
      const p = JSON.parse(Buffer.from(header, "base64").toString());
      const ok = p.x402Version === 1 && p.payload?.amount === req.maxAmountRequired;
      return { ok, txSig: p.payload?.txSig, reason: ok ? undefined : "bad payload" };
    } catch { return { ok: false, reason: "unparseable" }; }
  },
};

/** Production: hand verification + settlement to an x402 facilitator (e.g. PayAI on Solana). */
export function facilitatorVerifier(baseUrl: string): PaymentVerifier {
  return {
    async verify(header, req) {
      const paymentPayload = JSON.parse(Buffer.from(header, "base64").toString());
      const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: req });
      const v = await fetch(`${baseUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
      if (!v.isValid) return { ok: false, reason: v.invalidReason };
      const s = await fetch(`${baseUrl}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
      return { ok: !!s.success, txSig: s.transaction, reason: s.errorReason };
    },
  };
}

export function requirement(resource: string, payTo: string, network: string): PaymentRequirement {
  return { scheme: "exact", network, maxAmountRequired: PRICE_ATOMIC, resource, description: "WordTrap semantic risk score", payTo, asset: DEVNET_USDC, maxTimeoutSeconds: 60 };
}

/** HTTP handler: POST /oracle/risk {words: string[]} — 402 until paid. */
export async function handleRisk(req: IncomingMessage, res: ServerResponse, body: string, deps: {
  verifier: PaymentVerifier; requirement: PaymentRequirement; ctx: () => RiskContext;
}) {
  const header = req.headers["x-payment"];
  if (typeof header !== "string") {
    res.writeHead(402, { "content-type": "application/json" });
    return res.end(JSON.stringify({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [deps.requirement] }));
  }
  const v = await deps.verifier.verify(header, deps.requirement);
  if (!v.ok) {
    res.writeHead(402, { "content-type": "application/json" });
    return res.end(JSON.stringify({ x402Version: 1, error: v.reason, accepts: [deps.requirement] }));
  }
  const { words } = JSON.parse(body || "{}");
  const scores = scoreWords((words ?? []).slice(0, 20), deps.ctx());
  res.writeHead(200, { "content-type": "application/json", "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: v.txSig })).toString("base64") });
  res.end(JSON.stringify({ scores }));
}

/** Client side used by Byte: call, get 402, pay with its wallet, retry. */
export async function buyRisk(url: string, words: string[], wallet: { pay(r: PaymentRequirement): Promise<{ header: string; txSig: string }> }) {
  const body = JSON.stringify({ words });
  const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (first.status !== 402) return { scores: (await first.json()).scores as Record<string, number>, txSig: "free" };
  const { accepts } = await first.json();
  const { header, txSig } = await wallet.pay(accepts[0]);
  const paid = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-payment": header }, body });
  if (!paid.ok) throw new Error(`oracle refused payment: ${await paid.text()}`);
  return { scores: (await paid.json()).scores as Record<string, number>, txSig };
}
