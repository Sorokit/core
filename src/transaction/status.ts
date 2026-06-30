import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";

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
 *          or `error(TX_SUBMIT_FAILED)` on other network failures.
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
): Promise<SorokitResult<TransactionResult>> {
  if (cache) {
    const cached = cache.get(`tx:${hash}`);
    if (cached) {
      return ok(cached as TransactionResult);
    }
  }

  try {
    const server = new Horizon.Server(horizonUrl);
    const tx = await server.transactions().transaction(hash).call();

    const result: TransactionResult = {
      hash: tx.hash,
      status: tx.successful ? "success" : "failed",
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      fee: String(tx.fee_charged),
      envelopeXdr: tx.envelope_xdr,
      resultXdr: tx.result_xdr,
    };

    if (cache) {
      cache.set(`tx:${hash}`, result);
    }

    return ok(result);
  } catch (cause) {
    return err(
      isNotFoundError(cause)
        ? SorokitErrorCode.TX_NOT_FOUND
        : SorokitErrorCode.TX_SUBMIT_FAILED,
      isNotFoundError(cause)
        ? `Transaction not found: ${hash}`
        : `Failed to fetch transaction status: ${toMessage(cause)}`,
      cause,
    );
  }
}
