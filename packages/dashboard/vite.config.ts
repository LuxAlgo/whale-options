import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, proxy API/WS to a running `whale run` engine (default port 8787).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // The chart tab's chunk (Vela + the chart module) is loaded on demand and
    // sits well above Vite's default 500 kB advisory; the main bundle stays
    // where it was. Raise the advisory rather than silence real regressions.
    chunkSizeWarningLimit: 900,
  },
});
