import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage, isNotFoundError } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type { TransactionResult } from "./types";

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
 * Configuration for transaction streaming.
 */
export interface TransactionStreamConfig {
  /**
   * Polling interval in milliseconds. Default: 5000 (5 seconds).
   * Minimum enforced: 1000 ms.
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
   * Maximum number of transactions to return per poll. Default: 10.
   */
  limit?: number;
  /**
   * Return transactions in ascending or descending order. Default: "desc".
   */
  order?: "asc" | "desc";
  /**
   * Cursor for pagination — only return transactions after this cursor.
   * Useful for streaming only new transactions.
   */
  cursor?: string;
  /**
   * If true, emit the current page immediately on start. Default: true.
   */
  emitOnStart?: boolean;
}

/**
 * A single page of transactions yielded by the stream.
 */
export interface TransactionPage {
  transactions: TransactionResult[];
  /** Cursor pointing to the last record — pass as `cursor` to resume */
  nextCursor: string | null;
}

/**
 * Stream transactions for an account by polling Horizon at a configurable interval.
 *
 * Yields SorokitResult<TransactionPage> on every poll. Errors are yielded
 * as error results — the stream does not stop on a single failure.
 *
 * @example
 * for await (const result of streamTransactions(horizonUrl, publicKey)) {
 *   if (result.status === 'ok') {
 *     result.data.transactions.forEach(tx => console.log(tx.hash));
 *   }
 * }
 *
 * // Stream only new transactions using cursor:
 * let cursor: string | undefined;
 * for await (const result of streamTransactions(horizonUrl, publicKey, { cursor })) {
 *   if (result.status === 'ok') cursor = result.data.nextCursor ?? cursor;
 * }
 */
export async function* streamTransactions(
  horizonUrl: string,
  publicKey: string,
  config?: TransactionStreamConfig,
  signal?: AbortSignal,
  logger?: SorokitLogger,
): AsyncGenerator<SorokitResult<TransactionPage>> {
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
  const limit = config?.limit ?? 10;
  const order = config?.order ?? "desc";
  const emitOnStart = config?.emitOnStart ?? true;

  let cursor = config?.cursor;
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
  let lastEmitted: TransactionPage | undefined;

  logger?.debug("transaction.stream", {
    operation: "transaction.stream",
    status: "start",
    publicKey,
    intervalMs: currentIntervalMs,
    maxPolls,
    limit,
  });

  while (true) {
    if (signal?.aborted) {
      logger?.debug("transaction.stream", {
        operation: "transaction.stream",
        status: "ok",
        reason: "aborted",
        polls,
      });
      return;
    }

    if (maxPolls !== undefined && polls >= maxPolls) return;

    if (polls > 0 || !emitOnStart) {
      try {
        await sleep(currentIntervalMs);
      } catch {
        return;
      }
    }

    if (signal?.aborted) return;

    try {
      logger?.debug("transaction.stream.poll", {
        operation: "transaction.stream.poll",
        status: "start",
        publicKey,
        poll: polls + 1,
        cursor,
      });

      const server = new Horizon.Server(horizonUrl);

      let builder = server
        .transactions()
        .forAccount(publicKey)
        .limit(limit)
        .order(order);

      if (cursor !== undefined) {
        builder = builder.cursor(cursor);
      }

      const page = await builder.call();

      const transactions: TransactionResult[] = page.records.map((tx) => ({
        hash: tx.hash,
        status: tx.successful ? ("success" as const) : ("failed" as const),
        ledger: tx.ledger_attr,
        createdAt: tx.created_at,
        fee: String(tx.fee_charged),
        envelopeXdr: tx.envelope_xdr,
        resultXdr: tx.result_xdr,
      }));

      // Advance cursor to the last record for next poll
      const lastRecord = page.records[page.records.length - 1];
      const nextCursor = lastRecord?.paging_token ?? null;

      logger?.debug("transaction.stream.poll", {
        operation: "transaction.stream.poll",
        status: "ok",
        publicKey,
        poll: polls + 1,
        transactionCount: transactions.length,
        nextCursor,
      });

      const transactionPage = { transactions, nextCursor };
      const hasBaseline = lastEmitted !== undefined;
      const changed = !hasBaseline || !sameSnapshot(lastEmitted, transactionPage);
      if (hasBaseline) adjustInterval(changed);
      cursor = nextCursor ?? cursor;

      if (changed) {
        lastEmitted = transactionPage;
        yield ok(transactionPage);
      }
    } catch (cause) {
      const code = isNotFoundError(cause)
        ? SorokitErrorCode.ACCOUNT_NOT_FOUND
        : SorokitErrorCode.TX_SUBMIT_FAILED;
      const message = isNotFoundError(cause)
        ? `Account not found while streaming transactions: ${publicKey}`
        : `Transaction stream poll failed: ${toMessage(cause)}`;

      logger?.warn("transaction.stream.poll", {
        operation: "transaction.stream.poll",
        status: "error",
        publicKey,
        poll: polls + 1,
        errorCode: code,
        errorMessage: message,
      });

      adjustInterval(false);
      yield err(code, message, cause);
    }

    polls++;
  }
}
