// Entry: with VITE_POLLAR_PUBLISHABLE_KEY set, the page runs inside PollarProvider (Google sign-in,
// Pollar wallets, card/ramp top-ups). Without it, "demo credits" mode: a plain user name or a
// Wallet Standard wallet address identifies you and POST /dev/credit funds the balance.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const KEY = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY as string | undefined;
const BASE_URL = (import.meta.env.VITE_POLLAR_BASE_URL as string | undefined) ?? "https://sdk.api.pollar.xyz";

async function mount() {
  const root = createRoot(document.getElementById("root")!);
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
