/**
 * Create a Solana Pay intent linked to an existing Shopify draft (MCP/Admin).
 *
 * Usage:
 *   npx tsx scripts/create-intent-for-draft.ts
 *   DRAFT_ORDER_ID=gid://shopify/DraftOrder/… USD_AMOUNT=6 EMAIL=… npx tsx scripts/create-intent-for-draft.ts
 *
 * Requires the API server running (POST /intents), or set CREATE_LOCAL=1 to
 * insert directly via shared modules (server optional).
 */
import "dotenv/config";

const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(
  /\/$/,
  "",
);

const draftOrderId =
  process.env.DRAFT_ORDER_ID ??
  "gid://shopify/DraftOrder/1186410987564";
const draftOrderName = process.env.DRAFT_ORDER_NAME ?? "#D1";
const variantId =
  process.env.VARIANT_ID ??
  "gid://shopify/ProductVariant/YOUR_VARIANT_ID";
const email = process.env.EMAIL ?? "test@example.com";
const usdAmount = Number(process.env.USD_AMOUNT ?? 6);
const amountYzyEnv = process.env.AMOUNT_YZY;

async function main() {
  const body: Record<string, unknown> = {
    draftOrderId,
    draftOrderName,
    variantId,
    quantity: 1,
    email,
    shipping: {
      firstName: "Test",
      lastName: "Buyer",
      city: "Portland",
      province: "OR",
      country: "US",
      zip: "97201",
    },
  };
  if (amountYzyEnv) {
    body.amountYzy = Number(amountYzyEnv);
  } else {
    body.usdAmount = usdAmount;
  }

  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    console.error("Failed", res.status, json);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
