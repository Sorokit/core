import { Horizon, TransactionBuilder, Keypair, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  retryWithBackoff,
  toMessage,
} from "../shared";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";
import { DEFAULT_TX_CACHE_TTL_MS } from "../shared/constants";

function describeSubmissionFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Transaction submission failed because the signed XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Transaction submission timed out while contacting Horizon: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Transaction submission failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Transaction submission failed: ${toMessage(cause)}`;
}

/**
 * Verify that signatures in the parsed transaction were made for the given
 * networkPassphrase by checking the source account's signature hint.
 * Returns true when a mismatch is detected (signatures don't verify for this network).
 * Returns false when the check passes or cannot be performed (falls back to Horizon).
 */
function detectNetworkPassphraseMismatch(
  tx: ReturnType<typeof TransactionBuilder.fromXDR>,
  networkPassphrase: string,
): boolean {
  const source = tx instanceof FeeBumpTransaction ? tx.feeSource : tx.source;

  // Muxed accounts (M...) require extra decoding — skip and let Horizon validate.
  if (!source || source.startsWith("M")) return false;

  try {
    const keypair = Keypair.fromPublicKey(source);
    const expectedHash = tx.hash();
    const hint = keypair.rawPublicKey().slice(-4);

    for (const decoratedSig of tx.signatures) {
      if (!decoratedSig.hint().equals(hint)) continue;
      // This signature claims to be from the source account.
      // If it doesn't verify for the given network, the transaction was signed for a different network.
      try {
        if (!keypair.verify(expectedHash, decoratedSig.signature())) return true;
      } catch {
        return true;
      }
    }
  } catch {
    // If key parsing or verification fails in an unexpected way, fall through.
  }

  return false;
}

/**
 * Submit a signed transaction XDR to the Stellar network via Horizon.
 * Validates the network passphrase before submission to catch testnet/mainnet mismatches early.
 */
export async function submitTransaction(
  horizonUrl: string,
  networkPassphrase: string,
  signedXdr: string,
  cache?: SorokitCache,
): Promise<SorokitResult<TransactionResult>> {
  if (isXdrInvalidError(signedXdr)) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "Transaction submission failed because the signed XDR is malformed.",
      signedXdr,
    );
  }

  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

    if (detectNetworkPassphraseMismatch(tx, networkPassphrase)) {
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `Network passphrase mismatch: the transaction was signed for a different network. Expected: "${networkPassphrase}".`,
      );
    }

    const response = await retryWithBackoff(async () => {
      const server = new Horizon.Server(horizonUrl);
      return await server.submitTransaction(tx);
    });

    const result: TransactionResult = {
      hash: response.hash,
      status: "success",
      ledger: response.ledger,
      envelopeXdr: response.envelope_xdr,
      resultXdr: response.result_xdr,
    };

    if (cache) {
      cache.set(`tx:${response.hash}`, result, DEFAULT_TX_CACHE_TTL_MS);
    }

    return ok(result);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      describeSubmissionFailure(cause),
      cause,
    );
  }
}
