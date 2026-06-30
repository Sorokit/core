import {
  BASE_FEE,
  Contract,
  Horizon,
  scValToNative,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { SorokitResult } from "../shared/response";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { deduplicateRequest } from "../shared/utils";
import { validateContractMethodMetadata } from "./contractMetadata";
import type { ContractCallResult, ContractReadParams } from "./types";
import { validateContractAbi } from "./validateContractAbi";

/**
 * Read (simulate) a Soroban contract view function — no signing required.
 *
 * Validates the method signature against the provided ABI before simulating,
 * decodes the XDR result back to a native JS value, and wraps it in a
 * `ContractCallResult`. All network errors are returned as `SorokitResult`
 * errors rather than thrown.
 *
 * Supports optional caching with configurable TTL. When a cache is provided,
 * results are cached using SHA256(contractId + method + argsXdr) as the key.
 * Concurrent identical reads share a single RPC call via deduplication.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param horizonUrl    - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param params        - Contract read parameters: `contractId`, `publicKey`, `method`, `args`, `contractAbi`, `cache`, `ttlMs`.
 * @returns `ok(ContractCallResult)` with the decoded return value,
 *          or `error(CONTRACT_READ_FAILED)` on failure.
 *
 * @example
 * const result = await readContract(rpcUrl, horizonUrl, networkConfig, {
 *   contractId: "CABC...",
 *   publicKey: "GSOURCE...",
 *   method: "balance",
 *   args: [],
 *   contractAbi: myAbi,
 * });
 * if (result.status === "ok") {
 *   console.log("Return value:", result.data.result);
 * }
 */
function generateCacheKey(
  contractId: string,
  method: string,
  args?: xdr.ScVal[],
): string {
  let argsXdr = "";
  try {
    argsXdr = args?.map((arg) => arg.toXDR("base64")).join("") ?? "";
  } catch {
    // If args can't be serialized to XDR (e.g., in tests with mocks),
    // use JSON stringification as a fallback
    argsXdr = args ? JSON.stringify(args) : "";
  }
  const inputString = contractId + method + argsXdr;
  return createHash("sha256").update(inputString).digest("hex");
}

export async function readContract(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: ContractReadParams,
): Promise<SorokitResult<ContractCallResult>> {
  const abiValidation = validateContractAbi({
    contractAbi: params.contractAbi,
    method: params.method,
    argCount: params.args?.length ?? 0,
  });
  if (abiValidation.status === "error") {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      abiValidation.error.message,
      abiValidation.error.cause,
    );
  }

  const metadataResult = validateContractMethodMetadata(
    params.cachedMetadata,
    params.method,
    params.args?.length ?? 0,
    SorokitErrorCode.CONTRACT_READ_FAILED,
  );
  if (metadataResult.status === "error") return metadataResult;

  const cache = params.cache;
  const cacheKey = cache
    ? generateCacheKey(params.contractId, params.method, params.args)
    : undefined;
  const ttlMs = params.ttlMs ?? 5 * 60 * 1000; // Default 5 minutes

  // Check cache if available
  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached != null) {
      return ok(cached as ContractCallResult);
    }
  }

  // Deduplicate concurrent identical reads
  const performRead = async (): Promise<SorokitResult<ContractCallResult>> => {
    try {
      const rpc = new SorobanRpc.Server(rpcUrl);
      const horizonServer = new Horizon.Server(horizonUrl);
      const contract = new Contract(params.contractId);

      const sourceAccount = await horizonServer
        .loadAccount(params.publicKey)
        .catch((cause) => {
          throw new Error(
            `Could not load source account ${params.publicKey}: ${toMessage(cause)}`,
          );
        });

      const operation = contract.call(params.method, ...(params.args ?? []));

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: networkConfig.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
        .build();

      const simResult = await rpc.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        return err(
          SorokitErrorCode.CONTRACT_READ_FAILED,
          `Contract simulation error: ${simResult.error}`,
          simResult,
        );
      }

      if (!SorobanRpc.Api.isSimulationSuccess(simResult) || !simResult.result) {
        return err(
          SorokitErrorCode.CONTRACT_READ_FAILED,
          "Contract simulation returned no result.",
        );
      }

      const scVal = simResult.result.retval;
      const result = { result: scVal, value: scValToNative(scVal) };

      // Cache successful result
      if (cache && cacheKey) {
        cache.set(cacheKey, result, ttlMs);
      }

      return ok(result);
    } catch (cause) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `Failed to read contract: ${toMessage(cause)}`,
        cause,
      );
    }
  };

  if (cache && cacheKey) {
    return deduplicateRequest(cacheKey, performRead);
  }

  return performRead();
}
