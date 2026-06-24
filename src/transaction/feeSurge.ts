import { Horizon } from "@stellar/stellar-sdk";
import type { SorokitCache } from "../shared/cache";

/** Number of recent transactions used to compute the median fee baseline. */
export const RECENT_TX_LIMIT = 10;

/** Current fee is a surge when it exceeds this multiple of the recent median. */
export const SURGE_MULTIPLIER = 2;

/** Client-level cache key for the recent median fee. */
export const MEDIAN_FEE_CACHE_KEY = "sorokit:recent-median-fee";

/** Default TTL for cached median fee (1 minute). */
export const MEDIAN_FEE_CACHE_TTL_MS = 60_000;

/**
 * Calculate the statistical median of a non-empty array of numbers.
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  return sorted[mid]!;
}

/**
 * Returns true when the current fee exceeds {@link SURGE_MULTIPLIER}x the median.
 */
export function isFeeSurge(currentFee: number, medianFee: number): boolean {
  return medianFee > 0 && currentFee > medianFee * SURGE_MULTIPLIER;
}

/**
 * Fetch the median fee from the last {@link RECENT_TX_LIMIT} network transactions.
 * Uses an optional client-level cache to avoid repeated Horizon requests.
 * Returns null when history is unavailable.
 */
export async function fetchRecentMedianFee(
  horizonUrl: string,
  cache?: SorokitCache,
): Promise<number | null> {
  const cached = cache?.get(MEDIAN_FEE_CACHE_KEY);
  if (typeof cached === "number" && cached > 0) {
    return cached;
  }

  try {
    const server = new Horizon.Server(horizonUrl);
    const page = await server
      .transactions()
      .order("desc")
      .limit(RECENT_TX_LIMIT)
      .call();

    if (page.records.length === 0) return null;

    const fees = page.records
      .map((tx) => parseInt(String(tx.fee_charged), 10))
      .filter((fee) => !Number.isNaN(fee) && fee > 0);

    if (fees.length === 0) return null;

    const median = calculateMedian(fees);
    cache?.set(MEDIAN_FEE_CACHE_KEY, median, MEDIAN_FEE_CACHE_TTL_MS);
    return median;
  } catch {
    return null;
  }
}
