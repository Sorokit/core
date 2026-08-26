import {
  rpc as SorobanRpc,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  retryWithBackoff,
  toMessage,
} from "../shared";
import { isValidContractId } from "../shared/utils";
import { DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractInvokeParams, PreparedContractCall } from "./types";
import { validateContractMethodMetadata, validateContractArgs } from "./contractMetadata";
import { validateContractAbi } from "./validateContractAbi";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { CircuitBreakerRegistry } from "../network/circuitBreaker";

// Shared circuit breaker registry for RPC operations
const rpcCircuitBreaker = new CircuitBreakerRegistry({
  failureThreshold: 5,
  recoveryWindowMs: 30_000,
});

function describePrepareFailure(cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Contract preparation timed out while contacting RPC: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Contract preparation failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Failed to prepare contract call: ${toMessage(cause)}`;
}

/**
 * Prepare step of the Soroban invoke pipeline.
 *
 * Flow: build → simulate → assemble (auth + footprint + fee)
 * Returns the assembled XDR ready to be signed.
 *
 * This is step 1 of the pipeline. Use invokeContract() for the full flow,
 * or call this directly when you need to inspect the prepared transaction
 * before signing.
 */
export async function prepareContractCall(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  params: ContractInvokeParams,
): Promise<SorokitResult<PreparedContractCall>> {
  if (!isValidContractId(params.contractId)) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Invalid contract ID: '${params.contractId}'. Expected a C-prefixed 56-character Stellar base32 string.`,
    );
  }

  if (!params.method || params.method.trim().length === 0) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      "Contract method name must not be empty.",
    );
  }

  const abiValidation = validateContractAbi({
    contractAbi: params.contractAbi,
    method: params.method,
    argCount: params.args?.length ?? 0,
  });
  if (abiValidation.status === "error") return abiValidation;

  const metadataResult = validateContractMethodMetadata(
    params.cachedMetadata,
    params.method,
    params.args?.length ?? 0,
    SorokitErrorCode.CONTRACT_PREPARE_FAILED,
  );
  if (metadataResult.status === "error") return metadataResult;

  if (params.cachedMetadata && params.args?.length) {
    const methodMeta = params.cachedMetadata.find((m) => m.name === params.method);
    if (methodMeta) {
      const argsValidation = validateContractArgs(
        methodMeta,
        params.args,
        SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      );
      if (argsValidation.status === "error") return argsValidation;
    }
  }

  try {
    const rpc = createSorobanServer(rpcUrl);
    const horizonServer = createHorizonServer(horizonUrl);
    const contract = new Contract(params.contractId);

    const sourceAccount = await horizonServer.loadAccount(params.publicKey);
    const operation = contract.call(params.method, ...(params.args ?? []));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS)
      .build();

    const simResult = await rpcCircuitBreaker.call(rpcUrl, async () => {
      return await retryWithBackoff(async () => {
        return await rpc.simulateTransaction(tx);
      });
    });

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return err(
        SorokitErrorCode.CONTRACT_PREPARE_FAILED,
        `Contract simulation error: ${simResult.error}`,
        simResult,
      );
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      return err(
        SorokitErrorCode.CONTRACT_PREPARE_FAILED,
        "Contract simulation did not succeed.",
      );
    }

    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();
    const assembledXdr = assembled.toXDR();

    if (isXdrInvalidError(assembledXdr)) {
      return err(
        SorokitErrorCode.CONTRACT_PREPARE_FAILED,
        "Assembled contract call produced malformed XDR.",
      );
    }

    return ok({
      transactionXdr: assembledXdr,
      fee: assembled.fee,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      describePrepareFailure(cause),
      cause,
    );
  }
}
