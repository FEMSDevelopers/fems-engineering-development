import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createLogger, defineConfig } from "vite";

// In development the API runs on :8080 (`npm run dev` at the repo root starts DB, API and web).
// 127.0.0.1 rather than "localhost": on Windows, localhost can resolve to ::1 first.
// Vite logs a full stack trace for every proxied request while the API is down; the proxy handler below already
// prints one short line, so drop those duplicates (other errors are still shown).
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, opts) => {
  if (msg.includes("http proxy error") && /ECONNREFUSED|ECONNRESET/.test(msg)) return;
  logError(msg, opts);
};

export default defineConfig(({ command }) => ({
  customLogger: logger,
  plugins: [react()],
  resolve:
    command === "serve"
      ? // Edit packages/core/src and see it live in the browser without a rebuild.
        { alias: { "@fpl/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) } }
      : undefined,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_URL ?? "http://127.0.0.1:8080",
        // While the API is (re)starting — e.g. tsx reloads it after a server edit — answer 503 with a short
        // message instead of a stack trace per request; the UI retries these automatically.
        configure: (proxy) => {
          let last = 0;
          proxy.on("error", (err, _req, res) => {
            const now = Date.now();
            if (now - last > 5000) console.log(`[proxy] API not reachable yet (${(err as NodeJS.ErrnoException).code ?? err.message}); retrying…`);
            last = now;
            const r = res as import("node:http").ServerResponse;
            if (r && !r.headersSent && typeof r.writeHead === "function") {
              r.writeHead(503, { "content-type": "application/json" });
              r.end(JSON.stringify({ error: "The API is starting — try again in a moment." }));
            }
          });
        },
      },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1000 },
}));
