# 4NBT Solana Pay (MVP)

Custom **YzY (4NBT)** Solana Pay checkout for your Shopify store, independent of the Helio/Shopify Solana Pay app. Creates a payment intent + Solana Pay transfer URL (SPL), shows a QR page, polls the chain for the reference signature, and links or creates a **Shopify draft order**. On confirmed payment, calls **`draftOrderComplete`** when `SHOPIFY_ACCESS_TOKEN` is set.

> **Not legal/financial advice.** Do **not** expose this service on the public internet without **HTTPS** and basic auth / rate limits. Local or private tunnel for testing only.

## Stack

- Node 20+ / TypeScript (`tsx`)
- Express
- `@solana/web3.js` + `@solana/pay`
- `better-sqlite3` intent store (`data/intents.db`)
- DexScreener quote helper (`src/price.ts`) for USD → YzY
- Static `public/buy.html` (email + shipping → `POST /intents`) and `public/pay.html` (QR / Open in wallet) with **live quote refresh**

## Mint & merchant

| | |
|---|---|
| YzY mint | `4NBTf8PfLH4oLFnwf3knv46FY9i5oXjDxffCetXRpump` (6 decimals) |
| Merchant wallet | `YOUR_MERCHANT_WALLET` |
| Shopify shop | `yourshop.myshopify.com` |
| Example product | Example Product · variant `gid://shopify/ProductVariant/YOUR_VARIANT_ID` · **$6.00 USD** |

## Setup

```bash
cd /workspace/4nbt-solana-pay
cp .env.example .env
# Optional: set SHOPIFY_ACCESS_TOKEN for live draft create/complete
npm install
npm run typecheck
npm run dev
```

Health: `GET http://localhost:8787/health`

## Env vars

See `.env.example`. Important:

- `MERCHANT_WALLET` — destination for YzY SPL transfers
- `YZY_MINT` / `YZY_DECIMALS`
- `SOLANA_RPC_URL` — use a dedicated RPC (Helius/QuickNode) in production
- `DEFAULT_AMOUNT_YZY` — fallback if client omits `amountYzy` / `usdAmount` (snapshot ≈ **2948.402949** for $6 @ ~$0.002035 on 2026-10-25). Prefer live `usdAmount` on each intent.
- `QUOTE_REFRESH_MS` — how often pending USD intents re-quote DexScreener (**default `3000`**). `pay.html` polls on this interval.
- `SLIPPAGE_BPS` — accept transfers within ± this many basis points of expected `amount_yzy` (**default `100` = ±1%**). See [Live quote refresh & slippage](#live-quote-refresh--slippage).
- `MIN_PAIR_LIQUIDITY_USD` — optional floor; **`0` (default) disables** and always picks the highest-liquidity DexScreener pair.
- `MAX_PRICE_DEVIATION_BPS` — reject spot vs median of recent accepted mids if move exceeds this (**default `500` = 5%**). Empty history on boot accepts once and seeds.
- `PRICE_HISTORY_SIZE` / `PRICE_HISTORY_MS` — short in-memory TWAP window (**default `5` samples / `120000` ms**). Conversion uses the mean of accepted mids.
- `SHOPIFY_SHOP` / `SHOPIFY_ACCESS_TOKEN` / `SHOPIFY_API_VERSION`
- `PUBLIC_BASE_URL` — used in `payPageUrl` links

### Shopify token vs MCP

| Capability | With `SHOPIFY_ACCESS_TOKEN` (Custom App: `write_draft_orders`, `read_draft_orders`, `read_products`) | Without token |
|---|---|---|
| Create draft | Live `draftOrderCreate` | Stub id, or skip create and pass `draftOrderId` |
| Link MCP draft | `POST /intents` + `draftOrderId` (optional Admin read) | Same — stores id/name you provide |
| Complete after pay | **`draftOrderComplete`** (`paymentPending: false`) + tags `yzy-paid` | Log only — **complete manually** in Admin or via **user-Shopify MCP** |

Until a Custom App token is in `.env`, the intended loop is: **MCP creates draft → this service takes payment → MCP/Admin completes draft #D1 (etc.)**.

## Live quote refresh & slippage

Intents created with **`usdAmount`** keep a live USD→YzY quote while `status=pending`:

1. `pay.html` polls `GET /intents/:id` every **`QUOTE_REFRESH_MS`** (default **3s**).
2. Server re-fetches DexScreener when the last quote is older than that interval (liquidity floor + deviation circuit breaker; rejected refreshes **keep the prior good quote**).
3. If `amount_yzy` changes (at token-decimal precision), the intent gets a **new Solana Pay reference + URL** (old QR / in-flight reference is invalidated). Confirmed intents are never mutated.
4. Before regenerating, the server checks whether a transfer already landed on the current reference; if so, it skips refresh so confirm can proceed.
5. Intents created with explicit **`amountYzy` only** (no `usdAmount`) stay fixed — no live refresh.

**Slippage (`SLIPPAGE_BPS`, default 100 = ±1%):** `@solana/pay` `validateTransfer` only requires `transferred >= amount`. We pass  
`amount = expected × (1 − SLIPPAGE_BPS/10000)` so slight underpayment (wallet rounding / tiny FX) still confirms. Overpayment is always accepted (merchant-favorable). Poller and `POST /intents/:id/confirm` both use this band.

Force a re-quote: `POST /intents/:id/refresh` (pending + `usdAmount` only).

## API

### `POST /intents`

Create a new draft **or** link an existing one.

```json
{
  "variantId": "gid://shopify/ProductVariant/YOUR_VARIANT_ID",
  "quantity": 1,
  "email": "buyer@example.com",
  "usdAmount": 6,
  "draftOrderId": "gid://shopify/DraftOrder/1186410987564",
  "draftOrderName": "#D1",
  "shipping": {
    "firstName": "A",
    "lastName": "Buyer",
    "address1": "1 Main St",
    "city": "Portland",
    "province": "OR",
    "country": "US",
    "zip": "97201"
  }
}
```

- `usdAmount` — quotes YzY via DexScreener (ceil to 6 decimals); enables live refresh; response includes `quote: { priceUsd, … }`
- `amountYzy` — explicit token amount (used when `usdAmount` omitted; **no** live refresh)
- `draftOrderId` — skip create; link MCP/Admin draft (name optional via `draftOrderName`)

Returns `{ intentId, solanaPayUrl, amount, usdAmount, priceUsd, quoteRefreshMs, slippageBps, liveQuote, mint, payPageUrl, shopifyDraftOrderId, … }`.

### `GET /intents/:id`

Status: `pending` | `confirmed` | `expired` | `failed`.  
For pending USD intents, may refresh quote / QR (`quoteRefreshed`, `quoteChanged`).

### `POST /intents/:id/refresh`

Force DexScreener re-quote (pending + `usdAmount` only).

### `POST /intents/:id/confirm`

Nudge: `findReference` + `validateTransfer` (with slippage band) → mark confirmed → `annotateDraftPaid` → **`completeDraftOrder`** when Shopify auth is set. If no reference is found, tries the **unique-amount fallback** (same rules as the poller).

Background poller (`src/poller.ts`) does reference matching first, then unique-amount fallback.

## Script: intent for existing draft

```bash
# server must be running
DRAFT_ORDER_ID=gid://shopify/DraftOrder/1186410987564 \
DRAFT_ORDER_NAME='#D1' \
USD_AMOUNT=6 \
EMAIL=test@example.com \
npm run intent:draft
```

## Pay page

Open `payPageUrl`, e.g. `http://localhost:8787/pay.html?intent=<intentId>`.

Shows live **USD**, **YzY spot**, and **amount**; updates the QR when the quote changes. Confirm poll runs in parallel (~4s).

## How to test ($6 sticker + draft #D1)

1. `npm run dev`
2. Link the MCP draft and quote $6 → YzY:

```bash
curl -s -X POST http://localhost:8787/intents \
  -H 'content-type: application/json' \
  -d '{
    "variantId":"gid://shopify/ProductVariant/YOUR_VARIANT_ID",
    "quantity":1,
    "email":"test@example.com",
    "usdAmount":6,
    "draftOrderId":"gid://shopify/DraftOrder/1186410987564",
    "draftOrderName":"#D1",
    "shipping":{"firstName":"Test","lastName":"Buyer","city":"Portland","province":"OR","country":"US","zip":"97201"}
  }' | jq .
```

3. Open `payPageUrl` from the response; watch amount/QR update every ~3s if DexScreener moves. Pay the **current** `amount` YzY (reference + spl-token required).
4. Force refresh: `curl -s -X POST http://localhost:8787/intents/<id>/refresh | jq .`
5. On confirm: with token → Order created; without → complete `#D1` manually via MCP/Admin.


## Storefront deep link (Pay with YzY)

Product pages should **not** send shoppers through Shopify Checkout. Link (or theme button) to the pay service start page:

```
https://pay.yourdomain.com/buy.html?variantId={{ variant.id }}&quantity=1&usdAmount={{ variant.price | money_without_currency }}&title={{ product.title | url_encode }}&productUrl={{ shop.url | append: product.url | url_encode }}
```

Liquid example (Horizon Custom Liquid / snippet):

```liquid
{% assign v = product.selected_or_first_available_variant %}
<a class="button"
   href="https://pay.yourdomain.com/buy.html?variantId={{ v.id }}&quantity=1&usdAmount={{ v.price | money_without_currency }}&title={{ product.title | url_encode }}&productUrl={{ shop.url | append: product.url | url_encode }}">
  Pay with YzY
</a>
```

Flow: `buy.html` collects email + shipping → same-origin `POST /intents` → redirect to `payPageUrl` (`pay.html`). CORS allows `https://yourshop.com`, `https://www.yourshop.com`, and `https://yourshop.myshopify.com` if a theme script POSTs directly.

Example sticker:  
`https://pay.yourdomain.com/buy.html?variantId=YOUR_VARIANT_ID&quantity=1&usdAmount=6&title=Example%20Product`

## Architecture (MVP)

```
MCP/Admin (optional) → DraftOrder #D1
Shopper → POST /intents (draftOrderId + usdAmount) → SQLite intent
        → pay.html QR (solana: URL, YzY SPL + reference)
        → GET /intents/:id every QUOTE_REFRESH_MS → re-quote / new reference if amount moves
Wallet  → SPL transfer to MERCHANT_WALLET (preferably with Solana Pay reference)
Poller  → (1) findReference + validateTransfer (±SLIPPAGE_BPS) → confirm
        → (2) FALLBACK: inbound YzY to merchant with amount within ±SLIPPAGE_BPS
              of exactly ONE pending intent → confirm; 0 or 2+ matches → skip
        → draftOrderComplete (if Shopify auth) else manual MCP
```

### Payment matching order

1. **Reference (primary)** — Solana Pay reference pubkey in the tx. Concurrent checkouts are unambiguous even at the same YzY amount.
2. **Unique amount (fallback)** — for wallets that omit the reference: credit of YzY to `MERCHANT_WALLET` whose amount is within ±`SLIPPAGE_BPS` of a pending intent’s `amount_yzy`. Claims **only** when that match is unique among open pending intents. If two buyers have the same quoted amount open at once, the fallback **does not** auto-claim (they need the reference path, or one session to expire).
3. Signatures are claimed idempotently (unique `signature` on intents; `tryMarkConfirmed` is status+signature race-safe).

## Security notes

- No secrets in git (`.env` gitignored).
- Reference keypair secret is stored for debugging; treat DB as sensitive.
- Add HTTPS before any public URL.
- Live `usdAmount` re-quote — memecoin FX moves fast; old references are invalidated when amount changes.
- Only complete drafts after on-chain validation succeeds.

## Parent follow-ups

1. Add Custom App `SHOPIFY_ACCESS_TOKEN` for automatic `draftOrderComplete` (optional — connector/manual is fine).
2. ~~Storefront “Pay with YzY”~~ — see [Storefront deep link](#storefront-deep-link-pay-with-yzy).
3. Fulfillment webhook / order tags once Order exists.
4. Deploy behind HTTPS + dedicated Solana RPC.
