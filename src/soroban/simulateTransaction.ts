import { rpc as SorobanRpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { SimulateTransactionResult } from "./types";

/**
 * Simulate any transaction XDR against the Soroban RPC.
 * Used for fee estimation and pre-flight validation without submitting.
 *
 * Lives in soroban/ because it uses the Soroban RPC server.
 * For contract calls, prefer soroban.prepare() which handles
 * simulation and assembly in one step.
 */
export async function simulateTransaction(
  rpcUrl: string,
  networkPassphrase: string,
  transactionXdr: string,
): Promise<SorokitResult<SimulateTransactionResult>> {
  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return ok({ success: false, fee: "0", error: simResult.error });
    }

    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      return ok({ success: true, fee: simResult.minResourceFee ?? "0" });
    }

    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      "Transaction simulation returned an unexpected result.",
      simResult,
    );
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      `Transaction simulation failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
