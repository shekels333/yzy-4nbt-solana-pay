import { Router } from "express";
import { createIpRateLimiter } from "../rateLimit.js";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import {
  countPendingByEmail,
  countPendingIntents,
  getIntent,
  getIntentBySignature,
  insertIntent,
  listPendingIntents,
  touchQuotedAt,
  tryMarkConfirmed,
  updatePendingQuote,
  type IntentRow,
  updateShopifyOrder,
} from "../db.js";
import { quoteUsdInYzy } from "../price.js";
import {
  annotateDraftPaid,
  createDraftOrder,
  getVariantCatalogPrice,
  calculateShipping,
  linkExistingDraftOrder,
  type ShippingFields,
} from "../shopify.js";
import {
  amountWithinSlippage,
  buildSolanaPayUrl,
  createReference,
  findPaymentSignature,
  findRecentYzyInboundTransfers,
  validateYzyPayment,
} from "../solana.js";

export const intentsRouter = Router();

interface CreateIntentBody {
  variantId?: string;
  quantity?: number;
  email?: string;
  amountYzy?: number;
  /** If set, compute amountYzy from DexScreener (overrides amountYzy / default). */
  usdAmount?: number;
  /** Link an existing Shopify draft (e.g. MCP-created) instead of creating one. */
  draftOrderId?: string;
  draftOrderName?: string;
  shipping?: ShippingFields;
}

function sameAmount(a: number, b: number): boolean {
  const factor = 10 ** config.yzyDecimals;
  return Math.round(a * factor) === Math.round(b * factor);
}

function publicIntent(row: IntentRow, extra?: Record<string, unknown>) {
  return {
    intentId: row.id,
    status: row.status,
    variantId: row.variant_id,
    quantity: row.quantity,
    email: row.email,
    amount: row.amount_yzy,
    usdAmount: row.usd_amount,
    priceUsd: row.price_usd,
    quotedAt: row.quoted_at,
    quoteRefreshMs: config.quoteRefreshMs,
    slippageBps: config.slippageBps,
    liveQuote: row.usd_amount != null && row.usd_amount > 0,
    mint: config.yzyMint.toBase58(),
    merchantWallet: config.merchantWallet.toBase58(),
    reference: row.reference_pubkey,
    solanaPayUrl: row.solana_pay_url,
    payPageUrl: `${config.publicBaseUrl}/pay.html?intent=${row.id}`,
    shopifyDraftOrderId: row.shopify_draft_order_id,
    shopifyDraftOrderName: row.shopify_draft_order_name,
    orderName: row.shopify_order_name ?? null,
    orderStatusUrl: row.order_status_url ?? null,
    signature: row.signature,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...extra,
  };
}

/**
 * Re-quote pending USD intents when the last quote is older than QUOTE_REFRESH_MS.
 * If amount changes: new reference + solana pay URL (invalidates prior expected transfer).
 * Skips refresh if a payment already landed on the current reference.
 */
async function maybeRefreshQuote(
  row: IntentRow,
): Promise<{ row: IntentRow; refreshed: boolean; quoteChanged: boolean }> {
  if (row.status !== "pending") {
    return { row, refreshed: false, quoteChanged: false };
  }
  if (row.usd_amount == null || !(row.usd_amount > 0)) {
    return { row, refreshed: false, quoteChanged: false };
  }
  if (Date.now() > row.expires_at) {
    return { row, refreshed: false, quoteChanged: false };
  }

  const age = Date.now() - (row.quoted_at ?? 0);
  if (age < config.quoteRefreshMs) {
    return { row, refreshed: false, quoteChanged: false };
  }

  // Don't churn reference if a transfer for the current QR is already on-chain.
  try {
    const existingSig = await findPaymentSignature(
      new PublicKey(row.reference_pubkey),
    );
    if (existingSig) {
      return { row, refreshed: false, quoteChanged: false };
    }
  } catch (err) {
    console.warn(`[refresh] findReference check failed for ${row.id}`, err);
  }

  const result = await quoteUsdInYzy(row.usd_amount);
  if (!result.ok) {
    // Keep prior good quote — never silently apply a spiked / illiquid price.
    console.warn(
      `[refresh] quote rejected for intent ${row.id}: ${result.code} — ${result.message}`,
    );
    return { row, refreshed: false, quoteChanged: false };
  }
  const quote = result.quote;

  if (sameAmount(quote.amountYzy, row.amount_yzy)) {
    touchQuotedAt(row.id, quote.priceUsd, quote.fetchedAt);
    const touched = getIntent(row.id) ?? row;
    return { row: touched, refreshed: true, quoteChanged: false };
  }

  const reference = createReference();
  const solanaPayUrl = buildSolanaPayUrl({
    amountYzy: quote.amountYzy,
    reference: reference.publicKey,
  });
  const updated = updatePendingQuote(row.id, {
    amountYzy: quote.amountYzy,
    priceUsd: quote.priceUsd,
    quotedAt: quote.fetchedAt,
    referencePubkey: reference.publicKey.toBase58(),
    referenceSecret: bs58.encode(reference.secretKey),
    solanaPayUrl,
  });
  if (!updated) {
    // Confirmed/expired between check and update.
    return { row: getIntent(row.id) ?? row, refreshed: false, quoteChanged: false };
  }
  console.info(
    `[refresh] intent ${row.id} amount ${row.amount_yzy} → ${quote.amountYzy} YzY @ $${quote.priceUsd} (${quote.pricing}, n=${quote.historySize}) (new reference)`,
  );
  return { row: updated, refreshed: true, quoteChanged: true };
}


function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

const intentsRateLimit = createIpRateLimiter();
const shippingQuoteRateLimit = createIpRateLimiter({ max: 40, message: "Too many shipping quotes; try again shortly" });

type ShipResult =
  | { ok: true; line: { title: string; priceUsd: number } | null }
  | { ok: false; error: string };

async function resolveShipping(
  variantId: string,
  quantity: number,
  shipping: ShippingFields,
): Promise<ShipResult> {
  const q = await calculateShipping(variantId, quantity, shipping);
  if (!q.requiresShipping) return { ok: true, line: null };
  if (!q.rate) {
    return {
      ok: false,
      error: "Sorry — we currently ship to the US only.",
    };
  }
  return { ok: true, line: { title: q.rate.title, priceUsd: roundUsd(q.rate.priceUsd) } };
}

/** Preview item + shipping totals for buy.html (creates nothing). */
intentsRouter.post("/shipping-quote", shippingQuoteRateLimit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as CreateIntentBody;
    const variantId = String(body.variantId ?? "").trim();
    const quantity = Number(body.quantity ?? 1);
    const shipping = body.shipping ?? {};
    if (!variantId) {
      res.status(400).json({ error: "variantId is required" });
      return;
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > config.maxQuantity) {
      res.status(400).json({ error: `quantity must be 1–${config.maxQuantity}` });
      return;
    }
    const catalog = await getVariantCatalogPrice(variantId);
    const itemsUsd = roundUsd(catalog.unitPriceUsd * quantity);
    const ship = await resolveShipping(catalog.variantId, quantity, shipping);
    if (!ship.ok) {
      res.status(422).json({ error: ship.error, code: "no_shipping_rate", itemsUsd });
      return;
    }
    const shippingUsd = ship.line?.priceUsd ?? 0;
    res.json({
      itemsUsd,
      shippingUsd,
      shippingTitle: ship.line?.title ?? null,
      totalUsd: roundUsd(itemsUsd + shippingUsd),
    });
  } catch (err) {
    console.error("[POST /intents/shipping-quote]", err);
    res.status(500).json({ error: "failed to quote shipping" });
  }
});

intentsRouter.post("/", intentsRateLimit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as CreateIntentBody;
    const draftOrderId = String(body.draftOrderId ?? "").trim();
    const adminSecret = String(
      req.headers["x-intent-admin-secret"] ?? "",
    ).trim();
    const adminOk =
      Boolean(config.intentAdminSecret) &&
      adminSecret === config.intentAdminSecret;

    // Public path: no draftOrderId linking (underpay / hijack risk).
    // Admin may link with X-Intent-Admin-Secret when INTENT_ADMIN_SECRET is set.
    if (draftOrderId && !adminOk) {
      res.status(403).json({
        error:
          "draftOrderId linking is disabled on the public checkout; omit draftOrderId or use admin secret",
      });
      return;
    }

    const variantId = String(
      body.variantId ?? (draftOrderId ? "linked-draft" : ""),
    ).trim();
    const quantity = Number(body.quantity ?? 1);
    const email = String(body.email ?? "").trim();
    const shipping = body.shipping ?? {};

    if (!variantId && !draftOrderId) {
      res.status(400).json({ error: "variantId is required" });
      return;
    }
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "valid email is required" });
      return;
    }
    if (
      !Number.isFinite(quantity) ||
      quantity < 1 ||
      quantity > config.maxQuantity
    ) {
      res.status(400).json({
        error: `quantity must be 1–${config.maxQuantity}`,
      });
      return;
    }

    // Soft caps on concurrent pending checkouts (abuse / draft spam).
    if (countPendingIntents() >= config.maxPendingIntents) {
      res.status(429).json({
        error: "Too many pending checkouts; try again shortly",
      });
      return;
    }
    if (countPendingByEmail(email) >= config.maxPendingPerEmail) {
      res.status(429).json({
        error: "Too many pending checkouts for this email; finish or wait for one to expire",
      });
      return;
    }

    // --- Server-authoritative USD from Shopify catalog (ignore client amounts) ---
    let usdAmount: number;
    let catalogMeta: {
      unitPriceUsd: number;
      productTitle: string;
      variantTitle: string;
      variantId: string;
      clientUsdIgnored: number | null;
      clientAmountYzyIgnored: number | null;
    } | null = null;

    let shippingLine: { title: string; priceUsd: number } | null = null;
    let itemsUsd: number | null = null;

    if (draftOrderId && adminOk) {
      // Admin link path: still require a positive usdAmount from caller (trusted),
      // or derive from variant when provided.
      if (variantId && variantId !== "linked-draft") {
        const catalog = await getVariantCatalogPrice(variantId);
        usdAmount = roundUsd(catalog.unitPriceUsd * quantity);
        catalogMeta = {
          unitPriceUsd: catalog.unitPriceUsd,
          productTitle: catalog.productTitle,
          variantTitle: catalog.title,
          variantId: catalog.variantId,
          clientUsdIgnored:
            body.usdAmount != null ? Number(body.usdAmount) : null,
          clientAmountYzyIgnored:
            body.amountYzy != null ? Number(body.amountYzy) : null,
        };
      } else if (body.usdAmount != null) {
        const usd = Number(body.usdAmount);
        if (!Number.isFinite(usd) || usd <= 0) {
          res.status(400).json({ error: "usdAmount must be a positive number" });
          return;
        }
        usdAmount = roundUsd(usd);
      } else {
        res.status(400).json({
          error:
            "admin draft link requires variantId (for catalog price) or usdAmount",
        });
        return;
      }
    } else {
      // Public checkout: always catalog price × quantity.
      const catalog = await getVariantCatalogPrice(variantId);
      usdAmount = roundUsd(catalog.unitPriceUsd * quantity);
      catalogMeta = {
        unitPriceUsd: catalog.unitPriceUsd,
        productTitle: catalog.productTitle,
        variantTitle: catalog.title,
        variantId: catalog.variantId,
        clientUsdIgnored:
          body.usdAmount != null ? Number(body.usdAmount) : null,
        clientAmountYzyIgnored:
          body.amountYzy != null ? Number(body.amountYzy) : null,
      };
      const ship = await resolveShipping(catalog.variantId, quantity, shipping);
      if (!ship.ok) {
        res.status(422).json({ error: ship.error, code: "no_shipping_rate" });
        return;
      }
      shippingLine = ship.line;
      itemsUsd = usdAmount;
      usdAmount = roundUsd(usdAmount + (ship.line?.priceUsd ?? 0));
    }

    if (!(usdAmount > 0)) {
      res.status(400).json({ error: "catalog total must be positive" });
      return;
    }
    if (usdAmount > config.maxUsdTotal) {
      res.status(400).json({
        error: `order total $${usdAmount} exceeds max $${config.maxUsdTotal}`,
      });
      return;
    }

    const quoteResult = await quoteUsdInYzy(usdAmount);
    if (!quoteResult.ok) {
      // Fail closed: never create a draft from an illiquid or circuit-broken quote.
      const status =
        quoteResult.code === "dex_unavailable"
          ? 502
          : quoteResult.code === "price_deviation" ||
              quoteResult.code === "no_liquid_pair"
            ? 503
            : 422;
      res.status(status).json({
        error: quoteResult.message,
        code: quoteResult.code,
        spotPriceUsd: quoteResult.spotPriceUsd,
        referencePriceUsd: quoteResult.referencePriceUsd,
        deviationBps: quoteResult.deviationBps,
      });
      return;
    }
    const quote = quoteResult.quote;
    const amountYzy = quote.amountYzy;
    const priceUsd = quote.priceUsd;
    const quotedAt = quote.fetchedAt;
    const quoteMeta = {
      usdAmount: quote.usdAmount,
      priceUsd: quote.priceUsd,
      spotPriceUsd: quote.spotPriceUsd,
      dexId: quote.dexId,
      pairAddress: quote.pairAddress,
      liquidityUsd: quote.liquidityUsd,
      pricing: quote.pricing,
      historySize: quote.historySize,
      source: "shopify_catalog",
    };

    const draft = draftOrderId
      ? await linkExistingDraftOrder({
          draftOrderId,
          draftOrderName: body.draftOrderName,
        })
      : await createDraftOrder({
          variantId,
          quantity,
          email,
          shipping,
          shippingLine,
          note: `Pending YzY Solana Pay (${amountYzy} YzY ≈ $${usdAmount})`,
        });

    const reference = createReference();
    const solanaPayUrl = buildSolanaPayUrl({
      amountYzy,
      reference: reference.publicKey,
    });

    const now = Date.now();
    const id = randomUUID();
    const row: IntentRow = {
      id,
      status: "pending",
      variant_id: catalogMeta?.variantId ?? (variantId || "linked-draft"),
      quantity,
      email,
      shipping_json: JSON.stringify(shipping),
      amount_yzy: amountYzy,
      usd_amount: usdAmount,
      price_usd: priceUsd,
      quoted_at: quotedAt,
      reference_pubkey: reference.publicKey.toBase58(),
      reference_secret: bs58.encode(reference.secretKey),
      solana_pay_url: solanaPayUrl,
      shopify_draft_order_id: draft.id,
      shopify_draft_order_name: draft.name,
      signature: null,
      created_at: now,
      updated_at: now,
      expires_at: now + config.intentTtlMs,
    };
    insertIntent(row);

    res.status(201).json({
      ...publicIntent(row),
      shopifyStub: draft.stub,
      shopifyAdminUrl: draft.adminUrl,
      quote: quoteMeta,
      catalog: catalogMeta,
      breakdown: {
        itemsUsd,
        shippingUsd: shippingLine?.priceUsd ?? 0,
        shippingTitle: shippingLine?.title ?? null,
        totalUsd: usdAmount,
      },
      pricing: {
        serverAuthoritative: true,
        clientUsdAmountIgnored: true,
        clientAmountYzyIgnored: true,
      },
    });
  } catch (err) {
    console.error("[POST /intents]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "failed to create intent",
    });
  }
});


intentsRouter.get("/:id", async (req, res) => {
  try {
    const existing = getIntent(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "intent not found" });
      return;
    }
    const { row, refreshed, quoteChanged } = await maybeRefreshQuote(existing);
    res.json(
      publicIntent(row, {
        quoteRefreshed: refreshed,
        quoteChanged,
      }),
    );
  } catch (err) {
    console.error("[GET /intents/:id]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "failed to load intent",
    });
  }
});

/** Force a live re-quote for a pending USD intent (same rules as GET refresh). */
intentsRouter.post("/:id/refresh", async (req, res) => {
  try {
    const existing = getIntent(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "intent not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({ error: `intent is ${existing.status}` });
      return;
    }
    if (existing.usd_amount == null || !(existing.usd_amount > 0)) {
      res.status(400).json({
        error: "intent has no usdAmount; live quote refresh not enabled",
      });
      return;
    }
    // Bypass age gate by zeroing quoted_at temporarily via a forced path:
    // call maybeRefreshQuote after stamping quoted_at in the past.
    touchQuotedAt(
      existing.id,
      existing.price_usd ?? 0,
      Date.now() - config.quoteRefreshMs - 1,
    );
    const forced = getIntent(existing.id)!;
    const { row, refreshed, quoteChanged } = await maybeRefreshQuote(forced);
    res.json(
      publicIntent(row, {
        quoteRefreshed: refreshed,
        quoteChanged,
      }),
    );
  } catch (err) {
    console.error("[POST /intents/:id/refresh]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "refresh failed",
    });
  }
});

/** Manual confirm nudge — also used by pay.html; poller does the same work. */
intentsRouter.post("/:id/confirm", async (req, res) => {
  try {
    const row = getIntent(req.params.id);
    if (!row) {
      res.status(404).json({ error: "intent not found" });
      return;
    }
    if (row.status === "confirmed") {
      res.json(publicIntent(row));
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: `intent is ${row.status}` });
      return;
    }
    if (Date.now() > row.expires_at) {
      res.status(410).json({ error: "intent expired" });
      return;
    }

    const reference = new PublicKey(row.reference_pubkey);
    let signature = await findPaymentSignature(reference);
    let via: "reference" | "amount-fallback" = "reference";

    if (signature) {
      const ok = await validateYzyPayment({
        signature,
        amountYzy: row.amount_yzy,
        reference,
      });
      if (!ok) {
        res.status(422).json({
          error: "signature found but transfer validation failed",
          signature,
        });
        return;
      }
    } else {
      // Fallback: unique amount match among pending (same rules as poller).
      const sinceMs = Math.min(row.created_at, Date.now() - config.intentTtlMs) - 60_000;
      const transfers = await findRecentYzyInboundTransfers({ limit: 40, sinceMs });
      const pending = listPendingIntents();
      let matched: string | null = null;
      for (const transfer of transfers) {
        if (getIntentBySignature(transfer.signature)) continue;
        if (!amountWithinSlippage(transfer.amountYzy, row.amount_yzy)) continue;
        const candidates = pending.filter((p) =>
          amountWithinSlippage(transfer.amountYzy, p.amount_yzy),
        );
        if (candidates.length !== 1 || candidates[0]!.id !== row.id) continue;
        const ok = await validateYzyPayment({
          signature: transfer.signature,
          amountYzy: row.amount_yzy,
        });
        if (!ok) continue;
        matched = transfer.signature;
        break;
      }
      if (!matched) {
        res.json({ ...publicIntent(row), checked: true, found: false });
        return;
      }
      signature = matched;
      via = "amount-fallback";
    }

    const claimed = tryMarkConfirmed(row.id, signature);
    if (!claimed) {
      const latest = getIntent(row.id)!;
      res.json({ ...publicIntent(latest), checked: true, found: latest.status === "confirmed" });
      return;
    }
    const done = await annotateDraftPaid(row.shopify_draft_order_id ?? "", signature);
  if (done?.orderName || done?.orderStatusUrl) {
    updateShopifyOrder(row.id, done.orderName ?? null, done.orderStatusUrl ?? null);
  }
    const updated = getIntent(row.id)!;
    res.json({ ...publicIntent(updated), checked: true, found: true, via });
  } catch (err) {
    console.error("[POST /intents/:id/confirm]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "confirm failed",
    });
  }
});
