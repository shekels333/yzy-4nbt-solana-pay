import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, shopifyAuthMode } from "./config.js";
import { intentsRouter } from "./routes/intents.js";
import { startPoller } from "./poller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.disable("x-powered-by");
// Railway (and most PaaS) terminate TLS and set X-Forwarded-For — needed for IP rate limits.
app.set("trust proxy", 1);

/** Send browsers off *.up.railway.app onto PUBLIC_BASE_URL (your pay domain). */
app.use((req, res, next) => {
  try {
    const publicHost = new URL(config.publicBaseUrl).hostname.toLowerCase();
    const host = (req.hostname || "").toLowerCase();
    if (
      publicHost &&
      host &&
      host !== publicHost &&
      host.endsWith(".railway.app") &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      const pathOnly = req.path || "/";
      // Keep health + API on the Railway host for probes / same-origin tooling.
      if (pathOnly === "/health" || pathOnly.startsWith("/intents")) {
        next();
        return;
      }
      const target =
        config.publicBaseUrl.replace(/\/$/, "") + (req.originalUrl || pathOnly);
      res.redirect(301, target);
      return;
    }
  } catch {
    // fall through
  }
  next();
});

/** Storefront + local origins that may POST /intents from a theme button. */
const CORS_ORIGINS = new Set([
  ...config.corsOrigins,
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    shopify: shopifyAuthMode(),
    mint: config.yzyMint.toBase58(),
    merchant: config.merchantWallet.toBase58(),
    quoteRefreshMs: config.quoteRefreshMs,
    slippageBps: config.slippageBps,
  });
});

app.use("/intents", intentsRouter);

app.listen(config.port, config.host, () => {
  console.info(
    `[4nbt-solana-pay] listening on ${config.host}:${config.port} (public ${config.publicBaseUrl})`,
  );
  const mode = shopifyAuthMode();
  const shopifyLabel =
    mode === "token"
      ? "static SHOPIFY_ACCESS_TOKEN"
      : mode === "client_credentials"
        ? "Dev Dashboard client_credentials"
        : "STUB (set SHOPIFY_CLIENT_ID+SECRET or SHOPIFY_ACCESS_TOKEN)";
  console.info(`[4nbt-solana-pay] Shopify Admin: ${shopifyLabel}`);
  console.info(
    `[4nbt-solana-pay] merchant=${config.merchantWallet.toBase58()} mint=${config.yzyMint.toBase58()}`,
  );
  console.info(
    `[4nbt-solana-pay] db=${config.dbPath} · live quote every ${config.quoteRefreshMs}ms · slippage ±${config.slippageBps} bps`,
  );
  startPoller();
});
