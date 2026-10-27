/**
 * USD → YzY via DexScreener with liquidity floor + deviation circuit breaker.
 *
 * - Pick highest-liquidity pair that clears MIN_PAIR_LIQUIDITY_USD.
 * - Keep a short in-memory history of accepted mid prices; reject spots that
 *   move more than MAX_PRICE_DEVIATION_BPS vs the median of that history.
 * - Convert USD using a light TWAP (mean of recent accepted mids).
 * - On first boot (empty history), accept the first good spot and seed history.
 */
import { config } from "./config.js";

export interface YzyQuote {
  priceUsd: number;
  /** Spot mid from the chosen DexScreener pair (pre-TWAP). */
  spotPriceUsd: number;
  amountYzy: number;
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  usdAmount: number;
  fetchedAt: number;
  /** How the conversion price was derived. */
  pricing: "spot" | "twap";
  historySize: number;
}

export type QuoteFailCode =
  | "dex_unavailable"
  | "no_liquid_pair"
  | "invalid_price"
  | "price_deviation";

export type QuoteResult =
  | { ok: true; quote: YzyQuote }
  | {
      ok: false;
      code: QuoteFailCode;
      message: string;
      spotPriceUsd?: number;
      referencePriceUsd?: number;
      deviationBps?: number;
    };

interface HistorySample {
  priceUsd: number;
  at: number;
}

/** Module-scoped; fine for a single Railway replica. */
const priceHistory: HistorySample[] = [];

/** @internal test/reset helper */
export function _resetPriceHistoryForTests(): void {
  priceHistory.length = 0;
}

/** @internal test helper */
export function _seedPriceHistoryForTests(
  prices: number[],
  at = Date.now(),
): void {
  priceHistory.length = 0;
  for (const p of prices) priceHistory.push({ priceUsd: p, at });
}

function pruneHistory(now: number): HistorySample[] {
  const cutoff = now - config.priceHistoryMs;
  const kept = priceHistory.filter((s) => s.at >= cutoff);
  priceHistory.length = 0;
  priceHistory.push(...kept);
  return priceHistory;
}

function median(nums: number[]): number {
  if (!nums.length) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function mean(nums: number[]): number {
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function deviationBps(spot: number, reference: number): number {
  if (!(reference > 0)) return Infinity;
  return Math.abs(spot - reference) / reference * 10_000;
}

export interface SpotPair {
  priceUsd: number;
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
}

/**
 * Fetch DexScreener pairs and return the best that clears the liquidity floor.
 */
export async function fetchYzySpotPair(
  mint = config.yzyMint.toBase58(),
): Promise<
  | { ok: true; pair: SpotPair }
  | { ok: false; code: "dex_unavailable" | "no_liquid_pair" | "invalid_price"; message: string }
> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    return {
      ok: false,
      code: "dex_unavailable",
      message: `DexScreener fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "dex_unavailable",
      message: `DexScreener HTTP ${res.status}`,
    };
  }
  const json = (await res.json()) as {
    pairs?: {
      priceUsd?: string;
      pairAddress?: string;
      dexId?: string;
      liquidity?: { usd?: number };
    }[];
  };

  const floor = config.minPairLiquidityUsd;
  const floorEnabled = Number.isFinite(floor) && floor > 0;
  const eligible = (json.pairs ?? [])
    .map((p) => ({
      priceUsd: Number(p.priceUsd),
      pairAddress: p.pairAddress ?? "",
      dexId: p.dexId ?? "",
      liquidityUsd: Number(p.liquidity?.usd ?? 0),
    }))
    .filter((p) => {
      if (!(Number.isFinite(p.priceUsd) && p.priceUsd > 0)) return false;
      if (!Number.isFinite(p.liquidityUsd)) return false;
      if (floorEnabled && p.liquidityUsd < floor) return false;
      return true;
    })
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  if (!eligible.length) {
    return {
      ok: false,
      code: "no_liquid_pair",
      message: floorEnabled
        ? `No DexScreener pair with ≥ $${floor} USD liquidity for this mint`
        : "No DexScreener pair with a usable YzY price for this mint",
    };
  }
  const best = eligible[0]!;
  if (!(best.priceUsd > 0) || !Number.isFinite(best.priceUsd)) {
    return {
      ok: false,
      code: "invalid_price",
      message: "DexScreener returned a non-positive price",
    };
  }
  return { ok: true, pair: best };
}

/** @deprecated prefer fetchYzySpotPair; kept for any external callers */
export async function fetchYzyPriceUsd(
  mint = config.yzyMint.toBase58(),
): Promise<{ priceUsd: number; pairAddress: string; dexId: string } | null> {
  const r = await fetchYzySpotPair(mint);
  if (!r.ok) return null;
  return {
    priceUsd: r.pair.priceUsd,
    pairAddress: r.pair.pairAddress,
    dexId: r.pair.dexId,
  };
}

/** Convert USD to YzY token amount (UI units, not raw). Rounds up to 6 decimals. */
export function usdToYzy(usdAmount: number, priceUsd: number): number {
  if (!(usdAmount > 0) || !(priceUsd > 0)) {
    throw new Error("usdAmount and priceUsd must be positive");
  }
  const raw = usdAmount / priceUsd;
  const factor = 10 ** config.yzyDecimals;
  return Math.ceil(raw * factor - Number.EPSILON) / factor;
}

/**
 * Apply liquidity floor + deviation circuit breaker; return TWAP-smoothed quote.
 * Does not mutate history on reject.
 */
export function acceptSpotPrice(
  spot: SpotPair,
  now = Date.now(),
):
  | { ok: true; conversionPriceUsd: number; pricing: "spot" | "twap"; historySize: number }
  | {
      ok: false;
      code: "price_deviation";
      message: string;
      spotPriceUsd: number;
      referencePriceUsd: number;
      deviationBps: number;
    } {
  const hist = pruneHistory(now);
  const prices = hist.map((s) => s.priceUsd);

  if (prices.length > 0) {
    const ref = median(prices);
    const dev = deviationBps(spot.priceUsd, ref);
    if (dev > config.maxPriceDeviationBps) {
      return {
        ok: false,
        code: "price_deviation",
        message: `YzY spot $${spot.priceUsd} moved ${dev.toFixed(0)} bps vs median $${ref.toFixed(8)} (max ${config.maxPriceDeviationBps} bps)`,
        spotPriceUsd: spot.priceUsd,
        referencePriceUsd: ref,
        deviationBps: Math.round(dev),
      };
    }
  }

  // Accept: push sample, trim to size.
  hist.push({ priceUsd: spot.priceUsd, at: now });
  while (hist.length > config.priceHistorySize) hist.shift();

  const accepted = hist.map((s) => s.priceUsd);
  if (accepted.length >= 2) {
    return {
      ok: true,
      conversionPriceUsd: mean(accepted),
      pricing: "twap",
      historySize: accepted.length,
    };
  }
  return {
    ok: true,
    conversionPriceUsd: spot.priceUsd,
    pricing: "spot",
    historySize: accepted.length,
  };
}

export async function quoteUsdInYzy(usdAmount: number): Promise<QuoteResult> {
  if (!(usdAmount > 0) || !Number.isFinite(usdAmount)) {
    return {
      ok: false,
      code: "invalid_price",
      message: "usdAmount must be positive",
    };
  }

  const spotRes = await fetchYzySpotPair();
  if (!spotRes.ok) {
    return { ok: false, code: spotRes.code, message: spotRes.message };
  }

  const accepted = acceptSpotPrice(spotRes.pair);
  if (!accepted.ok) {
    console.warn(
      `[price] circuit breaker: ${accepted.message} (pair=${spotRes.pair.pairAddress} liq=$${spotRes.pair.liquidityUsd})`,
    );
    return {
      ok: false,
      code: accepted.code,
      message: accepted.message,
      spotPriceUsd: accepted.spotPriceUsd,
      referencePriceUsd: accepted.referencePriceUsd,
      deviationBps: accepted.deviationBps,
    };
  }

  const priceUsd = accepted.conversionPriceUsd;
  return {
    ok: true,
    quote: {
      priceUsd,
      spotPriceUsd: spotRes.pair.priceUsd,
      amountYzy: usdToYzy(usdAmount, priceUsd),
      pairAddress: spotRes.pair.pairAddress,
      dexId: spotRes.pair.dexId,
      liquidityUsd: spotRes.pair.liquidityUsd,
      usdAmount,
      fetchedAt: Date.now(),
      pricing: accepted.pricing,
      historySize: accepted.historySize,
    },
  };
}
