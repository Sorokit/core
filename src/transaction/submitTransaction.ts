import { Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { TransactionResult } from "./types";

/**
 * Submit a signed transaction XDR to the Stellar network via Horizon.
 * Parses the XDR before submission — no unsafe casts.
 */
export async function submitTransaction(
  horizonUrl: string,
  networkPassphrase: string,
  signedXdr: string,
): Promise<SorokitResult<TransactionResult>> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    const response = await server.submitTransaction(tx);

    return ok({
      hash: response.hash,
      status: "success",
      ledger: response.ledger,
      envelopeXdr: response.envelope_xdr,
      resultXdr: response.result_xdr,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      `Transaction submission failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
