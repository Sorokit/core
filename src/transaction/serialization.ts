import { Transaction, FeeBumpTransaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

export type SupportedTransaction = Transaction | FeeBumpTransaction;

/**
 * Encodes a Stellar transaction or fee-bump transaction into a base64 XDR string.
 *
 * @param tx - Stellar Transaction or FeeBumpTransaction instance.
 * @returns SorokitResult with the base64-encoded XDR string on success, or TX_BUILD_FAILED / INVALID_TRANSACTION error.
 */
export function encodeTransaction(
  tx: SupportedTransaction | { toXDR: () => string },
): SorokitResult<string> {
  if (!tx || typeof (tx as any).toXDR !== "function") {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      "Cannot encode transaction: provided input does not have a toXDR method.",
    );
  }

  try {
    const xdr = tx.toXDR();
    return ok(xdr);
  } catch (cause) {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      `Failed to serialize transaction to XDR: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Decodes a base64-encoded XDR string into a Stellar Transaction or FeeBumpTransaction.
 *
 * @param base64Xdr         - Base64-encoded transaction envelope XDR.
 * @param networkPassphrase - Network passphrase used for parsing. Defaults to Networks.TESTNET.
 * @returns SorokitResult with the decoded transaction on success, or XDR_INVALID error.
 */
export function decodeTransaction(
  base64Xdr: string,
  networkPassphrase: string = Networks.TESTNET,
): SorokitResult<SupportedTransaction> {
  if (!base64Xdr || typeof base64Xdr !== "string" || !base64Xdr.trim()) {
    return err(
      SorokitErrorCode.XDR_INVALID,
      "Cannot decode transaction: input must be a non-empty base64 XDR string.",
    );
  }

  try {
    const tx = TransactionBuilder.fromXDR(base64Xdr.trim(), networkPassphrase);
    return ok(tx);
  } catch (cause) {
    return err(
      SorokitErrorCode.XDR_INVALID,
      `Failed to decode transaction XDR: ${toMessage(cause)}`,
      cause,
    );
  }
}
