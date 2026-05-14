import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import type { TransactionResult } from "./types";

/**
 * Fetch the status of a submitted transaction by hash from Horizon.
 */
export async function getTransactionStatus(
  horizonUrl: string,
  hash: string,
): Promise<SorokitResult<TransactionResult>> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const tx = await server.transactions().transaction(hash).call();

    return ok({
      hash: tx.hash,
      status: tx.successful ? "success" : "failed",
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      fee: String(tx.fee_charged),
      envelopeXdr: tx.envelope_xdr,
      resultXdr: tx.result_xdr,
    });
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
