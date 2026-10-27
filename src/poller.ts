import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import {
  expirePendingIntents,
  getIntent,
  getIntentBySignature,
  listPendingIntents,
  tryMarkConfirmed,
  type IntentRow,
} from "./db.js";
import { annotateDraftPaid, cancelOpenDraftOrder } from "./shopify.js";
import {
  amountWithinSlippage,
  findPaymentSignature,
  findRecentYzyInboundTransfers,
  validateYzyPayment,
} from "./solana.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function confirmIntent(
  row: IntentRow,
  signature: string,
  via: "reference" | "amount-fallback",
): Promise<boolean> {
  const claimed = tryMarkConfirmed(row.id, signature);
  if (!claimed) {
    console.warn(
      `[poller] skip claim intent=${row.id} sig=${signature} via=${via} (race or already claimed)`,
    );
    return false;
  }
  await annotateDraftPaid(row.shopify_draft_order_id ?? "", signature);
  const updated = getIntent(row.id);
  console.info(
    `[poller] confirmed intent ${row.id} via=${via} draft=${updated?.shopify_draft_order_name} sig=${signature}`,
  );
  return true;
}

/** Primary path: Solana Pay reference key in the transaction. */
async function matchByReference(pending: IntentRow[]): Promise<Set<string>> {
  const confirmedIds = new Set<string>();
  for (const row of pending) {
    try {
      const reference = new PublicKey(row.reference_pubkey);
      const signature = await findPaymentSignature(reference);
      if (!signature) continue;

      const ok = await validateYzyPayment({
        signature,
        amountYzy: row.amount_yzy,
        reference,
      });
      if (!ok) {
        console.warn(
          `[poller] invalid transfer for intent ${row.id} sig=${signature}`,
        );
        continue;
      }

      if (await confirmIntent(row, signature, "reference")) {
        confirmedIds.add(row.id);
      }
    } catch (err) {
      console.error(`[poller] intent ${row.id}`, err);
    }
  }
  return confirmedIds;
}

/**
 * Fallback: exact YzY SPL credit to merchant with NO reliance on reference.
 * Only claims when exactly one pending intent matches the transfer amount
 * within ±SLIPPAGE_BPS. Ambiguous (0 or 2+) → skip.
 */
async function matchByUniqueAmount(pending: IntentRow[]): Promise<void> {
  if (!pending.length) return;

  const oldestCreated = Math.min(...pending.map((p) => p.created_at));
  // Slight buffer before oldest pending / TTL so late-indexed blocks still match.
  const sinceMs = Math.min(oldestCreated, Date.now() - config.intentTtlMs) - 60_000;

  let transfers;
  try {
    transfers = await findRecentYzyInboundTransfers({ limit: 40, sinceMs });
  } catch (err) {
    console.error("[poller] amount-fallback: fetch inbound failed", err);
    return;
  }

  // Fresh pending set (reference pass may have claimed some).
  let stillPending = listPendingIntents();
  if (!stillPending.length) return;

  for (const transfer of transfers) {
    if (getIntentBySignature(transfer.signature)) continue;

    const candidates = stillPending.filter((row) =>
      amountWithinSlippage(transfer.amountYzy, row.amount_yzy),
    );

    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      console.warn(
        `[poller] amount-fallback AMBIGUOUS sig=${transfer.signature} amount=${transfer.amountYzy} matches=${candidates.length} intents=${candidates.map((c) => c.id).join(",")}` +
          ` — skip (need Solana Pay reference)`,
      );
      continue;
    }

    const row = candidates[0]!;
    try {
      const ok = await validateYzyPayment({
        signature: transfer.signature,
        amountYzy: row.amount_yzy,
        // no reference — wallet omitted Solana Pay reference keys
      });
      if (!ok) {
        console.warn(
          `[poller] amount-fallback validate failed intent=${row.id} sig=${transfer.signature}`,
        );
        continue;
      }

      if (await confirmIntent(row, transfer.signature, "amount-fallback")) {
        stillPending = stillPending.filter((p) => p.id !== row.id);
      }
    } catch (err) {
      console.error(
        `[poller] amount-fallback intent=${row.id} sig=${transfer.signature}`,
        err,
      );
    }
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = expirePendingIntents();
    if (expired.length) {
      console.info(`[poller] expired ${expired.length} intent(s)`);
      for (const row of expired) {
        const draftId = row.shopify_draft_order_id;
        if (!draftId) continue;
        try {
          const result = await cancelOpenDraftOrder(draftId);
          if (result === "deleted") {
            console.info(
              `[poller] GC draft ${row.shopify_draft_order_name ?? draftId} for expired intent ${row.id}`,
            );
          }
        } catch (err) {
          console.error(
            `[poller] draft GC failed intent=${row.id} draft=${draftId}`,
            err,
          );
        }
      }
    }

    const pending = listPendingIntents();
    await matchByReference(pending);
    // Re-list so fallback never races a reference claim from this tick.
    const remaining = listPendingIntents();
    await matchByUniqueAmount(remaining);
  } finally {
    running = false;
  }
}

export function startPoller(): void {
  if (timer) return;
  console.info(
    `[poller] starting every ${config.pollIntervalMs}ms (RPC ${config.solanaRpcUrl}); reference primary, unique-amount fallback`,
  );
  void tick();
  timer = setInterval(() => {
    void tick();
  }, config.pollIntervalMs);
}

export function stopPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
