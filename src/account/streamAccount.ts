import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { AccountInfo, BalanceAlert, BalanceAlertRule } from "./types";
import { getAccount } from "./getAccount";
import { evaluateBalanceAlerts } from "./balanceAlerts";
import {
  retryStreamingPoll,
  type StreamingRetryState,
  type StreamingRetryConfig,
} from "../shared/utils";
import { isTransientError } from "../shared/errors";

const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const ADAPTIVE_INTERVAL_STEP_MS = 1_000;

function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function getLatencyCompensatedDelay(intervalMs: number, requestDurationMs: number): number {
  return Math.max(MIN_POLL_INTERVAL_MS, intervalMs - requestDurationMs);
}

/**
 * Configuration for account streaming.
 */
export interface AccountStreamConfig {
  /**
   * Polling interval in milliseconds. Default: 5000 (5 seconds).
   * Minimum enforced: 1000 ms to avoid hammering Horizon.
   */
  intervalMs?: number;
  /**
   * Minimum polling interval in milliseconds when adaptive polling is enabled.
   * Default: 1000 ms.
   */
  minIntervalMs?: number;
  /**
   * Maximum polling interval in milliseconds when adaptive polling is enabled.
   * Default: the base interval.
   */
  maxIntervalMs?: number;
  /**
   * Number of unchanged polls before increasing the interval.
   * Default: 3.
   */
  adaptiveThreshold?: number;
  /**
   * Maximum number of polls before the stream ends.
   * Omit for an infinite stream.
   */
  maxPolls?: number;
  /**
   * If true, emit the current account state immediately on start.
   * Default: true.
   */
  emitOnStart?: boolean;
  /**
   * Optional callback fired when a new asset balance is added to the account.
   * Receives the asset details (code, issuer), the new balance string, and the delta.
   */
  onBalanceAdd?: (asset: { code: string; issuer?: string }, newBalance: string, delta: string) => void;
  /**
   * Optional callback fired when an asset balance is removed from the account.
   * Receives the asset details (code, issuer), the old balance string, and the delta.
   */
  onBalanceRemove?: (asset: { code: string; issuer?: string }, oldBalance: string, delta: string) => void;
  /**
   * Optional callback fired when a specific asset balance changes between polls.
   * Receives the asset details (code, issuer), the old balance string, the new balance string, and the delta.
   * Only fires when the balance actually changes — unchanged balances are silent.
   */
  onBalanceChange?: (asset: { code: string; issuer?: string }, oldBalance: string, newBalance: string, delta: string) => void;
  /**
   * Optional balance alert rules evaluated on every successful poll.
   * Each rule fires an alert via {@link onAlert} when its threshold is crossed.
   * Requires {@link onAlert} to be set — rules without a callback are ignored.
   */
  alertRules?: BalanceAlertRule[];
  /**
   * Optional callback fired for each {@link BalanceAlert} produced by {@link alertRules}.
   * Fired after balance event callbacks for the same poll.
   */
  onAlert?: (alert: BalanceAlert) => void;
  /**
   * Enable automatic retry with exponential backoff for transient network errors.
   * When enabled, transient errors (timeouts, network issues, 5xx) trigger automatic
   * retry with exponential backoff (1s, 2s, 4s, 8s, 16s, then 30s max). After 5 consecutive
   * failures, an error is emitted and polling pauses for 60s before resuming.
   * Default: true.
   */
  enableAutoRetry?: boolean;
}

/**
 * Stream account state by polling Horizon at a configurable interval.
 *
 * Yields `SorokitResult<AccountInfo>` on every poll. Network errors mid-stream
 * are yielded as error results rather than stopping the generator, allowing
 * consumers to decide whether to retry or abort.
 *
 * Adaptive polling automatically increases the interval when consecutive polls
 * return the same account state, and resets to the base interval on change.
 * Balance-alert rules and `onBalanceChange` hooks are evaluated after each
 * successful poll.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account to monitor.
 * @param config     - Optional streaming and polling configuration.
 * @param signal     - Optional `AbortSignal` to stop the stream externally.
 * @param logger     - Optional logger for diagnostic output.
 * @yields `SorokitResult<AccountInfo>` on each poll cycle.
 *
 * @example
 * for await (const result of streamAccount(horizonUrl, publicKey)) {
 *   if (result.status === "ok") console.log(result.data.balances);
 * }
 *
 * @example
 * // Stop after 30 s via AbortController
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 30_000);
 * for await (const result of streamAccount(horizonUrl, publicKey, {}, ac.signal)) {
 *   if (result.status === "ok") console.log(result.data.balances);
 * }
 */
export async function* streamAccount(
  horizonUrl: string,
  publicKey: string,
  config?: AccountStreamConfig,
  signal?: AbortSignal,
  logger?: SorokitLogger,
): AsyncGenerator<SorokitResult<AccountInfo>> {
  const requestedInterval = config?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (requestedInterval < MIN_POLL_INTERVAL_MS) {
    const msg = `intervalMs clamped from ${requestedInterval}ms to ${MIN_POLL_INTERVAL_MS}ms`;
    if (logger) {
      logger.warn(msg, { operation: "account.stream" });
    } else {
      console.warn(msg);
    }
  }
  const baseIntervalMs = Math.max(requestedInterval, MIN_POLL_INTERVAL_MS);
  const adaptiveEnabled =
    config?.minIntervalMs !== undefined ||
    config?.maxIntervalMs !== undefined ||
    config?.adaptiveThreshold !== undefined;
  const minIntervalMs = Math.max(
    config?.minIntervalMs ?? MIN_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );
  const maxIntervalMs = Math.max(
    config?.maxIntervalMs ?? baseIntervalMs,
    minIntervalMs,
  );
  const adaptiveThreshold = Math.max(config?.adaptiveThreshold ?? 3, 1);
  const maxPolls = config?.maxPolls;
  const emitOnStart = config?.emitOnStart ?? true;

  // Retry configuration
  const retryConfig: StreamingRetryConfig = {
    enabled: config?.enableAutoRetry ?? true,
  };
  let retryState: StreamingRetryState = {
    consecutiveFailures: 0,
    inCooldown: false,
  };

  let polls = 0;
  let currentIntervalMs = Math.min(
    Math.max(baseIntervalMs, minIntervalMs),
    maxIntervalMs,
  );
  let unchangedPolls = 0;
  let nextDelayMs = currentIntervalMs;
  const adjustInterval = (changed: boolean): void => {
    if (!adaptiveEnabled) return;

    if (changed) {
      unchangedPolls = 0;
      currentIntervalMs = Math.max(
        minIntervalMs,
        currentIntervalMs - ADAPTIVE_INTERVAL_STEP_MS,
      );
      return;
    }

    unchangedPolls++;
    if (unchangedPolls < adaptiveThreshold) return;

    unchangedPolls = 0;
    currentIntervalMs = Math.min(
      maxIntervalMs,
      currentIntervalMs + ADAPTIVE_INTERVAL_STEP_MS,
    );
  };
  let lastEmitted: AccountInfo | undefined;

  logger?.debug("account.stream", {
    operation: "account.stream",
    status: "start",
    publicKey,
    intervalMs: currentIntervalMs,
    maxPolls,
  });

  while (true) {
    if (signal?.aborted) {
      logger?.debug("account.stream", {
        operation: "account.stream",
        status: "ok",
        reason: "aborted",
        polls,
      });
      return;
    }

    // Respect maxPolls limit
    if (maxPolls !== undefined && polls >= maxPolls) return;

    // Skip the initial sleep when emitOnStart is true
    if (polls > 0 || !emitOnStart) {
      try {
        await sleep(nextDelayMs);
      } catch {
        return;
      }
    }

    if (signal?.aborted) return;

    const pollStartedAt = Date.now();
    let pollSuccess = false;
    let errorResult: SorokitResult<AccountInfo> | null = null;
    
    try {
      logger?.debug("account.stream.poll", {
        operation: "account.stream.poll",
        status: "start",
        publicKey,
        poll: polls + 1,
      });

      const result = await getAccount(horizonUrl, publicKey);

      if (result.status === "ok") {
        logger?.debug("account.stream.poll", {
          operation: "account.stream.poll",
          status: "ok",
          publicKey,
          poll: polls + 1,
        });

        // Fire balance event callbacks for add/remove/change events
        if (lastEmitted) {
          const oldBalancesMap = new Map(
            lastEmitted.balances.map((b) => [`${b.assetCode}:${b.assetIssuer ?? ""}`, b])
          );
          const newBalancesMap = new Map(
            result.data.balances.map((b) => [`${b.assetCode}:${b.assetIssuer ?? ""}`, b])
          );

          // Detect added balances
          if (config?.onBalanceAdd) {
            for (const [key, newBal] of newBalancesMap) {
              if (!oldBalancesMap.has(key)) {
                const asset: { code: string; issuer?: string } = { code: newBal.assetCode };
                if (newBal.assetIssuer) asset.issuer = newBal.assetIssuer;
                config.onBalanceAdd(asset, newBal.balance, newBal.balance);
              }
            }
          }

          // Detect removed balances
          if (config?.onBalanceRemove) {
            for (const [key, oldBal] of oldBalancesMap) {
              if (!newBalancesMap.has(key)) {
                const asset: { code: string; issuer?: string } = { code: oldBal.assetCode };
                if (oldBal.assetIssuer) asset.issuer = oldBal.assetIssuer;
                config.onBalanceRemove(asset, oldBal.balance, `-${oldBal.balance}`);
              }
            }
          }

          // Detect changed balances
          if (config?.onBalanceChange) {
            for (const [key, newBal] of newBalancesMap) {
              const oldBal = oldBalancesMap.get(key);
              if (oldBal && oldBal.balance !== newBal.balance) {
                const asset: { code: string; issuer?: string } = { code: newBal.assetCode };
                if (newBal.assetIssuer) asset.issuer = newBal.assetIssuer;
                // Calculate delta as a string (new - old)
                const oldNum = parseFloat(oldBal.balance);
                const newNum = parseFloat(newBal.balance);
                const delta = (newNum - oldNum).toString();
                config.onBalanceChange(asset, oldBal.balance, newBal.balance, delta);
              }
            }
          }
        }

        // Evaluate balance alert rules against the transition from the last
        // successful poll. The initial poll uses an empty baseline, so an
        // account already past a below/above threshold alerts once on start.
        if (config?.alertRules && config.alertRules.length > 0 && config.onAlert) {
          const oldBalances = lastEmitted?.balances ?? [];
          const alerts = evaluateBalanceAlerts(
            config.alertRules,
            oldBalances,
            result.data.balances,
          );
          for (const alert of alerts) config.onAlert(alert);
        }

        pollSuccess = true;

      } else {
        logger?.warn("account.stream.poll", {
          operation: "account.stream.poll",
          status: "error",
          publicKey,
          poll: polls + 1,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        });
        
        errorResult = result;
      }

      if (result.status === "ok") {
        const hasBaseline = lastEmitted !== undefined;
        const changed = !hasBaseline || !sameSnapshot(lastEmitted, result.data);
        if (hasBaseline) adjustInterval(changed);

        if (changed) {
          lastEmitted = result.data;
          yield result;
        }
      } else {
        adjustInterval(false);
      }
    } catch (cause) {
      const message = `Account stream poll failed: ${toMessage(cause)}`;
      logger?.warn("account.stream.poll", {
        operation: "account.stream.poll",
        status: "error",
        publicKey,
        poll: polls + 1,
        errorMessage: message,
      });
      
      errorResult = err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, message, cause);
    }

    // Handle retry logic after poll attempt
    const isTransient = errorResult && errorResult.error ? isTransientError(errorResult.error.cause || errorResult.error) : false;
    const retryDecision = retryStreamingPoll(
      pollSuccess,
      retryState,
      retryConfig,
    );
    retryState = retryDecision.updatedState;

    // Determine if we should yield the error
    // Yield error if: not a transient error, or we're in cooldown, or auto-retry is disabled
    const shouldYieldError = errorResult && 
      (!isTransient || !retryDecision.shouldRetry || retryState.inCooldown);

    // Yield error if needed
    if (shouldYieldError && errorResult) {
      yield errorResult;
    }

    // Calculate next delay
    if (retryDecision.shouldRetry && isTransient && !retryState.inCooldown) {
      nextDelayMs = retryDecision.delayMs;
      logger?.debug("account.stream.retry", {
        operation: "account.stream.retry",
        status: "retrying",
        publicKey,
        consecutiveFailures: retryState.consecutiveFailures,
        delayMs: nextDelayMs,
      });
    } else if (retryState.inCooldown) {
      nextDelayMs = retryDecision.delayMs;
      logger?.debug("account.stream.retry", {
        operation: "account.stream.retry",
        status: "cooldown",
        publicKey,
        delayMs: nextDelayMs,
      });
    } else {
      nextDelayMs = getLatencyCompensatedDelay(
        currentIntervalMs,
        Date.now() - pollStartedAt,
      );
    }

    polls++;
  }
}
