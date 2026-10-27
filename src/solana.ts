import {
  Connection,
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  encodeURL,
  findReference,
  validateTransfer,
} from "@solana/pay";
import BigNumber from "bignumber.js";
import { config } from "./config.js";

export const connection = new Connection(config.solanaRpcUrl, "confirmed");

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Merchant's associated token account for the YzY mint. */
export function merchantYzyAta(): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      config.merchantWallet.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      config.yzyMint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

export function createReference(): Keypair {
  return Keypair.generate();
}

export function buildSolanaPayUrl(opts: {
  amountYzy: number;
  reference: PublicKey;
  label?: string;
  message?: string;
}): string {
  const url = encodeURL({
    recipient: config.merchantWallet,
    amount: new BigNumber(opts.amountYzy),
    splToken: config.yzyMint,
    reference: opts.reference,
    label: opts.label ?? config.label,
    message: opts.message ?? config.message,
  });
  return url.toString();
}

export async function findPaymentSignature(
  reference: PublicKey,
): Promise<string | null> {
  try {
    const sigInfo = await findReference(connection, reference, {
      finality: "confirmed",
    });
    return sigInfo.signature;
  } catch (err: unknown) {
    const name =
      err && typeof err === "object" && "name" in err
        ? (err as { name: string }).name
        : "";
    // FindReferenceError when not found yet
    if (name === "FindReferenceError") return null;
    throw err;
  }
}

function minAmountForSlippage(amountYzy: number, slippageBps: number): number {
  const slip = Math.max(0, slippageBps) / 10_000;
  const minAmount = amountYzy * (1 - slip);
  const factor = 10 ** config.yzyDecimals;
  return Math.floor(minAmount * factor) / factor;
}

/**
 * Validate SPL transfer for expected amount within ±SLIPPAGE_BPS.
 * @solana/pay validateTransfer only enforces transferred >= amount, so we
 * pass amount = expected * (1 - slip) to allow slight underpayment. Overpay
 * is always accepted (merchant-favorable) on the reference path.
 * When `reference` is omitted, reference keys are not checked (no-ref fallback).
 */
export async function validateYzyPayment(opts: {
  signature: string;
  amountYzy: number;
  reference?: PublicKey;
  slippageBps?: number;
}): Promise<boolean> {
  const bps = opts.slippageBps ?? config.slippageBps;
  const minRounded = minAmountForSlippage(opts.amountYzy, bps);
  try {
    await validateTransfer(
      connection,
      opts.signature,
      {
        recipient: config.merchantWallet,
        amount: new BigNumber(minRounded > 0 ? minRounded : opts.amountYzy),
        splToken: config.yzyMint,
        ...(opts.reference ? { reference: opts.reference } : {}),
      },
      { commitment: "confirmed" },
    );
    return true;
  } catch (err) {
    console.warn("[solana] validateTransfer failed", err);
    return false;
  }
}

/** True if `actual` is within ±slippageBps of `expected` (both bounds). */
export function amountWithinSlippage(
  actual: number,
  expected: number,
  slippageBps = config.slippageBps,
): boolean {
  if (!(expected > 0) || !(actual > 0)) return false;
  const slip = Math.max(0, slippageBps) / 10_000;
  const lo = expected * (1 - slip);
  const hi = expected * (1 + slip);
  return actual + Number.EPSILON >= lo && actual - Number.EPSILON <= hi;
}

export interface YzyInboundTransfer {
  signature: string;
  /** Human YzY amount credited to merchant (token decimals). */
  amountYzy: number;
  /** Unix ms of block time when known. */
  blockTimeMs: number | null;
}

/**
 * Extract net YzY amount received by MERCHANT_WALLET from a parsed tx.
 * Uses pre/post token balances (owner + mint). Returns null if none / error.
 */
export function extractMerchantYzyReceived(
  tx: ParsedTransactionWithMeta,
): number | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const mint = config.yzyMint.toBase58();
  const owner = config.merchantWallet.toBase58();

  const preMap = new Map<string, number>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint !== mint || b.owner !== owner) continue;
    const ui = b.uiTokenAmount?.uiAmount;
    if (typeof ui === "number") preMap.set(String(b.accountIndex), ui);
  }

  let received = 0;
  let saw = false;
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || b.owner !== owner) continue;
    const ui = b.uiTokenAmount?.uiAmount;
    if (typeof ui !== "number") continue;
    const pre = preMap.get(String(b.accountIndex)) ?? 0;
    const delta = ui - pre;
    if (delta > 0) {
      received += delta;
      saw = true;
    }
  }
  if (!saw || !(received > 0)) return null;
  return received;
}

/**
 * Recent confirmed YzY SPL credits to the merchant ATA (newest first).
 * Used as no-reference fallback matching input. Caps lookback by signature count.
 */
export async function findRecentYzyInboundTransfers(opts?: {
  limit?: number;
  /** Only include txs at/after this unix ms (inclusive). */
  sinceMs?: number;
}): Promise<YzyInboundTransfer[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 100);
  const ata = merchantYzyAta();
  const sigInfos = await connection.getSignaturesForAddress(ata, {
    limit,
  });

  const out: YzyInboundTransfer[] = [];
  for (const info of sigInfos) {
    if (info.err) continue;
    const blockTimeMs =
      typeof info.blockTime === "number" ? info.blockTime * 1000 : null;
    if (
      opts?.sinceMs != null &&
      blockTimeMs != null &&
      blockTimeMs < opts.sinceMs
    ) {
      // sigs are newest-first; older ones can stop early
      break;
    }
    const tx = await connection.getParsedTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) continue;
    const amountYzy = extractMerchantYzyReceived(tx);
    if (amountYzy == null) continue;
    out.push({
      signature: info.signature,
      amountYzy,
      blockTimeMs,
    });
  }
  return out;
}
