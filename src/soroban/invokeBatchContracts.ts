import type { SorokitLogger } from "../shared/logger";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorobanPollConfig, BatchContractInvocation, BatchContractResult } from "./types";
import { invokeContract } from "./invokeContract";

/**
 * Execute multiple Soroban contract calls in parallel using Promise.allSettled.
 * Each invocation runs independently — partial failures are captured per-result.
 * Returns an array of BatchContractResult in the same order as invocations[].
 */
export async function invokeBatchContracts(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  invocations: BatchContractInvocation[],
  signFn: (xdr: string) => Promise<string>,
  options?: {
    pollConfig?: SorobanPollConfig;
    logger?: SorokitLogger;
  },
): Promise<BatchContractResult[]> {
  const settled = await Promise.allSettled(
    invocations.map((inv) => {
      const params: Parameters<typeof invokeContract>[3] = {
        contractId: inv.contractId,
        method: inv.method,
        publicKey: inv.publicKey,
        ...(inv.args !== undefined && { args: inv.args }),
        ...(inv.cachedMetadata !== undefined && { cachedMetadata: inv.cachedMetadata }),
        ...(inv.contractAbi !== undefined && { contractAbi: inv.contractAbi }),
      };
      return invokeContract(
        rpcUrl,
        networkConfig,
        horizonUrl,
        params,
        signFn,
        options?.pollConfig,
        options?.logger,
      );
    }),
  );

  return invocations.map((inv, i) => {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      if (result.status === "ok") {
        return {
          status: "ok" as const,
          data: result.data,
          contractId: inv.contractId,
          method: inv.method,
        };
      }
      return {
        status: "error" as const,
        error: { code: result.error.code, message: result.error.message },
        contractId: inv.contractId,
        method: inv.method,
      };
    }
    return {
      status: "error" as const,
      error: { code: "UNKNOWN", message: String(outcome.reason) },
      contractId: inv.contractId,
      method: inv.method,
    };
  });
}
