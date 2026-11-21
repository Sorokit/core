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
import { validatePublicKey } from "../shared/validation";
import { validateContractMethodMetadata, validateContractArgs, getContractMethods } from "./contractMetadata";
import { validateContractAbi } from "./validateContractAbi";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { CircuitBreakerRegistry } from "../network/circuitBreaker";
import { optimizeContractArgs } from "./optimizeArgs";

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

  // ── Validate the invoking account public key before any network call ───────
  const pkResult = validatePublicKey(params.publicKey);
  if (pkResult.status === "error") {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `publicKey — ${pkResult.error.message}`,
    );
  }
  // ── End input validation ───────────────────────────────────────────────────

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

  // #843: when the caller supplies neither a cachedMetadata list nor a
  // contractAbi, fall back to discovering the contract's methods from its
  // deployed Wasm (already cached/deduplicated by getContractMethods) so
  // missing required parameters are still caught here, at build time,
  // instead of being silently passed through to simulation and failing
  // on-chain with an unhelpful error.
  let effectiveMetadata = params.cachedMetadata;
  if (!effectiveMetadata && !params.contractAbi) {
    const discovered = await getContractMethods(rpcUrl, params.contractId);
    if (discovered.status === "ok") {
      effectiveMetadata = discovered.data;
    }
    // If discovery itself fails (e.g. RPC unreachable), proceed without
    // metadata rather than failing prepareContractCall over a validation
    // nicety — the simulation step below will still catch real problems.
  }

  const metadataResult = validateContractMethodMetadata(
    effectiveMetadata,
    params.method,
    params.args?.length ?? 0,
    SorokitErrorCode.CONTRACT_PREPARE_FAILED,
  );
  if (metadataResult.status === "error") return metadataResult;

  // ─── Visibility, authorization, and argument validation ───────────────
  if (effectiveMetadata) {
    const methodMeta = effectiveMetadata.find((m) => m.name === params.method);

    if (methodMeta) {
      // Visibility: reject explicitly non-public methods
      if (methodMeta.visibility && methodMeta.visibility !== "public") {
        return err(
          SorokitErrorCode.CONTRACT_PREPARE_FAILED,
          `Method '${params.method}' has '${methodMeta.visibility}' visibility and cannot be invoked from the client.`,
        );
      }

      // Authorization: validate that the invoking account is authorized
      if (methodMeta.authorizationRequirements?.requiredSigners) {
        const required = methodMeta.authorizationRequirements.requiredSigners;
        if (required.length > 0 && !required.includes(params.publicKey)) {
          return err(
            SorokitErrorCode.CONTRACT_PREPARE_FAILED,
            `Method '${params.method}' requires authorization — the invoking account is not among the authorized signers.`,
          );
        }
      }

      // Argument count and type validation
      if (params.args?.length) {
        const argsValidation = validateContractArgs(
          methodMeta,
          params.args,
          SorokitErrorCode.CONTRACT_PREPARE_FAILED,
        );
        if (argsValidation.status === "error") return argsValidation;
      }
    }
  }

  try {
    const rpc = createSorobanServer(rpcUrl);
    const horizonServer = createHorizonServer(horizonUrl);
    const contract = new Contract(params.contractId);

    const sourceAccount = await horizonServer.loadAccount(params.publicKey);
    const optimizedArgs = optimizeContractArgs(params.args ?? []).args;
    const operation = contract.call(params.method, ...optimizedArgs);

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
