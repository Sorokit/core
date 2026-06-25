import { rpc as SorobanRpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  sleep,
  toMessage,
} from "../shared";
import type { SorokitLogger } from "../shared/logger";
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorobanPollConfig } from "./types";

function describeContractSubmissionFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Failed to submit contract transaction because the signed XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Failed to submit contract transaction because RPC timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Failed to submit contract transaction due to network connectivity: ${toMessage(cause)}`;
  }
  return `Failed to submit contract transaction: ${toMessage(cause)}`;
}

function describeContractPollingFailure(cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Contract transaction polling timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Contract transaction polling failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Error while polling contract transaction: ${toMessage(cause)}`;
}

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
  logger?: SorokitLogger,
): Promise<SorokitResult<string>> {
  logger?.debug("soroban.execute", {
    operation: "soroban.execute",
    status: "start",
  });

  if (isXdrInvalidError(signedXdr)) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "Failed to submit contract transaction because the signed XDR is malformed.",
      signedXdr,
    );
  }

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
      const message = `Contract invocation failed on submission: ${
        sendResult.errorResult?.toXDR() ?? "unknown error"
      }`;
      logger?.warn("soroban.execute.submit", {
        operation: "soroban.execute.submit",
        status: "error",
        errorMessage: message,
      });
      return err(
        SorokitErrorCode.CONTRACT_INVOKE_FAILED,
        message,
        sendResult,
      );
    }

    hash = sendResult.hash;
    logger?.info("soroban.execute.submit", {
      operation: "soroban.execute.submit",
      status: "ok",
      hash,
    });
  } catch (cause) {
    const message = describeContractSubmissionFailure(cause);
    logger?.warn("soroban.execute.submit", {
      operation: "soroban.execute.submit",
      status: "error",
      errorMessage: message,
    });
    return err(SorokitErrorCode.CONTRACT_INVOKE_FAILED, message, cause);
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  const maxAttempts = pollConfig?.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
  const intervalMs = pollConfig?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  logger?.debug("soroban.execute.poll", {
    operation: "soroban.execute.poll",
    status: "start",
    hash,
    maxAttempts,
    intervalMs,
  });

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(intervalMs);
      logger?.debug("soroban.execute.poll.attempt", {
        operation: "soroban.execute.poll.attempt",
        status: "start",
        hash,
        attempt: attempt + 1,
        maxAttempts,
      });

      const statusResult = await rpc.getTransaction(hash);

      if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        logger?.info("soroban.execute.poll", {
          operation: "soroban.execute.poll",
          status: "ok",
          hash,
          attempt: attempt + 1,
        });
        return ok(hash);
      }

      if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const message = `Contract transaction failed on-chain: ${hash}`;
        logger?.warn("soroban.execute.poll", {
          operation: "soroban.execute.poll",
          status: "error",
          hash,
          attempt: attempt + 1,
          errorMessage: message,
        });
        return err(
          SorokitErrorCode.CONTRACT_INVOKE_FAILED,
          message,
          statusResult,
        );
      }

      logger?.debug("soroban.execute.poll.attempt", {
        operation: "soroban.execute.poll.attempt",
        status: "ok",
        hash,
        attempt: attempt + 1,
        txStatus: "PENDING",
      });
      // PENDING — continue polling
    }

    const message = `Contract transaction timed out after ${maxAttempts} attempts: ${hash}`;
    logger?.warn("soroban.execute.poll", {
      operation: "soroban.execute.poll",
      status: "error",
      hash,
      errorMessage: message,
    });
    return err(SorokitErrorCode.CONTRACT_INVOKE_FAILED, message);
  } catch (cause) {
    const message = describeContractPollingFailure(cause);
    logger?.warn("soroban.execute.poll", {
      operation: "soroban.execute.poll",
      status: "error",
      hash,
      errorMessage: message,
    });
    return err(SorokitErrorCode.CONTRACT_INVOKE_FAILED, message, cause);
  }
}
