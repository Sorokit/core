/**
 * Resource and Fee Estimation Explainer
 *
 * Parses simulation responses to extract resource usage and fee breakdown
 * by component (CPU, memory, network, storage) with optimization suggestions.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SimulateTransactionResult } from "./types";

/**
 * Fee component breakdown.
 */
export interface FeeComponent {
  /** Fee in stroops */
  stroops: string;
  /** Numeric value */
  value: bigint;
}

/**
 * Resource usage metrics.
 */
export interface ResourceMetrics {
  /** CPU operations */
  ops?: string | undefined;
  /** Memory bytes used */
  bytes?: string | undefined;
}

/**
 * Fee breakdown by component.
 */
export interface FeeBreakdown {
  /** Total fee in stroops */
  totalFee: string;
  /** CPU cost */
  cpu: FeeComponent & ResourceMetrics;
  /** Memory cost */
  memory: FeeComponent & ResourceMetrics;
  /** Network cost */
  network: FeeComponent & ResourceMetrics;
  /** Storage cost */
  storage: FeeComponent & ResourceMetrics;
}

/**
 * Fee explanation result.
 */
export interface FeeExplanation {
  /** Total fee in stroops */
  totalFee: string;
  /** Total fee in XLM (1 XLM = 10^7 stroops) */
  totalFeeXlm: string;
  /** Fee breakdown by component */
  components: FeeBreakdown;
  /** Optimization suggestions */
  suggestions: string[];
  /** Overall resource usage summary */
  summary: {
    /** High-cost components */
    highCost: string[];
    /** Low-cost components */
    lowCost: string[];
    /** Dominant resource */
    dominant: string;
  };
}

/**
 * Thresholds for determining high/low cost components.
 */
const COST_THRESHOLDS = {
  HIGH_COST_RATIO: 0.3, // Component > 30% of total is high-cost
  LOW_COST_RATIO: 0.05, // Component < 5% of total is low-cost
  HIGH_MEMORY_BYTES: 100_000, // > 100KB memory is high
  HIGH_CPU_OPS: 10_000_000, // > 10M CPU ops is high
};

/**
 * Explain contract fees from a simulation result.
 *
 * @param simResult - Simulation result from simulateTransaction
 * @returns Fee explanation with breakdown and suggestions
 */
export function explainContractFees(
  simResult: SimulateTransactionResult,
): SorokitResult<FeeExplanation> {
  if (!simResult.success) {
    return err(
      SorokitErrorCode.SOROBAN_SIMULATION_FAILED,
      "Cannot explain fees for failed simulation",
    );
  }

  const totalFee = BigInt(simResult.fee || "0");
  const resourceUsage = simResult.resourceUsage;

  // Parse resource usage and estimate component costs
  const breakdown = estimateFeeBreakdown(totalFee, resourceUsage);

  // Generate suggestions based on breakdown
  const suggestions = generateSuggestions(breakdown, resourceUsage);

  // Analyze summary
  const summary = analyzeSummary(breakdown);

  // Convert total fee to XLM
  const totalFeeXlm = (Number(totalFee) / 10_000_000).toFixed(7);

  return ok({
    totalFee: simResult.fee,
    totalFeeXlm,
    components: breakdown,
    suggestions,
    summary,
  });
}

/**
 * Estimate fee breakdown by component from total fee and resource usage.
 */
function estimateFeeBreakdown(
  totalFee: bigint,
  resourceUsage?: SimulateTransactionResult["resourceUsage"],
): FeeBreakdown {
  // Default distribution if no resource usage available
  if (!resourceUsage) {
    const defaultDistribution = {
      cpu: 0.4,
      memory: 0.3,
      network: 0.2,
      storage: 0.1,
    };

    return {
      totalFee: totalFee.toString(),
      cpu: {
        stroops: (totalFee * BigInt(Math.floor(defaultDistribution.cpu * 100)) / BigInt(100)).toString(),
        value: totalFee * BigInt(Math.floor(defaultDistribution.cpu * 100)) / BigInt(100),
        ops: "unknown",
        bytes: undefined,
      },
      memory: {
        stroops: (totalFee * BigInt(Math.floor(defaultDistribution.memory * 100)) / BigInt(100)).toString(),
        value: totalFee * BigInt(Math.floor(defaultDistribution.memory * 100)) / BigInt(100),
        ops: undefined,
        bytes: "unknown",
      },
      network: {
        stroops: (totalFee * BigInt(Math.floor(defaultDistribution.network * 100)) / BigInt(100)).toString(),
        value: totalFee * BigInt(Math.floor(defaultDistribution.network * 100)) / BigInt(100),
        ops: undefined,
        bytes: "unknown",
      },
      storage: {
        stroops: (totalFee * BigInt(Math.floor(defaultDistribution.storage * 100)) / BigInt(100)).toString(),
        value: totalFee * BigInt(Math.floor(defaultDistribution.storage * 100)) / BigInt(100),
        ops: "unknown",
        bytes: undefined,
      },
    };
  }

  // Estimate based on actual resource usage
  const instructions = BigInt(resourceUsage.instructions || "0");
  const readBytes = BigInt(resourceUsage.readBytes || 0);
  const writeBytes = BigInt(resourceUsage.writeBytes || 0);
  const readEntries = BigInt(resourceUsage.readLedgerEntries || 0);
  const writeEntries = BigInt(resourceUsage.writeLedgerEntries || 0);

  // Heuristic cost weights (these are approximations)
  const CPU_WEIGHT = 1n;
  const MEMORY_WEIGHT = 2n;
  const NETWORK_WEIGHT = 3n;
  const STORAGE_WEIGHT = 5n;

  // Calculate weighted costs
  const cpuCost = instructions * CPU_WEIGHT;
  const memoryCost = (readBytes + writeBytes) * MEMORY_WEIGHT;
  const networkCost = (readBytes + writeBytes) * NETWORK_WEIGHT / BigInt(10); // Network is lighter per byte
  const storageCost = (readEntries + writeEntries) * STORAGE_WEIGHT * BigInt(1000); // Storage is expensive

  const totalWeightedCost = cpuCost + memoryCost + networkCost + storageCost;

  // Distribute actual fee based on weighted costs
  const cpuFee = totalWeightedCost > BigInt(0) 
    ? (totalFee * cpuCost) / totalWeightedCost 
    : totalFee / BigInt(4);
  const memoryFee = totalWeightedCost > BigInt(0) 
    ? (totalFee * memoryCost) / totalWeightedCost 
    : totalFee / BigInt(4);
  const networkFee = totalWeightedCost > BigInt(0) 
    ? (totalFee * networkCost) / totalWeightedCost 
    : totalFee / BigInt(4);
  const storageFee = totalWeightedCost > BigInt(0) 
    ? (totalFee * storageCost) / totalWeightedCost 
    : totalFee / BigInt(4);

  return {
    totalFee: totalFee.toString(),
    cpu: {
      stroops: cpuFee.toString(),
      value: cpuFee,
      ops: resourceUsage.instructions || undefined,
      bytes: undefined,
    },
    memory: {
      stroops: memoryFee.toString(),
      value: memoryFee,
      ops: undefined,
      bytes: (readBytes + writeBytes).toString() || undefined,
    },
    network: {
      stroops: networkFee.toString(),
      value: networkFee,
      ops: undefined,
      bytes: (readBytes + writeBytes).toString() || undefined,
    },
    storage: {
      stroops: storageFee.toString(),
      value: storageFee,
      ops: (readEntries + writeEntries).toString() || undefined,
      bytes: undefined,
    },
  };
}

/**
 * Generate optimization suggestions based on fee breakdown.
 */
function generateSuggestions(
  breakdown: FeeBreakdown,
  resourceUsage?: SimulateTransactionResult["resourceUsage"],
): string[] {
  const suggestions: string[] = [];
  const totalFee = BigInt(breakdown.totalFee);

  // Check CPU usage
  const cpuRatio = Number(breakdown.cpu.value) / Number(totalFee);
  if (cpuRatio > COST_THRESHOLDS.HIGH_COST_RATIO) {
    suggestions.push("CPU usage is high, consider optimizing computation loops and reducing complex operations");
  }

  // Check memory usage
  const memoryRatio = Number(breakdown.memory.value) / Number(totalFee);
  if (memoryRatio > COST_THRESHOLDS.HIGH_COST_RATIO) {
    suggestions.push("Memory usage is high, consider reducing data storage in contract state and optimizing data structures");
  }

  // Check network usage
  const networkRatio = Number(breakdown.network.value) / Number(totalFee);
  if (networkRatio > COST_THRESHOLDS.HIGH_COST_RATIO) {
    suggestions.push("Network usage is high, consider batching operations and reducing data transfer size");
  }

  // Check storage usage
  const storageRatio = Number(breakdown.storage.value) / Number(totalFee);
  if (storageRatio > COST_THRESHOLDS.HIGH_COST_RATIO) {
    suggestions.push("Storage usage is high, consider reducing ledger entry writes and using temporary storage where possible");
  }

  // Check specific resource thresholds
  if (resourceUsage) {
    const instructions = Number(resourceUsage.instructions || 0);
    if (instructions > COST_THRESHOLDS.HIGH_CPU_OPS) {
      suggestions.push(`CPU operations (${instructions.toLocaleString()}) exceed recommended threshold, consider algorithmic optimizations`);
    }

    const totalBytes = (resourceUsage.readBytes || 0) + (resourceUsage.writeBytes || 0);
    if (totalBytes > COST_THRESHOLDS.HIGH_MEMORY_BYTES) {
      suggestions.push(`Memory usage (${(totalBytes / 1024).toFixed(2)} KB) exceeds recommended threshold, consider data compression`);
    }
  }

  // General suggestions
  if (suggestions.length === 0) {
    suggestions.push("Fee distribution is balanced, no immediate optimizations needed");
  }

  return suggestions;
}

/**
 * Analyze fee breakdown to generate summary.
 */
function analyzeSummary(breakdown: FeeBreakdown): FeeExplanation["summary"] {
  const totalFee = BigInt(breakdown.totalFee);
  const components = [
    { name: "cpu", value: breakdown.cpu.value },
    { name: "memory", value: breakdown.memory.value },
    { name: "network", value: breakdown.network.value },
    { name: "storage", value: breakdown.storage.value },
  ];

  const highCost: string[] = [];
  const lowCost: string[] = [];

  for (const comp of components) {
    const ratio = Number(comp.value) / Number(totalFee);
    if (ratio > COST_THRESHOLDS.HIGH_COST_RATIO) {
      highCost.push(comp.name);
    } else if (ratio < COST_THRESHOLDS.LOW_COST_RATIO) {
      lowCost.push(comp.name);
    }
  }

  // Find dominant resource
  const dominant = components.reduce((max, comp) => 
    comp.value > max.value ? comp : max
  ).name;

  return {
    highCost,
    lowCost,
    dominant,
  };
}

/**
 * Compare two fee explanations to see the difference.
 */
export function compareFeeExplanations(
  before: FeeExplanation,
  after: FeeExplanation,
): SorokitResult<{
  feeDifference: string;
  feeDifferenceXlm: string;
  percentageChange: string;
  componentChanges: Record<string, { before: string; after: string; change: string }>;
}> {
  const beforeFee = BigInt(before.totalFee);
  const afterFee = BigInt(after.totalFee);
  const diff = afterFee - beforeFee;
  const percentage = beforeFee > 0n 
    ? ((Number(diff) / Number(beforeFee)) * 100).toFixed(2)
    : "0.00";

  const componentChanges: Record<string, { before: string; after: string; change: string }> = {
    cpu: {
      before: before.components.cpu.stroops,
      after: after.components.cpu.stroops,
      change: (BigInt(after.components.cpu.stroops) - BigInt(before.components.cpu.stroops)).toString(),
    },
    memory: {
      before: before.components.memory.stroops,
      after: after.components.memory.stroops,
      change: (BigInt(after.components.memory.stroops) - BigInt(before.components.memory.stroops)).toString(),
    },
    network: {
      before: before.components.network.stroops,
      after: after.components.network.stroops,
      change: (BigInt(after.components.network.stroops) - BigInt(before.components.network.stroops)).toString(),
    },
    storage: {
      before: before.components.storage.stroops,
      after: after.components.storage.stroops,
      change: (BigInt(after.components.storage.stroops) - BigInt(before.components.storage.stroops)).toString(),
    },
  };

  return ok({
    feeDifference: diff.toString(),
    feeDifferenceXlm: (Number(diff) / 10_000_000).toFixed(7),
    percentageChange: percentage,
    componentChanges,
  });
}
