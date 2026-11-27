// Entry: with VITE_POLLAR_PUBLISHABLE_KEY set, the page runs inside PollarProvider (Google sign-in, Pollar wallets,
// USDC top-ups). Without it, "demo credits" mode: a guest id or a Wallet Standard address identifies you and
// POST /dev/credit funds the balance.
import "@pollar/react/styles.css";   // Pollar's own stylesheet first (modals, wallet menus); ours themes it after
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./stake.css";

const KEY = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY as string | undefined;
const BASE_URL = (import.meta.env.VITE_POLLAR_BASE_URL as string | undefined) ?? "https://sdk.api.pollar.xyz";

async function mount() {
  const root = createRoot(document.getElementById("root")!);
  // Browser-test builds only (VITE_WT_MOCK_POLLAR=1): with window.__wtPollarMock in place the page runs in Pollar mode
  // over a mocked usePollar() (apps/stake/src/mockPollar.ts) and never loads the SDK. A normal build has no such path.
  if (import.meta.env.VITE_WT_MOCK_POLLAR === "1" && (window as any).__wtPollarMock) {
    root.render(<StrictMode><App mode="pollar" /></StrictMode>);
    return;
  }
  if (!KEY) {
    root.render(<StrictMode><App mode="demo" /></StrictMode>);
    return;
  }
  // Loaded lazily so a demo-mode build never evaluates the SDK.
  const { PollarProvider } = await import("@pollar/react");
  let walletAdapters: unknown[] = [];
  try {
    const { solanaWalletStandardAdapters } = await import("@pollar/solana-wallet-standard-adapter");
    walletAdapters = (solanaWalletStandardAdapters as any)();
  } catch { /* external wallets are optional */ }
  const Provider = PollarProvider as any;
  root.render(
    <StrictMode>
      <Provider client={{ apiKey: KEY, baseUrl: BASE_URL, walletAdapters }}>
        <App mode="pollar" />
      </Provider>
    </StrictMode>,
  );
}
mount();
