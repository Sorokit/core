import { getAccount } from "./getAccount";
import { sleep, toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { AssetBalance } from "./types";

const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Options accepted by {@link watchWalletBalance}.
 */
export interface WatchWalletBalanceOptions {
  /**
   * Polling interval in milliseconds. Default: 5000 (5 seconds).
   * Minimum enforced value: 1000 ms to avoid hammering Horizon.
   */
  intervalMs?: number;
  /**
   * Optional asset code to monitor (e.g. `"XLM"`, `"USDC"`).
   * When omitted every asset in the account is watched.
   */
  assetCode?: string;
  /**
   * Optional asset issuer to narrow the watch to a specific asset when
   * multiple assets share the same code. Use `null` to explicitly match
   * the native asset. When omitted the issuer is not used for filtering.
   */
  assetIssuer?: string | null;
  /**
   * Optional logger for diagnostic output.
   */
  logger?: SorokitLogger;
}

/**
 * Payload delivered to the {@link WatchWalletBalanceCallback} whenever a
 * balance crosses the configured threshold.
 */
export interface WalletBalanceChangeEvent {
  /** Asset code of the balance that changed. */
  assetCode: string;
  /** Asset issuer of the balance that changed (null for the native asset). */
  assetIssuer: string | null;
  /** Balance string at the previous poll. */
  oldBalance: string;
  /** Balance string at the current poll. */
  newBalance: string;
  /** Signed absolute change in the balance (newFloat − oldFloat). */
  delta: number;
  /** Signed percentage change since the previous poll. */
  changePercent: number;
}

/**
 * Callback signature for {@link watchWalletBalance}.
 */
export type WatchWalletBalanceCallback = (
  event: WalletBalanceChangeEvent,
) => void;

/**
 * Watch a Stellar account for wallet balance changes that meet or exceed a
 * given threshold, and fire a callback whenever such a change is detected.
 *
 * The function polls Horizon at a configurable interval, compares balances
 * between polls, and invokes `callback` for every asset whose **absolute**
 * balance change is greater than or equal to `threshold`.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account to watch.
 * @param threshold  - Minimum absolute balance change (in asset units) that
 *                     triggers the callback. Must be ≥ 0. Use `0` to fire on
 *                     any balance change.
 * @param callback   - Function invoked for each balance that exceeds the
 *                     threshold. Called synchronously within the polling loop.
 * @param options    - Optional polling and filtering configuration.
 * @returns An `unwatch` function. Call it to stop polling immediately.
 *
 * @example
 * const unwatch = watchWalletBalance(
 *   "https://horizon-testnet.stellar.org",
 *   publicKey,
 *   10,             // fire when balance changes by ≥ 10 units
 *   (event) => {
 *     console.log(`${event.assetCode} changed by ${event.delta}`);
 *   },
 *   { intervalMs: 3000, assetCode: "XLM" },
 * );
 *
 * // Later — stop watching
 * unwatch();
 */
export function watchWalletBalance(
  horizonUrl: string,
  publicKey: string,
  threshold: number,
  callback: WatchWalletBalanceCallback,
  options?: WatchWalletBalanceOptions,
): () => void {
  const intervalMs = Math.max(
    options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );
  const logger = options?.logger;

  // AbortController drives the internal async loop.
  const ac = new AbortController();

  // Kick off the polling loop as a detached async task.
  void _pollLoop(horizonUrl, publicKey, threshold, callback, options, intervalMs, logger, ac.signal);

  // Return the unwatch handle.
  return () => {
    ac.abort();
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the absolute balance change for each asset between two polls and
 * fire `callback` for every asset that meets or exceeds `threshold`.
 */
function _dispatchChanges(
  oldBalances: AssetBalance[],
  newBalances: AssetBalance[],
  threshold: number,
  assetCode: string | undefined,
  assetIssuer: string | null | undefined,
  callback: WatchWalletBalanceCallback,
): void {
  for (const newBal of newBalances) {
    // Asset-code filter (when specified)
    if (assetCode !== undefined && newBal.assetCode !== assetCode) continue;

    // Issuer filter (when specified — undefined means "no filter")
    if (
      assetIssuer !== undefined &&
      (newBal.assetIssuer ?? null) !== (assetIssuer ?? null)
    ) {
      continue;
    }

    const key = `${newBal.assetCode}:${newBal.assetIssuer ?? ""}`;
    const oldBal = oldBalances.find(
      (b) => `${b.assetCode}:${b.assetIssuer ?? ""}` === key,
    );

    // No baseline for this asset yet — skip
    if (!oldBal) continue;

    const delta = newBal.balanceFloat - oldBal.balanceFloat;
    const absChange = Math.abs(delta);

    if (absChange < threshold) continue;

    const changePercent =
      oldBal.balanceFloat !== 0
        ? (delta / oldBal.balanceFloat) * 100
        : 0;

    callback({
      assetCode: newBal.assetCode,
      assetIssuer: newBal.assetIssuer,
      oldBalance: oldBal.balance,
      newBalance: newBal.balance,
      delta,
      changePercent,
    });
  }
}

/**
 * Async polling loop. Runs until the AbortSignal fires.
 *
 * @internal
 */
async function _pollLoop(
  horizonUrl: string,
  publicKey: string,
  threshold: number,
  callback: WatchWalletBalanceCallback,
  options: WatchWalletBalanceOptions | undefined,
  intervalMs: number,
  logger: SorokitLogger | undefined,
  signal: AbortSignal,
): Promise<void> {
  let lastBalances: AssetBalance[] | undefined;

  logger?.debug("watchWalletBalance", {
    operation: "watchWalletBalance",
    status: "start",
    publicKey,
    threshold,
    intervalMs,
  });

  while (!signal.aborted) {
    try {
      const result = await getAccount(horizonUrl, publicKey);

      if (result.status === "ok") {
        const currentBalances = result.data.balances;

        if (lastBalances !== undefined) {
          _dispatchChanges(
            lastBalances,
            currentBalances,
            threshold,
            options?.assetCode,
            options?.assetIssuer,
            callback,
          );
        }

        lastBalances = currentBalances;
      } else {
        logger?.warn("watchWalletBalance.poll", {
          operation: "watchWalletBalance.poll",
          status: "error",
          publicKey,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        });
      }
    } catch (cause) {
      logger?.warn("watchWalletBalance.poll", {
        operation: "watchWalletBalance.poll",
        status: "error",
        publicKey,
        errorMessage: `Unexpected error during poll: ${toMessage(cause)}`,
      });
    }

    // Wait for the next poll interval (or until aborted).
    if (signal.aborted) break;
    try {
      await sleep(intervalMs);
    } catch {
      break;
    }
  }

  logger?.debug("watchWalletBalance", {
    operation: "watchWalletBalance",
    status: "stopped",
    publicKey,
  });
}
