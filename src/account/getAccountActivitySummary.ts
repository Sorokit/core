import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage, retryWithBackoff } from "../shared";
import type { SorokitCache } from "../shared/cache";
import { createHorizonServer } from "../shared/serverFactory";

export type ActivityPeriod = "24h" | "7d" | "30d";

export interface AssetActivity {
  assetCode: string;
  assetIssuer: string | null;
  amountIn: string;
  amountOut: string;
  count: number;
}

export interface AccountActivitySummary {
  publicKey: string;
  period: ActivityPeriod | "custom";
  transactionCount: number;
  successfulTransactionCount: number;
  failedTransactionCount: number;
  totalAmountIn: string;
  totalAmountOut: string;
  topAssets: AssetActivity[];
  /**
   * Average amount per payment operation (inbound + outbound combined),
   * as a decimal string. `"0"` when no payment operations were observed.
   */
  averageTransactionSize: string;
  /**
   * Top counterparty accounts by payment operation count, most-frequent
   * first (issue #399). Present whenever at least one payment counterparty
   * was observed.
   */
  topCounterparties: CounterpartyActivity[];
  /** ISO 8601 boundaries actually applied for this summary. */
  range: { startDate: string; endDate: string };
}

export interface CounterpartyActivity {
  publicKey: string;
  /** Number of payment operations exchanged with this counterparty. */
  count: number;
  amountIn: string;
  amountOut: string;
}

/**
 * Options for a custom-range activity summary (issue #399). Provide either
 * `period` (a predefined window, default `"24h"`) or an explicit
 * `startDate`/`endDate` pair — not both. An explicit range takes precedence
 * if both happen to be supplied.
 */
export interface AccountActivitySummaryOptions {
  /** Predefined window; ignored when `startDate`/`endDate` are provided. */
  period?: ActivityPeriod;
  /** Inclusive lower bound of the custom range (ISO 8601 or Date). */
  startDate?: string | Date;
  /** Inclusive upper bound of the custom range (ISO 8601 or Date). */
  endDate?: string | Date;
  /** How many top counterparties to return (default 5, max 50). */
  topCounterpartyLimit?: number;
  /** Cache for memoising completed summaries, keyed by account + range. */
  cache?: SorokitCache;
  /** Cache TTL in milliseconds (default: 1 hour, per issue #399). */
  cacheTtlMs?: number;
}

/** Default number of top counterparties returned. */
const DEFAULT_TOP_COUNTERPARTY_LIMIT = 5;
/** Hard ceiling on requested top-counterparty count, to bound response size. */
const MAX_TOP_COUNTERPARTY_LIMIT = 50;
/** Default cache TTL for completed summaries: 1 hour (issue #399). */
export const DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS = 60 * 60 * 1000;
/** Operations fetched per Horizon page while paginating a custom range. */
const OPERATIONS_PAGE_SIZE = 200;
/** Hard ceiling on total operations scanned per summary, to bound cost on very active accounts. */
const MAX_OPERATIONS_SCANNED = 10_000;

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

/** Parse a Date | ISO-string boundary; returns null if invalid. */
function parseBoundary(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function buildCacheKey(
  publicKey: string,
  startMs: number,
  endMs: number,
): string {
  return `sorokit:account-activity:${publicKey}:${startMs}:${endMs}`;
}

/**
 * Fetch and aggregate activity summary for an account over a specified
 * period, or an explicit custom date range (issue #399).
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey Account G-address
 * @param options Predefined `period` ("24h" | "7d" | "30d", default "24h"),
 *   or an explicit `startDate`/`endDate` range, plus optional caching.
 *   For backward compatibility, a bare `ActivityPeriod` string may also be
 *   passed instead of an options object.
 * @returns Summary containing transaction counts, volume in/out, average
 *   transaction size, top asset activity, and top counterparties.
 *
 * @example
 * // Predefined period (unchanged behaviour)
 * const result = await getAccountActivitySummary(horizonUrl, publicKey, "7d");
 *
 * @example
 * // Custom billing-cycle range, cached for an hour
 * const result = await getAccountActivitySummary(horizonUrl, publicKey, {
 *   startDate: "2026-08-01T00:00:00Z",
 *   endDate: "2026-08-31T23:59:59Z",
 *   cache,
 * });
 */
export async function getAccountActivitySummary(
  horizonUrl: string,
  publicKey: string,
  options: ActivityPeriod | AccountActivitySummaryOptions = "24h",
): Promise<SorokitResult<AccountActivitySummary>> {
  if (!publicKey || typeof publicKey !== "string") {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid account address: ${publicKey}`,
    );
  }

  const normalizedOptions: AccountActivitySummaryOptions =
    typeof options === "string" ? { period: options } : options;

  const {
    period = "24h",
    startDate,
    endDate,
    topCounterpartyLimit = DEFAULT_TOP_COUNTERPARTY_LIMIT,
    cache,
    cacheTtlMs = DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS,
  } = normalizedOptions;

  const isCustomRange = startDate !== undefined || endDate !== undefined;

  let startMs: number;
  let endMs: number;
  let resultPeriod: ActivityPeriod | "custom";

  if (isCustomRange) {
    if (startDate === undefined || endDate === undefined) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Both startDate and endDate must be provided together for a custom activity range.",
      );
    }
    const start = parseBoundary(startDate);
    const end = parseBoundary(endDate);
    if (!start || !end) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid date range: startDate=${String(startDate)}, endDate=${String(endDate)}`,
      );
    }
    if (start.getTime() > end.getTime()) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid date range: startDate (${start.toISOString()}) must not be after endDate (${end.toISOString()}).`,
      );
    }
    startMs = start.getTime();
    endMs = end.getTime();
    resultPeriod = "custom";
  } else {
    endMs = Date.now();
    startMs = endMs - getPeriodMs(period);
    resultPeriod = period;
  }

  const clampedTopCounterpartyLimit = Math.max(
    1,
    Math.min(topCounterpartyLimit, MAX_TOP_COUNTERPARTY_LIMIT),
  );

  const cacheKey = buildCacheKey(publicKey, startMs, endMs);
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached != null) return ok(cached as AccountActivitySummary);
  }

  try {
    const server = createHorizonServer(horizonUrl);

    let txCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let totalInNum = 0;
    let totalOutNum = 0;

    const assetMap = new Map<
      string,
      { code: string; issuer: string | null; amountIn: number; amountOut: number; count: number }
    >();
    const counterpartyMap = new Map<
      string,
      { amountIn: number; amountOut: number; count: number }
    >();
    const seenTxHashes = new Set<string>();

    let scanned = 0;
    let cursor: string | undefined;
    let stopPaging = false;

    // Page backwards through operations until we pass the window's start
    // boundary, the account has no more history, or the scan cap is hit.
    // A predefined period never needs more than one page in practice
    // (bounded by the existing 200-record limit), but a custom range can
    // span far more operations, hence the pagination loop.
    while (!stopPaging && scanned < MAX_OPERATIONS_SCANNED) {
      const opsPage = await retryWithBackoff(async () => {
        let call = server
          .operations()
          .forAccount(publicKey)
          .order("desc")
          .limit(OPERATIONS_PAGE_SIZE);
        if (cursor) {
          call = call.cursor(cursor);
        }
        return await call.call();
      });

      if (opsPage.records.length === 0) {
        break;
      }

      for (const op of opsPage.records) {
        scanned++;
        const opTime = new Date(op.created_at).getTime();
        if (isNaN(opTime)) {
          continue;
        }
        if (opTime < startMs) {
          // Operations are ordered descending by time, so once we're past
          // the window's start we will never see an in-range op again.
          stopPaging = true;
          break;
        }
        if (opTime > endMs) {
          // Newer than the requested window (only possible for a custom
          // range whose endDate is in the past) — skip without counting.
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

        if (op.type === "payment") {
          const payOp = op as any;
          const amount = parseFloat(payOp.amount || "0");
          const assetCode =
            payOp.asset_code || (payOp.asset_type === "native" ? "XLM" : "UNKNOWN");
          const assetIssuer = payOp.asset_issuer || null;
          const assetKey = `${assetCode}:${assetIssuer || "native"}`;

          let entry = assetMap.get(assetKey);
          if (!entry) {
            entry = { code: assetCode, issuer: assetIssuer, amountIn: 0, amountOut: 0, count: 0 };
            assetMap.set(assetKey, entry);
          }
          entry.count++;

          const isInbound = payOp.to === publicKey;
          const isOutbound =
            payOp.from === publicKey || payOp.source_account === publicKey;

          if (isInbound) {
            entry.amountIn += amount;
            totalInNum += amount;
          } else if (isOutbound) {
            entry.amountOut += amount;
            totalOutNum += amount;
          }

          const counterparty = isInbound
            ? payOp.from || payOp.source_account
            : isOutbound
              ? payOp.to
              : undefined;

          if (counterparty && counterparty !== publicKey) {
            let cp = counterpartyMap.get(counterparty);
            if (!cp) {
              cp = { amountIn: 0, amountOut: 0, count: 0 };
              counterpartyMap.set(counterparty, cp);
            }
            cp.count++;
            if (isInbound) cp.amountIn += amount;
            else if (isOutbound) cp.amountOut += amount;
          }
        }
      }

      if (stopPaging) break;

      const nextCursor = opsPage.records.at(-1)?.paging_token;
      if (!nextCursor || nextCursor === cursor) {
        // No further pages available.
        break;
      }
      cursor = nextCursor;
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

    const topCounterparties: CounterpartyActivity[] = Array.from(
      counterpartyMap.entries(),
    )
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, clampedTopCounterpartyLimit)
      .map(([counterpartyPublicKey, item]) => ({
        publicKey: counterpartyPublicKey,
        count: item.count,
        amountIn: item.amountIn.toString(),
        amountOut: item.amountOut.toString(),
      }));

    const paymentOpCount = Array.from(assetMap.values()).reduce(
      (sum, a) => sum + a.count,
      0,
    );
    const averageTransactionSize =
      paymentOpCount > 0
        ? ((totalInNum + totalOutNum) / paymentOpCount).toString()
        : "0";

    const summary: AccountActivitySummary = {
      publicKey,
      period: resultPeriod,
      transactionCount: txCount,
      successfulTransactionCount: successCount,
      failedTransactionCount: failedCount,
      totalAmountIn: totalInNum.toString(),
      totalAmountOut: totalOutNum.toString(),
      topAssets,
      averageTransactionSize,
      topCounterparties,
      range: {
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
      },
    };

    if (cache) {
      cache.set(cacheKey, summary, cacheTtlMs);
    }

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
