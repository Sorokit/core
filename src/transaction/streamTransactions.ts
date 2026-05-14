import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep, toMessage, isNotFoundError } from "../shared";
import type { TransactionResult } from "./types";

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
): AsyncGenerator<SorokitResult<TransactionPage>> {
  const intervalMs = Math.max(config?.intervalMs ?? 5_000, 1_000);
  const maxPolls = config?.maxPolls;
  const limit = config?.limit ?? 10;
  const order = config?.order ?? "desc";
  const emitOnStart = config?.emitOnStart ?? true;

  let cursor = config?.cursor;
  let polls = 0;

  while (true) {
    if (signal?.aborted) return;

    if (maxPolls !== undefined && polls >= maxPolls) return;

    if (polls > 0 || !emitOnStart) {
      try {
        await sleep(intervalMs);
      } catch {
        return;
      }
    }

    if (signal?.aborted) return;

    try {
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

      yield ok({ transactions, nextCursor });
    } catch (cause) {
      yield err(
        isNotFoundError(cause)
          ? SorokitErrorCode.ACCOUNT_NOT_FOUND
          : SorokitErrorCode.TX_SUBMIT_FAILED,
        isNotFoundError(cause)
          ? `Account not found while streaming transactions: ${publicKey}`
          : `Transaction stream poll failed: ${toMessage(cause)}`,
        cause,
      );
    }

    polls++;
  }
}
