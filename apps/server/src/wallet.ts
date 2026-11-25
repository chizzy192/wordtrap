// Byte's spending wallet. Production: a Swig smart wallet whose role is limited to
// "transfer USDC to the oracle's payTo, max $X/day" — the agent key can't drain anything else.
// Sim: a local ledger that just counts spend.
export interface PaymentRequirement {
  scheme: "exact"; network: string; maxAmountRequired: string; // atomic USDC units
  resource: string; description: string; payTo: string; asset: string; maxTimeoutSeconds: number;
}

export interface AgentWallet {
  readonly address: string;
  /** Build + sign a payment satisfying `req`; returns the base64 X-PAYMENT header value. */
  pay(req: PaymentRequirement): Promise<{ header: string; txSig: string }>;
  spentUsd(): number;
}

export class SimWallet implements AgentWallet {
  readonly address = "byte-sim-wallet";
  private spent = 0;
  private n = 0;
  private readonly dailyCapUsd: number;
  constructor(dailyCapUsd = 1) { this.dailyCapUsd = dailyCapUsd; }
  async pay(req: PaymentRequirement) {
    const usd = Number(req.maxAmountRequired) / 1e6;
    if (this.spent + usd > this.dailyCapUsd) throw new Error("Swig role spend limit reached");
    this.spent += usd;
    const txSig = `sim-x402-${++this.n}`;
    const payload = { x402Version: 1, scheme: req.scheme, network: req.network, payload: { txSig, from: this.address, amount: req.maxAmountRequired } };
    return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), txSig };
  }
  spentUsd() { return this.spent; }
}

/*
 * SwigWallet (day-1 integration task — the SDK isn't installed yet, verify API against docs):
 *   npm i @swig-wallet/classic @solana/web3.js
 *   - fetchSwig(connection, swigAccountAddress) / getSwigWalletAddress(swig)
 *   - Create the Swig once with two roles: OWNER (team key) and AGENT (Byte's ed25519 key)
 *     with a token spend-limit action on USDC, so Byte can only pay oracle fees.
 *   - pay(): build an SPL USDC transfer to req.payTo for req.maxAmountRequired, sign via the
 *     AGENT role, serialize into the x402 "exact" Solana payload, return as header.
 */
