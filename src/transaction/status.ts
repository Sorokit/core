import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { mapHorizonError } from "../shared/horizonErrorMapper";

/**
 * Fetch the current status of a submitted transaction by its hash.
 *
 * Checks the optional cache first to avoid redundant Horizon round trips —
 * `submitTransaction` writes successful results under the same `tx:<hash>` key,
 * so back-to-back calls are fast for recently confirmed transactions.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param hash       - Transaction hash returned by `submitTransaction`.
 * @param cache      - Optional cache to check before hitting Horizon.
 * @returns `ok(TransactionResult)` with the confirmed transaction details,
 *          `error(TX_NOT_FOUND)` when the hash is unknown to Horizon,
 *          or `error(TX_FETCH_FAILED)` on other network failures.
 *
 * @example
 * const result = await getTransactionStatus(horizonUrl, txHash);
 * if (result.status === "ok") {
 *   console.log("Status:", result.data.status, "Ledger:", result.data.ledger);
 * }
 */
export async function getTransactionStatus(
  horizonUrl: string,
  hash: string,
  cache?: SorokitCache,
  options?: { signal?: AbortSignal | undefined },
): Promise<SorokitResult<TransactionResult>> {
  if (cache) {
    const cached = cache.get(`tx:${hash}`);
    if (cached) {
      return ok(cached as TransactionResult);
    }
  }

  try {
    const server = createHorizonServer(horizonUrl, options);
    const tx = await server.transactions().transaction(hash).call();

    // Horizon reports ledger_attr as 0 (or omits it) for a transaction that has
    // been submitted but not yet included in a ledger — treat that as "pending"
    // rather than surfacing a meaningless ledger number.
    const isPending = !tx.ledger_attr;

    const result: TransactionResult = {
      hash: tx.hash,
      status: isPending ? "pending" : tx.successful ? "success" : "failed",
      createdAt: tx.created_at,
      fee: String(tx.fee_charged),
      envelopeXdr: tx.envelope_xdr,
      resultXdr: tx.result_xdr,
      ...(isPending ? {} : { ledger: tx.ledger_attr }),
    };

    if (cache) {
      cache.set(`tx:${hash}`, result);
    }

    return ok(result);
  } catch (cause) {
    const mapped = mapHorizonError(cause, {
      resource: "transaction",
      fallbackCode: isNotFoundError(cause)
        ? SorokitErrorCode.TX_NOT_FOUND
        : SorokitErrorCode.TX_FETCH_FAILED,
    });
    return err(
      mapped.code,
      mapped.code === SorokitErrorCode.TX_NOT_FOUND
        ? `Transaction not found: ${hash}`
        : mapped.message || `Failed to fetch transaction status: ${toMessage(cause)}`,
      cause,
      undefined,
      mapped.recovery ? { recovery: mapped.recovery } : undefined,
    );
  }
}
