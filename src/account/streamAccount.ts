import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { AccountInfo } from "./types";
import { getAccount } from "./getAccount";

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
   * Optional callback fired when a specific asset balance changes between polls.
   * Receives the asset code, the previous balance string, and the new balance string.
   * Only fires when the balance actually changes — unchanged balances are silent.
   */
  onBalanceChange?: (assetCode: string, oldBalance: string, newBalance: string) => void;
}

/**
 * Stream account state by polling Horizon at a configurable interval.
 *
 * Yields SorokitResult<AccountInfo> on every poll. Errors mid-stream are
 * yielded as error results — the stream does not stop on a single failure.
 *
 * Use `for await...of` to consume:
 * @example
 * for await (const result of streamAccount(horizonUrl, publicKey)) {
 *   if (result.status === 'ok') console.log(result.data.balances);
 * }
 *
 * To stop early, `break` out of the loop or use an AbortSignal:
 * @example
 * const ac = new AbortController();
 * for await (const result of streamAccount(horizonUrl, publicKey, {}, ac.signal)) { ... }
 * ac.abort();
 */
export async function* streamAccount(
  horizonUrl: string,
  publicKey: string,
  config?: AccountStreamConfig,
  signal?: AbortSignal,
  logger?: SorokitLogger,
): AsyncGenerator<SorokitResult<AccountInfo>> {
  const baseIntervalMs = Math.max(
    config?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );
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

  let polls = 0;
  let currentIntervalMs = Math.min(
    Math.max(baseIntervalMs, minIntervalMs),
    maxIntervalMs,
  );
  let unchangedPolls = 0;
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
        await sleep(currentIntervalMs);
      } catch {
        return;
      }
    }

    if (signal?.aborted) return;

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

        // Fire onBalanceChange for any balance that changed since the last successful poll.
        if (lastEmitted && config?.onBalanceChange) {
          for (const newBal of result.data.balances) {
            const key = `${newBal.assetCode}:${newBal.assetIssuer ?? ""}`;
            const oldBal = lastEmitted.balances.find(
              (b) => `${b.assetCode}:${b.assetIssuer ?? ""}` === key,
            );
            if (oldBal && oldBal.balance !== newBal.balance) {
              config.onBalanceChange(newBal.assetCode, oldBal.balance, newBal.balance);
            }
          }
        }

      } else {
        logger?.warn("account.stream.poll", {
          operation: "account.stream.poll",
          status: "error",
          publicKey,
          poll: polls + 1,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        });
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
        yield result;
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
      yield err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, message, cause);
    }

    polls++;
  }
}
