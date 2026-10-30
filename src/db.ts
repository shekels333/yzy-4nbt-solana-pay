import Database from "better-sqlite3";
import { config } from "./config.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.dbPath), { recursive: true });

export type IntentStatus = "pending" | "confirmed" | "expired" | "failed";

export interface IntentRow {
  id: string;
  status: IntentStatus;
  variant_id: string;
  quantity: number;
  email: string;
  shipping_json: string;
  amount_yzy: number;
  /** When set, pending intents re-quote USD→YzY on refresh. */
  usd_amount: number | null;
  price_usd: number | null;
  quoted_at: number | null;
  reference_pubkey: string;
  reference_secret: string;
  solana_pay_url: string;
  shopify_draft_order_id: string | null;
  shopify_draft_order_name: string | null;
  signature: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  shopify_order_name?: string | null;
  order_status_url?: string | null;
}

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    email TEXT NOT NULL,
    shipping_json TEXT NOT NULL,
    amount_yzy REAL NOT NULL,
    reference_pubkey TEXT NOT NULL UNIQUE,
    reference_secret TEXT NOT NULL,
    solana_pay_url TEXT NOT NULL,
    shopify_draft_order_id TEXT,
    shopify_draft_order_name TEXT,
    signature TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
`);

/** Additive columns for live USD→YzY refresh (safe on existing DBs). */
function ensureColumn(name: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(intents)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE intents ADD COLUMN ${ddl}`);
  }
}
ensureColumn("usd_amount", "usd_amount REAL");
ensureColumn("price_usd", "price_usd REAL");
ensureColumn("quoted_at", "quoted_at INTEGER");
ensureColumn("shopify_order_name", "shopify_order_name TEXT");
ensureColumn("order_status_url", "order_status_url TEXT");

/** One confirmed intent per on-chain signature (NULLs allowed for pending). */
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_signature_unique
   ON intents(signature) WHERE signature IS NOT NULL`,
);

export function insertIntent(row: IntentRow): void {
  db.prepare(
    `INSERT INTO intents (
      id, status, variant_id, quantity, email, shipping_json, amount_yzy,
      usd_amount, price_usd, quoted_at,
      reference_pubkey, reference_secret, solana_pay_url,
      shopify_draft_order_id, shopify_draft_order_name, signature,
      created_at, updated_at, expires_at
    ) VALUES (
      @id, @status, @variant_id, @quantity, @email, @shipping_json, @amount_yzy,
      @usd_amount, @price_usd, @quoted_at,
      @reference_pubkey, @reference_secret, @solana_pay_url,
      @shopify_draft_order_id, @shopify_draft_order_name, @signature,
      @created_at, @updated_at, @expires_at
    )`,
  ).run(row);
}

export function getIntent(id: string): IntentRow | undefined {
  return db.prepare(`SELECT * FROM intents WHERE id = ?`).get(id) as
    | IntentRow
    | undefined;
}

export function listPendingIntents(now = Date.now()): IntentRow[] {
  return db
    .prepare(
      `SELECT * FROM intents WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC`,
    )
    .all(now) as IntentRow[];
}

/**
 * Mark overdue pending intents as expired; returns the rows that transitioned
 * (for Shopify draft cleanup).
 */
export function expirePendingIntents(now = Date.now()): IntentRow[] {
  const candidates = db
    .prepare(
      `SELECT * FROM intents WHERE status = 'pending' AND expires_at <= ?`,
    )
    .all(now) as IntentRow[];
  if (!candidates.length) return [];

  const upd = db.prepare(
    `UPDATE intents SET status = 'expired', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  );
  const tx = db.transaction((rows: IntentRow[]) => {
    const out: IntentRow[] = [];
    for (const row of rows) {
      const r = upd.run(now, row.id);
      if (r.changes) out.push(row);
    }
    return out;
  });
  return tx(candidates);
}

/** @deprecated use expirePendingIntents */
export function markExpired(now = Date.now()): number {
  return expirePendingIntents(now).length;
}

export function countPendingIntents(now = Date.now()): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM intents WHERE status = 'pending' AND expires_at > ?`,
    )
    .get(now) as { n: number };
  return row?.n ?? 0;
}

export function countPendingByEmail(email: string, now = Date.now()): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM intents
       WHERE status = 'pending' AND expires_at > ? AND lower(email) = lower(?)`,
    )
    .get(now, email) as { n: number };
  return row?.n ?? 0;
}

export function getIntentBySignature(signature: string): IntentRow | undefined {
  return db
    .prepare(`SELECT * FROM intents WHERE signature = ?`)
    .get(signature) as IntentRow | undefined;
}

/**
 * Atomically claim a pending intent with this signature.
 * Fails (returns false) if intent is not pending, or signature already used.
 */
export function tryMarkConfirmed(
  id: string,
  signature: string,
  now = Date.now(),
): boolean {
  if (getIntentBySignature(signature)) return false;
  const r = db
    .prepare(
      `UPDATE intents SET status = 'confirmed', signature = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM intents WHERE signature = ? AND id != ?
         )`,
    )
    .run(signature, now, id, signature, id);
  return r.changes > 0;
}

/** @deprecated prefer tryMarkConfirmed for race-safe claiming */
export function markConfirmed(
  id: string,
  signature: string,
  now = Date.now(),
): void {
  tryMarkConfirmed(id, signature, now);
}

/** Record the completed Shopify order (name + customer order-status page). */
export function updateShopifyOrder(
  id: string,
  orderName: string | null,
  orderStatusUrl: string | null,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE intents SET shopify_order_name = ?, order_status_url = ?, updated_at = ? WHERE id = ?`,
  ).run(orderName, orderStatusUrl, now, id);
}

export function updateShopifyDraft(
  id: string,
  draftOrderId: string,
  draftOrderName: string,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE intents SET shopify_draft_order_id = ?, shopify_draft_order_name = ?, updated_at = ? WHERE id = ?`,
  ).run(draftOrderId, draftOrderName, now, id);
}

/** Update amount + Solana Pay URL + reference for a still-pending intent. */
export function updatePendingQuote(
  id: string,
  fields: {
    amountYzy: number;
    priceUsd: number;
    quotedAt: number;
    referencePubkey: string;
    referenceSecret: string;
    solanaPayUrl: string;
  },
  now = Date.now(),
): IntentRow | undefined {
  const r = db
    .prepare(
      `UPDATE intents SET
         amount_yzy = ?,
         price_usd = ?,
         quoted_at = ?,
         reference_pubkey = ?,
         reference_secret = ?,
         solana_pay_url = ?,
         updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(
      fields.amountYzy,
      fields.priceUsd,
      fields.quotedAt,
      fields.referencePubkey,
      fields.referenceSecret,
      fields.solanaPayUrl,
      now,
      id,
    );
  if (!r.changes) return undefined;
  return getIntent(id);
}

/** Touch quoted_at when re-quote yields the same amount (no reference churn). */
export function touchQuotedAt(
  id: string,
  priceUsd: number,
  quotedAt: number,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE intents SET price_usd = ?, quoted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(priceUsd, quotedAt, now, id);
}
