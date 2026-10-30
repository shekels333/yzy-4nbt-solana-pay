/**
 * Shopify Admin API client for draft orders.
 *
 * Auth (either):
 * - Legacy static SHOPIFY_ACCESS_TOKEN (custom app Admin API token)
 * - Dev Dashboard client credentials: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *   → POST /admin/oauth/access_token with grant_type=client_credentials
 *   → ~24h access_token, cached and refreshed when <60s to expiry
 *
 * When neither is set, stubs are returned so the Solana Pay flow can be
 * developed/tested without Admin credentials.
 *
 * Required app scopes: write_draft_orders, read_draft_orders, read_products.
 * draftOrderComplete needs write_draft_orders only (not write_orders).
 */
import { config, shopifyEnabled } from "./config.js";

export interface ShippingFields {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface DraftOrderInput {
  variantId: string;
  quantity: number;
  email: string;
  shipping: ShippingFields;
  note?: string;
  tags?: string[];
  /** Server-computed shipping charge (from calculateShipping). */
  shippingLine?: { title: string; priceUsd: number } | null;
}

export interface DraftOrderResult {
  id: string;
  name: string;
  stub: boolean;
  adminUrl?: string;
  orderId?: string;
  orderName?: string;
  raw?: unknown;
}

/** In-memory cache for client_credentials tokens. */
let cachedToken: string | null = null;
let cachedExpiresAtMs = 0;
let refreshInFlight: Promise<string> | null = null;

const REFRESH_SKEW_MS = 60_000;

function adminBase(): string {
  return `https://${config.shopifyShop}/admin/api/${config.shopifyApiVersion}`;
}

/**
 * Resolve an Admin API access token.
 * Prefers static SHOPIFY_ACCESS_TOKEN; otherwise exchanges client credentials
 * and caches until near expiry.
 */
export async function getAccessToken(): Promise<string> {
  if (config.shopifyAccessToken) {
    return config.shopifyAccessToken;
  }

  if (!config.shopifyClientId || !config.shopifyClientSecret) {
    throw new Error(
      "Shopify Admin not configured: set SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET",
    );
  }

  const now = Date.now();
  if (cachedToken && now < cachedExpiresAtMs - REFRESH_SKEW_MS) {
    return cachedToken;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = fetchClientCredentialsToken()
    .then((token) => {
      refreshInFlight = null;
      return token;
    })
    .catch((err) => {
      refreshInFlight = null;
      throw err;
    });

  return refreshInFlight;
}

async function fetchClientCredentialsToken(): Promise<string> {
  const url = `https://${config.shopifyShop}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.shopifyClientId,
      client_secret: config.shopifyClientSecret,
      grant_type: "client_credentials",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Shopify client_credentials HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  let json: {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(
      `Shopify client_credentials: non-JSON response: ${text.slice(0, 200)}`,
    );
  }

  if (!json.access_token) {
    throw new Error(
      `Shopify client_credentials: missing access_token: ${text.slice(0, 300)}`,
    );
  }

  const expiresInSec =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in
      : 86_400; // default ~24h if omitted
  cachedToken = json.access_token;
  cachedExpiresAtMs = Date.now() + expiresInSec * 1000;
  console.info(
    "[shopify] client_credentials token obtained, expires_in=",
    expiresInSec,
    "s scopes=",
    json.scope ?? "(unknown)",
  );
  return cachedToken;
}

async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${adminBase()}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

function toDraftGid(id: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/DraftOrder/${id}`;
}

function adminDraftUrl(id: string): string {
  const numericId = id.split("/").pop() ?? id;
  return `https://${config.shopifyShop}/admin/draft_orders/${numericId}`;
}


export interface VariantCatalogPrice {
  variantId: string;
  title: string;
  productTitle: string;
  unitPriceUsd: number;
  currencyCode: string;
}

/** Fetch catalog unit price for a ProductVariant (Admin API). */
export async function getVariantCatalogPrice(
  variantId: string,
): Promise<VariantCatalogPrice> {
  if (!shopifyEnabled) {
    throw new Error(
      "Shopify Admin required to resolve catalog price (set SHOPIFY_CLIENT_ID+SECRET or SHOPIFY_ACCESS_TOKEN)",
    );
  }

  const id = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query variantPrice($id: ID!) {
      productVariant(id: $id) {
        id
        title
        price
        product { title }
      }
    }
  `;
  const json = await shopifyGraphql<{
    data?: {
      productVariant?: {
        id: string;
        title: string;
        price: string;
        product?: { title?: string } | null;
      } | null;
    };
    errors?: { message: string }[];
  }>(query, { id });

  if (json.errors?.length) {
    throw new Error(
      `Shopify productVariant query errors: ${JSON.stringify(json.errors)}`,
    );
  }
  const v = json.data?.productVariant;
  if (!v) {
    throw new Error(`Shopify productVariant not found: ${id}`);
  }
  const unitPriceUsd = Number(v.price);
  if (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0) {
    throw new Error(`Invalid catalog price for ${id}: ${v.price}`);
  }
  return {
    variantId: v.id,
    title: v.title,
    productTitle: v.product?.title ?? "",
    unitPriceUsd,
    currencyCode: "USD",
  };
}

export async function createDraftOrder(
  input: DraftOrderInput,
): Promise<DraftOrderResult> {
  if (!shopifyEnabled) {
    const stubId = `stub-draft-${Date.now()}`;
    console.warn(
      "[shopify] Admin auth missing — returning stub draft order",
      stubId,
    );
    return {
      id: stubId,
      name: `#STUB-${input.variantId}`,
      stub: true,
    };
  }

  const variantGid = input.variantId.startsWith("gid://")
    ? input.variantId
    : `gid://shopify/ProductVariant/${input.variantId}`;

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
        }
        userErrors { field message }
      }
    }
  `;

  const shipping = input.shipping;
  const variables = {
    input: {
      email: input.email,
      note: input.note ?? "Paid with YzY via custom Solana Pay",
      tags: input.tags ?? ["solana-pay", "yzy"],
      lineItems: [
        {
          variantId: variantGid,
          quantity: input.quantity,
        },
      ],
      ...(input.shippingLine
        ? {
            shippingLine: {
              title: input.shippingLine.title,
              price: input.shippingLine.priceUsd.toFixed(2),
            },
          }
        : {}),
      shippingAddress: {
        firstName: shipping.firstName,
        lastName: shipping.lastName,
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        province: shipping.province,
        country: shipping.country ?? "US",
        zip: shipping.zip,
        phone: shipping.phone,
      },
    },
  };

  const json = await shopifyGraphql<{
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string; name: string } | null;
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  }>(mutation, variables);

  const errs = json.errors ?? json.data?.draftOrderCreate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(
      `Shopify draftOrderCreate errors: ${JSON.stringify(errs)}`,
    );
  }

  const draft = json.data?.draftOrderCreate?.draftOrder;
  if (!draft) throw new Error("Shopify returned no draftOrder");

  return {
    id: draft.id,
    name: draft.name,
    stub: false,
    adminUrl: adminDraftUrl(draft.id),
    raw: json,
  };
}

/** Resolve an existing draft (MCP-created) for linking into an intent. */
export async function linkExistingDraftOrder(opts: {
  draftOrderId: string;
  draftOrderName?: string;
}): Promise<DraftOrderResult> {
  const id = toDraftGid(opts.draftOrderId);

  if (!shopifyEnabled) {
    console.warn(
      "[shopify] linking existing draft without Admin auth — using provided id/name only",
      id,
    );
    return {
      id,
      name: opts.draftOrderName ?? "#LINKED",
      stub: true,
      adminUrl: adminDraftUrl(id),
    };
  }

  const query = `
    query draftOrder($id: ID!) {
      draftOrder(id: $id) {
        id
        name
        status
      }
    }
  `;
  const json = await shopifyGraphql<{
    data?: {
      draftOrder?: { id: string; name: string; status: string } | null;
    };
    errors?: { message: string }[];
  }>(query, { id });

  if (json.errors?.length) {
    throw new Error(`Shopify draftOrder query errors: ${JSON.stringify(json.errors)}`);
  }
  const draft = json.data?.draftOrder;
  if (!draft) {
    // Fall back to caller-provided metadata if Admin cannot read (scope/id)
    if (opts.draftOrderName) {
      console.warn("[shopify] draftOrder not readable; using provided name", id);
      return {
        id,
        name: opts.draftOrderName,
        stub: false,
        adminUrl: adminDraftUrl(id),
      };
    }
    throw new Error(`Shopify draftOrder not found: ${id}`);
  }

  return {
    id: draft.id,
    name: draft.name,
    stub: false,
    adminUrl: adminDraftUrl(draft.id),
    raw: json,
  };
}

/**
 * Complete a paid draft into a real Order (requires write_draft_orders).
 * paymentPending=false marks payment as received.
 */
export async function completeDraftOrder(
  draftOrderId: string,
  signature: string,
): Promise<DraftOrderResult | null> {
  if (!shopifyEnabled || draftOrderId.startsWith("stub-")) {
    console.info(
      "[shopify] stub completeDraftOrder",
      draftOrderId,
      signature.slice(0, 12) + "…",
    );
    return null;
  }

  const id = toDraftGid(draftOrderId);

  // Tag + note before complete so the Order inherits payment provenance.
  const updateMutation = `
    mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;
  const updateJson = await shopifyGraphql<{
    data?: {
      draftOrderUpdate?: {
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  }>(updateMutation, {
    id,
    input: {
      note: `Paid with YzY via Solana Pay. signature=${signature}`,
      tags: ["solana-pay", "yzy", "yzy-paid"],
    },
  });
  const updateErrs =
    updateJson.errors ?? updateJson.data?.draftOrderUpdate?.userErrors ?? [];
  if (updateErrs.length) {
    console.warn("[shopify] draftOrderUpdate errors", updateErrs);
  }

  const completeMutation = `
    mutation draftOrderComplete($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder {
          id
          name
          order { id name }
        }
        userErrors { field message }
      }
    }
  `;
  const json = await shopifyGraphql<{
    data?: {
      draftOrderComplete?: {
        draftOrder?: {
          id: string;
          name: string;
          order?: { id: string; name: string } | null;
        } | null;
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  }>(completeMutation, { id, paymentPending: false });

  const errs = json.errors ?? json.data?.draftOrderComplete?.userErrors ?? [];
  if (errs.length) {
    throw new Error(
      `Shopify draftOrderComplete errors: ${JSON.stringify(errs)}`,
    );
  }

  const draft = json.data?.draftOrderComplete?.draftOrder;
  if (!draft) throw new Error("Shopify draftOrderComplete returned no draft");

  console.info(
    "[shopify] draftOrderComplete ok",
    draft.id,
    "→ order",
    draft.order?.name ?? "(none)",
  );

  return {
    id: draft.id,
    name: draft.name,
    stub: false,
    adminUrl: adminDraftUrl(draft.id),
    orderId: draft.order?.id,
    orderName: draft.order?.name,
    raw: json,
  };
}

/**
 * Delete an unpaid OPEN draft after intent expiry. Skips stubs, missing ids,
 * and drafts that are already COMPLETED (converted to Order).
 */
export async function cancelOpenDraftOrder(
  draftOrderId: string,
): Promise<"deleted" | "skipped" | "missing"> {
  if (!draftOrderId || draftOrderId.startsWith("stub-")) {
    return "skipped";
  }
  if (!shopifyEnabled) {
    console.info(
      "[shopify] cancelOpenDraftOrder skipped (no Admin auth)",
      draftOrderId,
    );
    return "skipped";
  }

  const id = toDraftGid(draftOrderId);
  const query = `
    query draftOrder($id: ID!) {
      draftOrder(id: $id) {
        id
        name
        status
        order { id }
      }
    }
  `;
  const json = await shopifyGraphql<{
    data?: {
      draftOrder?: {
        id: string;
        name: string;
        status: string;
        order?: { id: string } | null;
      } | null;
    };
    errors?: { message: string }[];
  }>(query, { id });

  if (json.errors?.length) {
    console.warn("[shopify] cancelOpenDraftOrder query errors", json.errors);
    return "skipped";
  }
  const draft = json.data?.draftOrder;
  if (!draft) return "missing";

  // COMPLETED = already an Order — never delete.
  if (draft.status === "COMPLETED" || draft.order?.id) {
    console.info(
      "[shopify] cancelOpenDraftOrder skip completed",
      draft.name,
      draft.status,
    );
    return "skipped";
  }

  const mutation = `
    mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors { field message }
      }
    }
  `;
  const del = await shopifyGraphql<{
    data?: {
      draftOrderDelete?: {
        deletedId?: string | null;
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  }>(mutation, { input: { id } });

  const errs =
    del.errors ?? del.data?.draftOrderDelete?.userErrors ?? [];
  if (errs.length) {
    console.warn("[shopify] draftOrderDelete errors", errs);
    return "skipped";
  }
  console.info(
    "[shopify] expired draft deleted",
    draft.name,
    del.data?.draftOrderDelete?.deletedId,
  );
  return "deleted";
}

/**
 * After on-chain confirmation: complete draft → Order when Admin auth is set;
 * otherwise log stub / instruct MCP manual complete.
 */
export async function annotateDraftPaid(
  draftOrderId: string,
  signature: string,
): Promise<void> {
  if (!draftOrderId) {
    console.warn("[shopify] annotateDraftPaid: no draftOrderId");
    return;
  }
  if (!shopifyEnabled || draftOrderId.startsWith("stub-")) {
    console.info(
      "[shopify] no Admin auth — skip draftOrderComplete.",
      "Complete draft manually via Admin or user-Shopify MCP:",
      draftOrderId,
      "sig",
      signature.slice(0, 16) + "…",
    );
    return;
  }
  await completeDraftOrder(draftOrderId, signature);
}


export interface ShippingQuote {
  /** False when no line item needs shipping (digital etc.) → $0. */
  requiresShipping: boolean;
  /** Null when shipping is required but Shopify offers no rate for the address. */
  rate: { title: string; priceUsd: number } | null;
}

/**
 * Server-authoritative shipping: ask Shopify which rates checkout would offer
 * for this variant/qty/address (draftOrderCalculate creates nothing) and pick
 * the cheapest one. Same delivery profiles as card checkout.
 */
export async function calculateShipping(
  variantId: string,
  quantity: number,
  shipping: ShippingFields,
): Promise<ShippingQuote> {
  if (!shopifyEnabled) {
    return { requiresShipping: false, rate: null };
  }
  const id = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;
  const mutation = `
    mutation calcShipping($input: DraftOrderInput!) {
      draftOrderCalculate(input: $input) {
        calculatedDraftOrder {
          lineItems { requiresShipping }
          availableShippingRates { title price { amount } }
        }
        userErrors { field message }
      }
    }
  `;
  const json = await shopifyGraphql<{
    data?: {
      draftOrderCalculate?: {
        calculatedDraftOrder?: {
          lineItems: { requiresShipping: boolean }[];
          availableShippingRates: { title: string; price: { amount: string } }[];
        } | null;
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  }>(mutation, {
    input: {
      lineItems: [{ variantId: id, quantity }],
      shippingAddress: {
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        province: shipping.province,
        country: shipping.country ?? "US",
        zip: shipping.zip,
      },
    },
  });
  const errs = json.errors ?? json.data?.draftOrderCalculate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`Shopify draftOrderCalculate errors: ${JSON.stringify(errs)}`);
  }
  const calc = json.data?.draftOrderCalculate?.calculatedDraftOrder;
  if (!calc) throw new Error("Shopify returned no calculated draft");
  const requiresShipping = calc.lineItems.some((li) => li.requiresShipping);
  if (!requiresShipping) return { requiresShipping: false, rate: null };
  const rates = calc.availableShippingRates
    .map((r) => ({ title: r.title, priceUsd: Number(r.price.amount) }))
    .filter((r) => Number.isFinite(r.priceUsd) && r.priceUsd >= 0)
    .sort((a, b) => a.priceUsd - b.priceUsd);
  return { requiresShipping: true, rate: rates[0] ?? null };
}
