import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage } from "../shared";
import type { AccountInfo } from "./types";
import { getAccount } from "./getAccount";

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
): AsyncGenerator<SorokitResult<AccountInfo>> {
  const intervalMs = Math.max(config?.intervalMs ?? 5_000, 1_000);
  const maxPolls = config?.maxPolls;
  const emitOnStart = config?.emitOnStart ?? true;

  let polls = 0;

  while (true) {
    if (signal?.aborted) return;

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
      const result = await getAccount(horizonUrl, publicKey);
      yield result;
    } catch (cause) {
      yield err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Account stream poll failed: ${toMessage(cause)}`,
        cause,
      );
    }

    polls++;
  }
}
