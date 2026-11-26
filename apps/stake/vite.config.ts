import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Served by the game server at /stake/ (apps/server/src/main.ts reads apps/stake/dist).
export default defineConfig(({ mode }) => {
  // Build-time Pollar setting. Only whether it is set is recorded (as a <meta> the server's /healthz reads); never its value.
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const pollar = env.VITE_POLLAR_PUBLISHABLE_KEY ? "configured" : "missing";
  return {
    plugins: [
      react(),
      { name: "wt-pollar-marker", transformIndexHtml: (html: string) => html.replace("</head>", `<meta name="wt-pollar" content="${pollar}">\n</head>`) },
    ],
    base: "/stake/",
    build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { main: "index.html", side: "side.html" } } },
    server: { proxy: { "/api": "http://localhost:8787", "/runs": "http://localhost:8787", "/dev": "http://localhost:8787" } },
  };
});
