import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the game server at /stake/ (apps/server/src/main.ts reads apps/stake/dist).
export default defineConfig({
  plugins: [react()],
  base: "/stake/",
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { main: "index.html", side: "side.html" } } },
  server: { proxy: { "/api": "http://localhost:8787", "/runs": "http://localhost:8787", "/dev": "http://localhost:8787" } },
});
