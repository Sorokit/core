import { rpc as SorobanRpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage, sleep } from "../shared";
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorobanPollConfig } from "./types";

/**
 * Execute step of the Soroban invoke flow: submit → poll for confirmation.
 *
 * This is step 3 of the pipeline (after prepare and sign).
 * It takes a signed XDR and drives it to on-chain confirmation.
 *
 * Called by invokeContract() — can also be called directly when you
 * have already prepared and signed a transaction externally.
 *
 * Returns the confirmed transaction hash on success.
 */
export async function executeContract(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  signedXdr: string,
  pollConfig?: SorobanPollConfig,
): Promise<SorokitResult<string>> {
  // ── Submit ─────────────────────────────────────────────────────────────────
  let hash: string;
  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const tx = TransactionBuilder.fromXDR(
      signedXdr,
      networkConfig.networkPassphrase,
    );
    const sendResult = await rpc.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      return err(
        SorokitErrorCode.CONTRACT_INVOKE_FAILED,
        `Contract invocation failed on submission: ${
          sendResult.errorResult?.toXDR() ?? "unknown error"
        }`,
        sendResult,
      );
    }

    hash = sendResult.hash;
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      `Failed to submit contract transaction: ${toMessage(cause)}`,
      cause,
    );
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  const maxAttempts = pollConfig?.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
  const intervalMs = pollConfig?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(intervalMs);
      const statusResult = await rpc.getTransaction(hash);

      if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return ok(hash);
      }

      if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return err(
          SorokitErrorCode.CONTRACT_INVOKE_FAILED,
          `Contract transaction failed on-chain: ${hash}`,
          statusResult,
        );
      }
      // PENDING — continue polling
    }

    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      `Contract transaction timed out after ${maxAttempts} attempts: ${hash}`,
    );
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      `Error while polling contract transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}
