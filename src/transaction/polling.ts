/**
 * Transaction confirmation polling (#973).
 *
 * `waitForTransaction` polls Horizon until a submitted transaction is
 * confirmed in a ledger, so callers don't need hand-rolled polling loops.
 *
 * Defaults: polls every {@link DEFAULT_POLL_INTERVAL_MS} (1 000 ms) and gives
 * up after {@link DEFAULT_POLL_TIMEOUT_MS} (30 000 ms). Both are configurable,
 * and `maxRetries` can additionally cap the number of lookups.
 */

import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { getTransactionStatus } from "./status";
import type { TransactionResult } from "./types";

/** Default total time to wait for confirmation: 30 seconds. */
export const DEFAULT_POLL_TIMEOUT_MS = 30_000;
/** Default delay between lookups: 1 second. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Optional settings for {@link waitForTransaction}. */
export interface WaitForTransactionOptions {
  /** Horizon base URL to poll. Required unless `fetchStatus` is supplied. */
  horizonUrl?: string;
  /** Stop after this many lookups, even if `timeout` has not elapsed. Default: unlimited. */
  maxRetries?: number;
  /** Cancel polling early. */
  signal?: AbortSignal;
  /** Custom lookup, e.g. for another backend or tests. Defaults to `getTransactionStatus`. */
  fetchStatus?: (hash: string) => Promise<SorokitResult<TransactionResult>>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait until a transaction is confirmed on the ledger.
 *
 * Resolves with `ok(TransactionResult)` as soon as the transaction is included
 * in a ledger. A transaction that was included but failed is still
 * "confirmed": check `result.data.status` (`"success"` or `"failed"`).
 *
 * Errors:
 * - `TX_NOT_FOUND` - the hash never appeared before the timeout / retry limit.
 * - `OPERATION_TIMEOUT` - the transaction was seen but still pending at the
 *   deadline, or polling was aborted.
 * - the last lookup error (e.g. `TX_FETCH_FAILED`) - when lookups kept failing.
 * - `VALIDATION` / `INVALID_CONFIG` - bad arguments or no way to look up transactions.
 *
 * @param hash     - Transaction hash to wait for.
 * @param timeout  - Total time to wait in ms (default 30 000).
 * @param interval - Delay between lookups in ms (default 1 000).
 * @param options  - `horizonUrl`, `maxRetries`, `signal`, `fetchStatus`.
 *
 * @example
 * const result = await waitForTransaction(hash, 60_000, 2_000, {
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 * if (result.status === "ok") console.log(result.data.status, result.data.ledger);
 */
export async function waitForTransaction(
  hash: string,
  timeout: number = DEFAULT_POLL_TIMEOUT_MS,
  interval: number = DEFAULT_POLL_INTERVAL_MS,
  options: WaitForTransactionOptions = {},
): Promise<SorokitResult<TransactionResult>> {
  if (!hash || typeof hash !== "string") {
    return err(SorokitErrorCode.VALIDATION, "Transaction hash is required");
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "timeout must be a positive number of milliseconds",
    );
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "interval must be a positive number of milliseconds",
    );
  }
  const { maxRetries, signal, horizonUrl } = options;
  if (
    maxRetries !== undefined &&
    (!Number.isInteger(maxRetries) || maxRetries < 1)
  ) {
    return err(SorokitErrorCode.VALIDATION, "maxRetries must be an integer >= 1");
  }

  const fetchStatus =
    options.fetchStatus ??
    (horizonUrl
      ? (h: string) =>
          getTransactionStatus(horizonUrl, h, undefined, { signal })
      : undefined);
  if (!fetchStatus) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "waitForTransaction requires options.horizonUrl or options.fetchStatus",
    );
  }

  const startedAt = Date.now();
  let attempts = 0;
  let lastSeen: "notFound" | "pending" | "error" = "notFound";
  let lastError: SorokitResult<TransactionResult> | undefined;

  for (;;) {
    if (signal?.aborted) {
      return err(
        SorokitErrorCode.OPERATION_TIMEOUT,
        `Polling for transaction ${hash} was aborted`,
      );
    }

    attempts += 1;
    const res = await fetchStatus(hash);

    if (res.status === "ok") {
      const txStatus = res.data.status;
      if (txStatus === "success" || txStatus === "failed") return res;
      lastSeen = txStatus === "pending" ? "pending" : "notFound";
    } else if (res.error.code === SorokitErrorCode.TX_NOT_FOUND) {
      lastSeen = "notFound";
    } else {
      lastSeen = "error";
      lastError = res;
    }

    if (maxRetries !== undefined && attempts >= maxRetries) break;
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining), signal);
  }

  if (lastSeen === "error" && lastError) return lastError;
  if (lastSeen === "pending") {
    return err(
      SorokitErrorCode.OPERATION_TIMEOUT,
      `Transaction ${hash} was not confirmed after ${attempts} attempt(s) within ${timeout}ms`,
    );
  }
  return err(
    SorokitErrorCode.TX_NOT_FOUND,
    `Transaction not found: ${hash} (${attempts} attempt(s) within ${timeout}ms)`,
  );
}
