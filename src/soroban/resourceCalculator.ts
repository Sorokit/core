import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface ResourceEstimate { contractId: string; method: string; cpuUnits: number; memoryBytes: number; storageBytes: number; estimatedFee: string; }
export interface ResourceCalculatorOptions { cpuPerArgument?: number; memoryPerArgument?: number; storagePerArgument?: number; stroopsPerCpuUnit?: number; }

/** Estimate relative Soroban resource usage before an invocation is prepared. */
export function estimateResources(contractId: string, method: string, args: readonly unknown[] = [], options: ResourceCalculatorOptions = {}): SorokitResult<ResourceEstimate> {
  if (!contractId.trim() || !method.trim()) return err(SorokitErrorCode.VALIDATION, "contractId and method are required");
  const cpuUnits = 10_000 + method.length * 100 + args.length * (options.cpuPerArgument ?? 2_000);
  const memoryBytes = 512 + method.length * 16 + args.length * (options.memoryPerArgument ?? 256);
  const storageBytes = args.reduce<number>((total, arg) => total + (JSON.stringify(arg)?.length ?? 0), 0) + args.length * (options.storagePerArgument ?? 32);
  return ok({ contractId, method, cpuUnits, memoryBytes, storageBytes, estimatedFee: String(Math.ceil(cpuUnits * (options.stroopsPerCpuUnit ?? 1))) });
}
