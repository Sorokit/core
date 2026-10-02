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
import { checkMainnetSafety, type MainnetSafetyOptions } from "../shared/mainnetSafety";
import type { SorokitLogger } from "../shared/logger";
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractStateTracker, SorobanPollConfig } from "./types";
import { extractContractCallIdentity } from "./contractCallIdentity";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";

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
 * Validate Soroban polling configuration (#285).
 * Ensures maxAttempts is a positive integer and intervalMs is a positive number.
 */
export function validateSorobanPollConfig(
  pollConfig?: SorobanPollConfig,
): SorokitResult<never> | undefined {
  if (!pollConfig) return undefined;

  if (
    pollConfig.maxAttempts !== undefined &&
    (typeof pollConfig.maxAttempts !== "number" ||
      isNaN(pollConfig.maxAttempts) ||
      pollConfig.maxAttempts <= 0 ||
      !Number.isInteger(pollConfig.maxAttempts))
  ) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "sorobanPoll.maxAttempts must be a positive integer.",
    );
  }

  if (
    pollConfig.intervalMs !== undefined &&
    (typeof pollConfig.intervalMs !== "number" ||
      isNaN(pollConfig.intervalMs) ||
      pollConfig.intervalMs < 0 ||
      !Number.isFinite(pollConfig.intervalMs))
  ) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "sorobanPoll.intervalMs must be a non-negative number.",
    );
  }

  return undefined;
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
  stateTracker?: ContractStateTracker,
  safetyOptions?: MainnetSafetyOptions,
): Promise<SorokitResult<string>> {
  logger?.debug("soroban.execute", {
    operation: "soroban.execute",
    status: "start",
  });

  const pollErr = validateSorobanPollConfig(pollConfig);
  if (pollErr) return pollErr;

  if (isXdrInvalidError(signedXdr)) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "Failed to submit contract transaction because the signed XDR is malformed.",
      signedXdr,
    );
  }

  const safetyCheck = checkMainnetSafety(signedXdr, networkConfig.networkPassphrase, {
    ...safetyOptions,
    ...(safetyOptions?.logger ? {} : logger ? { logger } : {}),
  });
  if (safetyCheck.status === "error") return safetyCheck;

  // ── Submit ─────────────────────────────────────────────────────────────────
  let hash: string;
  const rpc = createSorobanServer(rpcUrl);
  try {
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
        const identity = extractContractCallIdentity(
          signedXdr,
          networkConfig.networkPassphrase,
        );
        if (identity && stateTracker) {
          await stateTracker.markContractModified(identity.contractId);
        }
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
