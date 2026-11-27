// A stand-in for usePollar() used only by the browser test (scripts/browser-stake.mjs). It exists in a build only when
// VITE_WT_MOCK_POLLAR=1 was set at build time, and takes over only when the test has put window.__wtPollarMock in place
// before the page scripts run. It talks to the mock chain served by scripts/stake-mock-server.ts, which also backs the
// game server's Solana RPC in that run, so a payment "sent" here becomes a finalized transfer there a few seconds later.
// A normal build (no flag) never includes this file.
import { useCallback, useMemo, useState } from "react";

export interface MockPollarConfig { token: string; address: string; chain: string; cancelNext?: boolean; sends?: number }
export const mockPollarConfig = (): MockPollarConfig | null => (typeof window !== "undefined" ? ((window as any).__wtPollarMock as MockPollarConfig | undefined) ?? null : null);

const SIGNED_IN = { signedIn: true } as const;

export function useMockPollar(): any {
  const cfg = mockPollarConfig()!;
  const [walletBalance, setWalletBalance] = useState<any>({ step: "idle" });
  const [txHistory, setTxHistory] = useState<any>({ step: "idle" });
  // the SDK keeps its access token in localStorage under pollar:<apiKeyHash>:session; the page reads it from there
  useMemo(() => { try { localStorage.setItem("pollar:mock:session", JSON.stringify({ token: { accessToken: cfg.token, expiresAt: Date.now() + 3_600_000 } })); } catch { /* private */ } }, [cfg.token]);
  const refreshWalletBalance = useCallback(async () => {
    setWalletBalance((s: any) => (s.step === "loaded" ? s : { step: "loading" }));
    const r = await fetch(`${cfg.chain}/wallet?address=${encodeURIComponent(cfg.address)}`).then((x) => x.json());
    setWalletBalance({ step: "loaded", data: { publicKey: cfg.address, network: "testnet", exists: true, balances: [{ chain: "SOLANA", code: "USDC", decimals: 6, balance: String(r.usdcMicro), available: String(r.usdcMicro) }] } });
  }, [cfg.chain, cfg.address]);
  const fetchTxHistory = useCallback(async () => {
    const r = await fetch(`${cfg.chain}/history?address=${encodeURIComponent(cfg.address)}`).then((x) => x.json());
    setTxHistory({ step: "loaded", params: { limit: 20, offset: 0 }, data: { records: r.records } });
  }, [cfg.chain, cfg.address]);
  const sendPayment = useCallback(async (p: { destination: string; amount: string; mint?: string }) => {
    const live = mockPollarConfig() ?? cfg;
    live.sends = (live.sends ?? 0) + 1;
    if (live.cancelNext) { live.cancelNext = false; return { status: "error", code: "SDK_CONFIRMATION_DECLINED", details: "the user declined the transaction" }; }
    const r = await fetch(`${cfg.chain}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: cfg.address, to: p.destination, micro: p.amount }) }).then((x) => x.json());
    if (r.error) return { status: "error", details: r.error };
    return { status: "success", hash: r.signature };
  }, [cfg]);
  const client = useMemo(() => ({ apiKeyHash: "mock", fetchTxHistory }), [fetchTxHistory]);
  const noop = () => {};
  return { ...SIGNED_IN, isAuthenticated: true, verified: true, wallets: [{ chain: "SOLANA", address: cfg.address }], wallet: { address: cfg.address, chain: "SOLANA" },
    walletBalance, refreshWalletBalance, txHistory, sendPayment, getClient: () => client,
    login: noop, logout: noop, openLoginModal: noop, openWalletBalanceModal: noop, openSendModal: noop, openTxHistoryModal: noop };
}
