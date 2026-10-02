import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage, retryWithBackoff } from "../shared";
import { parseTimestamp } from "../transaction/exportTransactionHistory";

export type ActivityPeriod = "24h" | "7d" | "30d";

export interface AssetActivity {
  assetCode: string;
  assetIssuer: string | null;
  amountIn: string;
  amountOut: string;
  count: number;
}

/** Aggregated activity with a single counterparty account over the requested window. */
export interface CounterpartyActivity {
  /** G-address of the counterparty */
  publicKey: string;
  /** Number of payment operations exchanged with this counterparty */
  count: number;
  /** Total amount received from this counterparty across all assets (numeric string) */
  amountIn: string;
  /** Total amount sent to this counterparty across all assets (numeric string) */
  amountOut: string;
}

export interface AccountActivitySummary {
  publicKey: string;
  /** Predefined period, or "custom" when startDate/endDate were provided */
  period: ActivityPeriod | "custom";
  /** Resolved start of the aggregation window (ISO 8601) */
  startDate: string;
  /** Resolved end of the aggregation window (ISO 8601) */
  endDate: string;
  transactionCount: number;
  successfulTransactionCount: number;
  failedTransactionCount: number;
  totalAmountIn: string;
  totalAmountOut: string;
  /** Average payment amount across all in/out payment operations in the window (numeric string), "0" when no payments occurred */
  averageTransactionSize: string;
  topAssets: AssetActivity[];
  /** Counterparties with the most payment activity, sorted by operation count descending */
  topCounterparties: CounterpartyActivity[];
}

/** Options for {@link getAccountActivitySummary}. */
export interface GetAccountActivitySummaryOptions {
  /**
   * Custom window start (inclusive). When provided together with `endDate`,
   * overrides `period` entirely and the resolved `period` becomes `"custom"`.
   */
  startDate?: string | Date;
  /** Custom window end (inclusive). Must be provided alongside `startDate`. */
  endDate?: string | Date;
  /** Maximum number of top counterparties to return (default: 5). */
  topCounterpartiesLimit?: number;
  /** Cache TTL in milliseconds for this query (default: 1 hour). */
  cacheTtlMs?: number;
  /** Bypass the cache and force a fresh Horizon query. */
  skipCache?: boolean;
}

/** Default cache TTL for activity summaries: 1 hour. */
export const DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_TOP_COUNTERPARTIES_LIMIT = 5;

function getPeriodMs(period: ActivityPeriod): number {
  switch (period) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

interface ActivitySummaryCacheEntry {
  summary: AccountActivitySummary;
  expiresAt: number;
}

/**
 * Module-level cache of recent activity summaries, keyed by account + period
 * or account + resolved date range.
 */
const activitySummaryCache = new Map<string, ActivitySummaryCacheEntry>();

/** Clear the module-level activity summary cache. Intended for tests. */
export function clearAccountActivitySummaryCache(): void {
  activitySummaryCache.clear();
}

/**
 * Fetch and aggregate activity summary for an account over a specified period,
 * or over an arbitrary custom date range.
 *
 * When `options.startDate`/`options.endDate` are both provided, they take
 * precedence over `period` and the resolved summary's `period` field is
 * `"custom"`. Otherwise, one of the predefined trailing windows (`period`)
 * is used, ending at the current time.
 *
 * Completed summaries are cached in-memory by account + resolved date range
 * for a configurable TTL (default 1 hour) to avoid repeated Horizon queries
 * for the same window.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey Account G-address
 * @param period Timeframe window: '24h', '7d', or '30d' (default: '24h'). Ignored when a custom date range is supplied.
 * @param options Custom date range, top-counterparties limit, and cache controls.
 * @returns Summary containing transaction counts, volume in/out, average size, top assets, and top counterparties
 */
export async function getAccountActivitySummary(
  horizonUrl: string,
  publicKey: string,
  period: ActivityPeriod = "24h",
  options?: GetAccountActivitySummaryOptions,
): Promise<SorokitResult<AccountActivitySummary>> {
  if (!publicKey || typeof publicKey !== "string") {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid account address: ${publicKey}`,
    );
  }

  const hasCustomRange = options?.startDate !== undefined || options?.endDate !== undefined;
  let startTime: number;
  let endTime: number;
  let resolvedPeriod: ActivityPeriod | "custom";

  if (hasCustomRange) {
    if (options?.startDate === undefined || options?.endDate === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Both startDate and endDate must be provided together for a custom activity summary range.",
      );
    }
    const parsedStart = parseTimestamp(options.startDate);
    const parsedEnd = parseTimestamp(options.endDate);
    if (parsedStart === undefined || parsedEnd === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "startDate and endDate must be valid dates.",
      );
    }
    if (parsedStart > parsedEnd) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `startDate (${new Date(parsedStart).toISOString()}) must not be after endDate (${new Date(parsedEnd).toISOString()}).`,
      );
    }
    startTime = parsedStart;
    endTime = parsedEnd;
    resolvedPeriod = "custom";
  } else {
    endTime = Date.now();
    startTime = endTime - getPeriodMs(period);
    resolvedPeriod = period;
  }

  const topCounterpartiesLimit = options?.topCounterpartiesLimit ?? DEFAULT_TOP_COUNTERPARTIES_LIMIT;
  const cacheKey = JSON.stringify([
    horizonUrl, publicKey,
    hasCustomRange ? [startTime, endTime] : resolvedPeriod,
    topCounterpartiesLimit,
  ]);

  if (!options?.skipCache) {
    const cached = activitySummaryCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return ok(cached.summary);
    }
    if (cached) {
      activitySummaryCache.delete(cacheKey);
    }
  }

  try {
    const server = new Horizon.Server(horizonUrl);

    // Fetch operations for account ordered descending
    const opsPage = await retryWithBackoff(async () => {
      return await server
        .operations()
        .forAccount(publicKey)
        .order("desc")
        .limit(200)
        .call();
    });

    let txCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let totalInNum = 0;
    let totalOutNum = 0;
    let paymentAmountSum = 0;
    let paymentOpCount = 0;

    const assetMap = new Map<
      string,
      { code: string; issuer: string | null; amountIn: number; amountOut: number; count: number }
    >();

    const counterpartyMap = new Map<
      string,
      { publicKey: string; count: number; amountIn: number; amountOut: number }
    >();

    const seenTxHashes = new Set<string>();

    for (const op of opsPage.records) {
      const opTime = new Date(op.created_at).getTime();
      if (isNaN(opTime) || opTime < startTime || opTime > endTime) {
        continue;
      }

      if (op.transaction_successful) {
        successCount++;
      } else {
        failedCount++;
      }

      if (op.transaction_hash && !seenTxHashes.has(op.transaction_hash)) {
        seenTxHashes.add(op.transaction_hash);
        txCount++;
      }

      // Check payment operations
      if (op.type === "payment") {
        const payOp = op as any;
        const amount = parseFloat(payOp.amount || "0");
        const assetCode = payOp.asset_code || (payOp.asset_type === "native" ? "XLM" : "UNKNOWN");
        const assetIssuer = payOp.asset_issuer || null;
        const assetKey = `${assetCode}:${assetIssuer || "native"}`;

        let entry = assetMap.get(assetKey);
        if (!entry) {
          entry = {
            code: assetCode,
            issuer: assetIssuer,
            amountIn: 0,
            amountOut: 0,
            count: 0,
          };
          assetMap.set(assetKey, entry);
        }

        entry.count++;
        paymentAmountSum += amount;
        paymentOpCount++;

        const isInbound = payOp.to === publicKey;
        const isOutbound = !isInbound && (payOp.from === publicKey || payOp.source_account === publicKey);
        const counterpartyKey: string | undefined = isInbound
          ? payOp.from ?? payOp.source_account
          : isOutbound
            ? payOp.to
            : undefined;

        if (isInbound) {
          entry.amountIn += amount;
          totalInNum += amount;
        } else if (isOutbound) {
          entry.amountOut += amount;
          totalOutNum += amount;
        }

        if (counterpartyKey) {
          let cp = counterpartyMap.get(counterpartyKey);
          if (!cp) {
            cp = { publicKey: counterpartyKey, count: 0, amountIn: 0, amountOut: 0 };
            counterpartyMap.set(counterpartyKey, cp);
          }
          cp.count++;
          if (isInbound) {
            cp.amountIn += amount;
          } else {
            cp.amountOut += amount;
          }
        }
      }
    }

    const topAssets: AssetActivity[] = Array.from(assetMap.values())
      .sort((a, b) => b.count - a.count || b.amountIn + b.amountOut - (a.amountIn + a.amountOut))
      .map((item) => ({
        assetCode: item.code,
        assetIssuer: item.issuer,
        amountIn: item.amountIn.toString(),
        amountOut: item.amountOut.toString(),
        count: item.count,
      }));

    const topCounterparties: CounterpartyActivity[] = Array.from(counterpartyMap.values())
      .sort((a, b) => b.count - a.count || (b.amountIn + b.amountOut) - (a.amountIn + a.amountOut))
      .slice(0, topCounterpartiesLimit)
      .map((cp) => ({
        publicKey: cp.publicKey,
        count: cp.count,
        amountIn: cp.amountIn.toString(),
        amountOut: cp.amountOut.toString(),
      }));

    const averageTransactionSize = paymentOpCount > 0 ? (paymentAmountSum / paymentOpCount).toString() : "0";

    const summary: AccountActivitySummary = {
      publicKey,
      period: resolvedPeriod,
      startDate: new Date(startTime).toISOString(),
      endDate: new Date(endTime).toISOString(),
      transactionCount: txCount,
      successfulTransactionCount: successCount,
      failedTransactionCount: failedCount,
      totalAmountIn: totalInNum.toString(),
      totalAmountOut: totalOutNum.toString(),
      averageTransactionSize,
      topAssets,
      topCounterparties,
    };

    const ttlMs = options?.cacheTtlMs ?? DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS;
    activitySummaryCache.set(cacheKey, { summary, expiresAt: Date.now() + ttlMs });

    return ok(summary);
  } catch (cause) {
    return err(
      isNotFoundError(cause)
        ? SorokitErrorCode.ACCOUNT_NOT_FOUND
        : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : `Failed to fetch account activity summary: ${toMessage(cause)}`,
      cause,
    );
  }
}
