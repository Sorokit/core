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
  retryWithBackoff,
  toMessage,
} from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ContractInvokeParams, PreparedContractCall } from "./types";
import { validateContractMethodMetadata } from "./contractMetadata";
import { validateContractAbi } from "./validateContractAbi";

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

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const horizonServer = new Horizon.Server(horizonUrl);
    const contract = new Contract(params.contractId);

    const sourceAccount = await horizonServer.loadAccount(params.publicKey);
    const operation = contract.call(params.method, ...(params.args ?? []));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();

    const simResult = await retryWithBackoff(async () => {
      return await rpc.simulateTransaction(tx);
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

    return ok({
      transactionXdr: assembled.toXDR(),
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
