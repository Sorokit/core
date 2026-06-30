import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitLogger } from "../shared/logger";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorobanPollConfig, BatchContractInvocation, BatchContractResult } from "./types";
import { invokeContract } from "./invokeContract";

function toInvokeParams(
  inv: BatchContractInvocation,
): Parameters<typeof invokeContract>[3] {
  return {
    contractId: inv.contractId,
    method: inv.method,
    publicKey: inv.publicKey,
    ...(inv.args !== undefined && { args: inv.args }),
    ...(inv.cachedMetadata !== undefined && { cachedMetadata: inv.cachedMetadata }),
    ...(inv.contractAbi !== undefined && { contractAbi: inv.contractAbi }),
  };
}

function toBatchResult(
  inv: BatchContractInvocation,
  outcome: PromiseSettledResult<SorokitResult<string>>,
): BatchContractResult {
  if (outcome.status === "fulfilled") {
    const result = outcome.value;
    if (result.status === "ok") {
      return {
        status: "ok",
        data: result.data,
        contractId: inv.contractId,
        method: inv.method,
      };
    }
    return {
      status: "error",
      error: { code: result.error.code, message: result.error.message },
      contractId: inv.contractId,
      method: inv.method,
    };
  }
  return {
    status: "error",
    error: {
      code: SorokitErrorCode.UNKNOWN,
      message: String(outcome.reason),
    },
    contractId: inv.contractId,
    method: inv.method,
  };
}

/**
 * Execute multiple Soroban contract calls using the same prepare → sign → execute
 * pipeline as invokeContract().
 *
 * By default runs invocations in parallel via Promise.allSettled(). Each call
 * runs independently — partial failures are captured per-result. Returns results
 * in the same order as invocations[].
 */
export async function invokeBatchContracts(
  rpcUrl: string,
  networkConfig: ResolvedNetworkConfig,
  horizonUrl: string,
  invocations: BatchContractInvocation[],
  signFn: (xdr: string) => Promise<string>,
  options?: {
    parallel?: boolean;
    pollConfig?: SorobanPollConfig;
    logger?: SorokitLogger;
  },
): Promise<BatchContractResult[]> {
  const runInvocation = (inv: BatchContractInvocation) =>
    invokeContract(
      rpcUrl,
      networkConfig,
      horizonUrl,
      toInvokeParams(inv),
      signFn,
      options?.pollConfig,
      options?.logger,
    );

  if (options?.parallel === false) {
    const results: BatchContractResult[] = [];
    for (const inv of invocations) {
      try {
        results.push(toBatchResult(inv, { status: "fulfilled", value: await runInvocation(inv) }));
      } catch (reason) {
        results.push(toBatchResult(inv, { status: "rejected", reason }));
      }
    }
    return results;
  }

  const settled = await Promise.allSettled(invocations.map(runInvocation));
  return invocations.map((inv, i) => toBatchResult(inv, settled[i]!));
}
