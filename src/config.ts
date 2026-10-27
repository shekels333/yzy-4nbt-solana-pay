import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

loadEnv();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const merchantStr = required("MERCHANT_WALLET");
const mintStr = required(
  "YZY_MINT",
  "4NBTf8PfLH4oLFnwf3knv46FY9i5oXjDxffCetXRpump",
);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, "data");

const shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim() || "";
const shopifyClientId = process.env.SHOPIFY_CLIENT_ID?.trim() || "";
const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim() || "";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** Bind address — 0.0.0.0 so Railway/Render/Docker can reach the process. */
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(
    /\/$/,
    "",
  ),
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  merchantWallet: new PublicKey(merchantStr),
  yzyMint: new PublicKey(mintStr),
  yzyDecimals: Number(process.env.YZY_DECIMALS ?? 6),
  defaultAmountYzy: Number(process.env.DEFAULT_AMOUNT_YZY ?? 1),
  label: process.env.LABEL ?? "YzY Store",
  message: process.env.MESSAGE ?? "Pay with YzY",
  shopifyShop: process.env.SHOPIFY_SHOP?.trim() || "",
  shopifyAccessToken,
  shopifyClientId,
  shopifyClientSecret,
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2024-10",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 4000),
  /** How often pending USD intents re-quote DexScreener (default 3s). */
  quoteRefreshMs: Number(process.env.QUOTE_REFRESH_MS ?? 3000),
  /**
   * Accept transfers within ± this many basis points of expected amount_yzy.
   * 100 = ±1%. Underpay uses a lowered validateTransfer floor; overpay is always OK.
   */
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 100),
  intentTtlMs: Number(process.env.INTENT_TTL_MS ?? 1_200_000),
  /** Max line quantity on public POST /intents (default 20). */
  maxQuantity: Number(process.env.MAX_QUANTITY ?? 20),
  /** Max catalog USD total (unit*qty) on public checkout (default 500). */
  maxUsdTotal: Number(process.env.MAX_USD_TOTAL ?? 500),
  /**
   * Optional shared secret for admin-only paths (e.g. draftOrderId linking).
   * Send header X-Intent-Admin-Secret. Empty = admin link path disabled.
   */
  intentAdminSecret: process.env.INTENT_ADMIN_SECRET?.trim() || "",
  /** POST /intents per-IP rate limit (default 15 / 60s). */
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 15),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  /** Soft cap on concurrent pending intents (global). */
  maxPendingIntents: Number(process.env.MAX_PENDING_INTENTS ?? 100),
  /** Soft cap on pending intents per email. */
  maxPendingPerEmail: Number(process.env.MAX_PENDING_PER_EMAIL ?? 5),
  /**
   * DexScreener pair min USD liquidity. 0 = disabled (pick highest-liq pair only).
   * YzY/4NBT checkout only needs the best listed pair; floor optional.
   */
  minPairLiquidityUsd: Number(process.env.MIN_PAIR_LIQUIDITY_USD ?? 0),
  /**
   * Reject spot if it moves more than this many bps vs median of recent accepted
   * prices (default 500 = 5%). Empty history on boot accepts once and seeds.
   */
  maxPriceDeviationBps: Number(process.env.MAX_PRICE_DEVIATION_BPS ?? 500),
  /** How many accepted mid prices to keep for median/TWAP (default 5). */
  priceHistorySize: Number(process.env.PRICE_HISTORY_SIZE ?? 5),
  /** Drop history samples older than this (default 120s). */
  priceHistoryMs: Number(process.env.PRICE_HISTORY_MS ?? 120_000),
  /**
   * Extra browser origins allowed to POST /intents (comma-separated).
   * Always includes localhost:8787/3000. Example: https://yourshop.com,https://yourshop.myshopify.com
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Directory for SQLite (Railway volume: mount at /data, set DATA_DIR=/data). */
  dataDir,
  dbPath: process.env.DB_PATH ?? path.join(dataDir, "intents.db"),
};

/** True when a static Admin token OR Dev Dashboard client credentials are configured. */
export const shopifyEnabled = Boolean(
  shopifyAccessToken || (shopifyClientId && shopifyClientSecret),
);

/** How Shopify Admin auth is configured (for /health). */
export type ShopifyAuthMode = "token" | "client_credentials" | "stub";

export function shopifyAuthMode(): ShopifyAuthMode {
  if (shopifyAccessToken) return "token";
  if (shopifyClientId && shopifyClientSecret) return "client_credentials";
  return "stub";
}
