import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { AccountInfo } from "./types";
import { getAccount } from "./getAccount";

/**
 * Callback fired when a specific asset balance changes between polls.
 * Receives the asset code, the old balance string, and the new balance string.
 * The callback is optional; omitting it has no effect on the generator output.
 */
export type BalanceChangeCallback = (
  assetCode: string,
  oldBalance: string,
  newBalance: string,
) => void;

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
   * Optional callback fired whenever a specific asset balance changes between
   * consecutive polls. Receives the asset code, the previous balance string,
   * and the new balance string. The full account state is still yielded via
   * the generator regardless of whether this callback is provided.
   */
  onBalanceChange?: BalanceChangeCallback;
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
  const intervalMs = Math.max(config?.intervalMs ?? 5_000, 1_000);
  const maxPolls = config?.maxPolls;
  const emitOnStart = config?.emitOnStart ?? true;
  const onBalanceChange = config?.onBalanceChange;

  // Keyed by "<assetCode>:<assetIssuer|native>" → last-seen balance string.
  const prevBalances = new Map<string, string>();

  let polls = 0;

  logger?.debug("account.stream", {
    operation: "account.stream",
    status: "start",
    publicKey,
    intervalMs,
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
        await sleep(intervalMs);
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

        // Fire onBalanceChange for every asset whose balance changed since last poll.
        if (onBalanceChange) {
          for (const bal of result.data.balances) {
            const key = `${bal.assetCode}:${bal.assetIssuer ?? "native"}`;
            const prev = prevBalances.get(key);
            if (prev !== undefined && prev !== bal.balance) {
              onBalanceChange(bal.assetCode, prev, bal.balance);
            }
            prevBalances.set(key, bal.balance);
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

      yield result;
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
