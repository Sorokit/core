import {
  BASE_FEE,
  Contract,
  Horizon,
  scValToNative,
  rpc as SorobanRpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { SorokitResult } from "../shared/response";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { deduplicateRequest } from "../shared/utils";
import { validateContractMethodMetadata } from "./contractMetadata";
import { createContractReadCacheKey } from "./contractCallIdentity";
import type { ContractCallResult, ContractReadParams } from "./types";
import { validateContractAbi } from "./validateContractAbi";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { validatePublicKey } from "../shared/validation";
import { mapSorobanRpcResult } from "./rpcErrorMapper";
import { mapRpcError } from "../shared/errorMapping";

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
export async function readContract(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: ContractReadParams,
): Promise<SorokitResult<ContractCallResult>> {
  // ── Input validation (before any network call or side effect) ──────────────
  const pkResult = validatePublicKey(params.publicKey);
  if (pkResult.status === "error") {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `publicKey — ${pkResult.error.message}`,
    );
  }
  // ── End input validation ───────────────────────────────────────────────────

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
  const useCache = cache !== undefined && params.bypassCache !== true;
  const ttlMs = params.ttlMs ?? 5 * 60 * 1000; // Default 5 minutes
  const revision = useCache
    ? await params.stateTracker?.getRevision(params.contractId) ?? 0
    : 0;
  const cacheKey = useCache
    ? createContractReadCacheKey(
        params.contractId,
        params.method,
        params.args,
        revision,
        networkConfig.networkPassphrase,
      )
    : undefined;

  // Check cache if available and not explicitly bypassed.
  if (useCache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached != null) {
      return ok(cached as ContractCallResult);
    }
  }

  // Deduplicate concurrent identical reads
  const performRead = async (): Promise<SorokitResult<ContractCallResult>> => {
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

      const simResult = await rpc.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        // Simulation-error responses are structured objects returned by the RPC
        // server (not thrown exceptions). mapSorobanRpcResult applies text-regex
        // classification over aggregated fields (message, detail, error, code text)
        // and can produce fine-grained codes such as RATE_LIMITED, INVALID_AUTH,
        // INSUFFICIENT_FEE, XDR_INVALID, or SOROBAN_SIMULATION_FAILED. These are
        // semantically richer than the numeric-code dispatch in mapRpcError, which
        // is designed for thrown JSON-RPC 2.0 error objects reaching the catch block.
        return mapSorobanRpcResult<ContractCallResult>(simResult);
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
      if (useCache && cacheKey) {
        cache.set(cacheKey, result, ttlMs);
      }

      return ok(result);
    } catch (cause) {
      const mapped = mapRpcError(cause);
      return err(
        mapped.code,
        mapped.message,
        mapped.originalError,
      ) as SorokitResult<ContractCallResult>;
    }
  };

  if (useCache && cacheKey) {
    return deduplicateRequest(cacheKey, performRead);
  }

  return performRead();
}
