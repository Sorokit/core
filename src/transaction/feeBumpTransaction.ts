/**
 * Fee-bump transaction support (#398).
 *
 * Lets one account (the fee source) sponsor the fees of an existing signed
 * inner transaction without altering the inner transaction's semantics.
 * Construction only: sign the returned XDR with the fee account through the
 * existing Sorokit signing flows, then submit via `submitTransaction`.
 */

import {
  BASE_FEE,
  FeeBumpTransaction,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

/**
 * Build a fee-bump transaction wrapping an existing inner transaction.
 *
 * The inner transaction is validated (parseable XDR, not already a fee-bump)
 * and its semantics are preserved — the returned XDR contains it byte-for-byte
 * including its signatures. The fee account pays the fee for the whole
 * envelope; `baseFee` is the per-operation fee in stroops and must cover the
 * network minimum and the inner transaction's own base fee (enforced by the
 * underlying Stellar SDK).
 *
 * @param innerXdr          - Signed inner transaction envelope XDR (base64)
 * @param feeAccount        - Account that will pay the fees (G... or muxed M... address)
 * @param baseFee           - Per-operation base fee in stroops (string or number)
 * @param networkPassphrase - Network passphrase the inner transaction targets
 * @returns `ok(feeBumpXdr)` on success, or an error result describing the
 *          validation failure
 *
 * @example
 * const result = buildFeeBumpTransaction(
 *   signedXdr,
 *   sponsorPublicKey,
 *   "200",
 *   networkPassphrase,
 * );
 * if (result.status === "ok") {
 *   const signed = await signTransaction(adapter, {
 *     transactionXdr: result.data,
 *     networkPassphrase,
 *   });
 * }
 */
export function buildFeeBumpTransaction(
  innerXdr: string,
  feeAccount: string,
  baseFee: string | number,
  networkPassphrase: string,
): SorokitResult<string> {
  if (!innerXdr || typeof innerXdr !== "string") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Inner transaction XDR must be a non-empty string",
    );
  }

  if (!networkPassphrase || typeof networkPassphrase !== "string") {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      "Network passphrase must be a non-empty string",
    );
  }

  if (
    typeof feeAccount !== "string" ||
    !(
      StrKey.isValidEd25519PublicKey(feeAccount) ||
      StrKey.isValidMed25519PublicKey(feeAccount)
    )
  ) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid fee account address: ${String(feeAccount)}. Expected a G... or muxed M... address.`,
    );
  }

  const feeString = String(baseFee);
  if (!/^\d+$/.test(feeString)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid base fee: ${feeString}. Expected a non-negative integer number of stroops.`,
    );
  }
  if (BigInt(feeString) < BigInt(BASE_FEE)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Base fee ${feeString} is below the network minimum of ${BASE_FEE} stroops`,
    );
  }

  let inner: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(innerXdr, networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Inner transaction is already a fee-bump transaction and cannot be wrapped again",
      );
    }
    inner = parsed;
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to parse inner transaction XDR: ${toMessage(cause)}`,
      cause,
    );
  }

  const innerFee = BigInt(inner.fee);
  const bumpFee = BigInt(feeString);
  if (bumpFee <= innerFee) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Fee bump fee (${feeString} stroops) must be higher than the inner transaction fee (${innerFee} stroops)`,
    );
  }

  try {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      feeString,
      inner,
      networkPassphrase,
    );
    return ok(feeBump.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build fee-bump transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}
