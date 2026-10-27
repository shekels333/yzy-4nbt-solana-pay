# Deploy 4nbt-solana-pay (HTTPS)

Long-running Node service for Solana Pay (YzY) + Shopify draft completion.
Prefer **Railway** with the included `Dockerfile`. Render works the same way.

## Start command

```bash
npm start
# → tsx src/index.ts
```

Binds `0.0.0.0:$PORT` (default port `8787`). Health: `GET /health`.

## Required / recommended env vars

| Variable | Required | Notes |
|----------|----------|--------|
| `PORT` | platform | Railway/Render set this automatically |
| `PUBLIC_BASE_URL` | **yes (after domain)** | Public HTTPS origin, no trailing slash. e.g. `https://4nbt-pay.up.railway.app` — set once the service URL is known |
| `SOLANA_RPC_URL` | recommended | Default: `https://api.mainnet-beta.solana.com`. Prefer a dedicated mainnet RPC in production |
| `MERCHANT_WALLET` | **yes** | `YOUR_MERCHANT_WALLET` |
| `YZY_MINT` | **yes** | `4NBTf8PfLH4oLFnwf3knv46FY9i5oXjDxffCetXRpump` |
| `YZY_DECIMALS` | yes | `6` |
| `DEFAULT_AMOUNT_YZY` | yes | Fallback when intent omits amounts; e.g. `2948.402949` |
| `PRODUCT_USD` | optional | Docs/scripts reference only (e.g. `6`) |
| `LABEL` | yes | `Your Store` |
| `MESSAGE` | yes | `Pay with YzY` |
| `SHOPIFY_SHOP` | yes | `yourshop.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | optional* | Dev Dashboard app client id (preferred). Pair with `SHOPIFY_CLIENT_SECRET` |
| `SHOPIFY_CLIENT_SECRET` | optional* | Dev Dashboard app client secret. Service exchanges for ~24h tokens via `grant_type=client_credentials` |
| `SHOPIFY_ACCESS_TOKEN` | optional* | Legacy static Admin API token. If set, used instead of client credentials |
| `SHOPIFY_API_VERSION` | yes | `2024-10` |
| `POLL_INTERVAL_MS` | yes | `4000` |
| `INTENT_TTL_MS` | yes | `1200000` (20 min) |
| `QUOTE_REFRESH_MS` | yes | `3000` |
| `SLIPPAGE_BPS` | yes | `100` (±1%). Also bounds the no-reference unique-amount fallback |
| `MIN_PAIR_LIQUIDITY_USD` | optional | Default `0` (disabled). Set >0 to reject pairs below that USD liquidity |
| `MAX_PRICE_DEVIATION_BPS` | optional | Default `500` (5%). Circuit-break vs median of recent accepted mids |
| `PRICE_HISTORY_SIZE` | optional | Default `5` accepted samples for median/TWAP |
| `PRICE_HISTORY_MS` | optional | Default `120000` (2 min) history window |
| `DATA_DIR` | recommended | Directory for SQLite. Default `./data`. On Railway set `DATA_DIR=/data` |
| `DB_PATH` | optional | Overrides full path to `intents.db` |
| `HOST` | optional | Default `0.0.0.0` |

**Never commit secrets.** Set `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (or legacy `SHOPIFY_ACCESS_TOKEN`) and any RPC API keys only in the platform dashboard.

* Shopify Admin auto draft create/complete needs **either** client id+secret **or** a static access token. App scopes: `write_draft_orders`, `read_draft_orders`, `read_products`. `draftOrderComplete` requires `write_draft_orders` only (not `write_orders`). `/health` reports `shopify` as `client_credentials`, `token`, or `stub`.

## SQLite persistence (Railway volume)

1. Create a Railway **Volume**.
2. Mount path: **`/data`**
3. Set env: `DATA_DIR=/data`
4. DB file lands at `/data/intents.db` (WAL siblings: `intents.db-wal`, `intents.db-shm`)

### Volume blockers / caveats

- A volume must be attached **before** first production traffic, or intents.db is ephemeral and wiped on redeploy.
- Railway volumes are **single-instance**: do not scale this service to multiple replicas while using local SQLite.
- Free/trial plans sometimes restrict volumes — if the volume UI is missing, upgrade or use Render disk / external Postgres later.
- Do not point `DATA_DIR` at the container image path under `/app/data` if you need persistence across deploys.

## Railway (Dockerfile)

1. New project → Deploy from GitHub (or `railway up` from this folder).
2. Settings → Build: **Dockerfile** (auto-detected).
3. Add volume mount `/data`, set env vars above (especially `MERCHANT_WALLET`, `PUBLIC_BASE_URL` after first deploy URL is known).
4. Generate domain → set `PUBLIC_BASE_URL=https://<your-domain>` and redeploy.
5. Confirm: `curl https://<domain>/health`

TLS terminates at Railway; the process speaks HTTP on `$PORT`.

## Render (alternative)

1. New **Web Service**, Docker runtime, this repo.
2. Disk: mount path `/data`, set `DATA_DIR=/data`.
3. Same env vars; start command overridden by `CMD` in Dockerfile (`npm start`).

## Nixpacks fallback

If Docker is disabled, `Procfile` + `nixpacks.toml` run `npm start`. You still need build tools for `better-sqlite3` (nixpacks.toml requests `gcc` / `python3`). Prefer the Dockerfile.

## Payment matching

Poller order: **Solana Pay reference first**, then **unique YzY amount fallback** (claim only when exactly one pending intent matches ±`SLIPPAGE_BPS`; ambiguous same-amount concurrent checkouts are skipped until a reference appears or one session expires).

## Post-deploy checklist

- [ ] `/health` returns `ok: true` and merchant `YOUR_MERCHANT_WALLET`
- [ ] `PUBLIC_BASE_URL` matches the HTTPS URL (pay page QR / links use it)
- [ ] Volume mounted; create a test intent and confirm `intents.db` survives restart
- [ ] Optional: set `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (or legacy `SHOPIFY_ACCESS_TOKEN`) for auto draft create/complete; `/health` → `shopify:"client_credentials"` or `"token"`
