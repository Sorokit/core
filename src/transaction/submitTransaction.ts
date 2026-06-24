import { Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage, retryWithBackoff } from "../shared";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";
import { DEFAULT_TX_CACHE_TTL_MS } from "../shared/constants";

/**
 * Submit a signed transaction XDR to the Stellar network via Horizon.
 * Parses the XDR before submission — no unsafe casts.
 */
export async function submitTransaction(
  horizonUrl: string,
  networkPassphrase: string,
  signedXdr: string,
  cache?: SorokitCache,
): Promise<SorokitResult<TransactionResult>> {
  try {
    const response = await retryWithBackoff(async () => {
      const server = new Horizon.Server(horizonUrl);
      const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
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
      `Transaction submission failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
