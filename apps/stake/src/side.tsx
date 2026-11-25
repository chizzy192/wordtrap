// Entry for /side/<runId>: "Pick a side". Shares the Pollar sign-in and balance logic with the stake page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Side } from "./SidePage";
import "./side.css";

const KEY = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY as string | undefined;
const BASE_URL = (import.meta.env.VITE_POLLAR_BASE_URL as string | undefined) ?? "https://sdk.api.pollar.xyz";

async function mount() {
  const root = createRoot(document.getElementById("root")!);
  if (!KEY) { root.render(<StrictMode><Side mode="demo" /></StrictMode>); return; }
  const { PollarProvider } = await import("@pollar/react");
  let walletAdapters: unknown[] = [];
  try { const { solanaWalletStandardAdapters } = await import("@pollar/solana-wallet-standard-adapter"); walletAdapters = (solanaWalletStandardAdapters as any)(); } catch { /* optional */ }
  const Provider = PollarProvider as any;
  root.render(<StrictMode><Provider client={{ apiKey: KEY, baseUrl: BASE_URL, walletAdapters }}><Side mode="pollar" /></Provider></StrictMode>);
}
mount();
