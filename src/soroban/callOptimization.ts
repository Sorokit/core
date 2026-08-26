import type { PreparedContractCall } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OptimizationPriority = "high" | "medium" | "low";

export type OptimizationSuggestionType =
  | "excessive_fee"
  | "high_cpu_instructions"
  | "high_memory_usage"
  | "high_ledger_reads"
  | "high_ledger_writes"
  | "consider_read_only"
  | "batch_operations"
  | "already_optimized";

export interface CallOptimizationSuggestion {
  priority: OptimizationPriority;
  type: OptimizationSuggestionType;
  description: string;
  /** Estimated percentage saving, when the underlying metrics support it. */
  estimatedSavingPct?: number;
}

export interface CallOptimizationReport {
  suggestions: CallOptimizationSuggestion[];
  /** Whether sufficient data was available to produce reliable recommendations. */
  dataAvailable: boolean;
  /** Summary of the resource metrics observed, for audit / display. */
  observedMetrics: {
    feeStroops?: number;
    cpuInstructions?: number;
    memoryBytes?: number;
    ledgerReads?: number;
    ledgerWrites?: number;
  };
}

// ── Thresholds (based on Soroban mainnet limits, ~Q1 2026) ───────────────────

const HIGH_FEE_STROOPS = 100_000;       // 0.01 XLM
const MEDIUM_FEE_STROOPS = 10_000;      // 0.001 XLM
const HIGH_CPU_INSTRUCTIONS = 50_000_000;
const MEDIUM_CPU_INSTRUCTIONS = 10_000_000;
const HIGH_MEMORY_BYTES = 5_000_000;    // 5 MB
const HIGH_LEDGER_READS = 50;
const HIGH_LEDGER_WRITES = 25;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze a prepared Soroban contract call and return prioritized optimization
 * suggestions based on observable resource metrics.
 *
 * Recommendations are derived only from the metadata available in the
 * PreparedContractCall — no contract is re-simulated or modified.
 *
 * Heuristic suggestions are clearly marked. Estimated savings are included
 * only when the underlying metrics provide a measurable basis.
 *
 * @param preparedCall - Result from prepareContractCall().
 * @returns A CallOptimizationReport with prioritized suggestions.
 *
 * @example
 * const prepared = await prepareContractCall(rpcUrl, networkConfig, horizonUrl, params);
 * if (prepared.status === "ok") {
 *   const report = analyzeCallOptimization(prepared.data);
 *   for (const s of report.suggestions) {
 *     console.log(`[${s.priority}] ${s.description}`);
 *   }
 * }
 */
export function analyzeCallOptimization(
  preparedCall: PreparedContractCall & {
    simulation?: {
      cpuInstructions?: number;
      memoryBytes?: number;
      ledgerReads?: number;
      ledgerWrites?: number;
      readOnly?: boolean;
    };
  },
): CallOptimizationReport {
  const suggestions: CallOptimizationSuggestion[] = [];
  const sim = preparedCall.simulation;

  const feeStroops = preparedCall.fee !== undefined ? Number(preparedCall.fee) : undefined;
  const cpuInstructions = sim?.cpuInstructions;
  const memoryBytes = sim?.memoryBytes;
  const ledgerReads = sim?.ledgerReads;
  const ledgerWrites = sim?.ledgerWrites;

  const dataAvailable =
    feeStroops !== undefined ||
    cpuInstructions !== undefined ||
    memoryBytes !== undefined ||
    ledgerReads !== undefined ||
    ledgerWrites !== undefined;

  if (!dataAvailable) {
    return {
      suggestions: [],
      dataAvailable: false,
      observedMetrics: {},
    };
  }

  // ── Fee analysis ────────────────────────────────────────────────────────────

  if (feeStroops !== undefined) {
    if (feeStroops > HIGH_FEE_STROOPS) {
      const estimatedSavingPct = Math.round(
        ((feeStroops - MEDIUM_FEE_STROOPS) / feeStroops) * 100,
      );
      suggestions.push({
        priority: "high",
        type: "excessive_fee",
        description:
          `Fee is ${feeStroops} stroops — significantly above typical levels. ` +
          "Consider reducing resource footprint (fewer ledger writes, lower CPU) to bring the fee down.",
        estimatedSavingPct,
      });
    } else if (feeStroops > MEDIUM_FEE_STROOPS) {
      suggestions.push({
        priority: "medium",
        type: "excessive_fee",
        description:
          `Fee is ${feeStroops} stroops — above average. ` +
          "Heuristic: reducing ledger entry writes or loop iterations may lower the fee.",
      });
    }
  }

  // ── CPU analysis ────────────────────────────────────────────────────────────

  if (cpuInstructions !== undefined) {
    if (cpuInstructions > HIGH_CPU_INSTRUCTIONS) {
      suggestions.push({
        priority: "high",
        type: "high_cpu_instructions",
        description:
          `CPU instruction count is ${cpuInstructions.toLocaleString()} — approaching limits. ` +
          "Consider caching intermediate results, reducing loops, or splitting into multiple calls.",
        estimatedSavingPct: Math.round(
          ((cpuInstructions - MEDIUM_CPU_INSTRUCTIONS) / cpuInstructions) * 100,
        ),
      });
    } else if (cpuInstructions > MEDIUM_CPU_INSTRUCTIONS) {
      suggestions.push({
        priority: "medium",
        type: "high_cpu_instructions",
        description:
          `CPU instruction count is ${cpuInstructions.toLocaleString()}. ` +
          "Heuristic: review any unbounded iteration over contract data maps.",
      });
    }
  }

  // ── Memory analysis ─────────────────────────────────────────────────────────

  if (memoryBytes !== undefined && memoryBytes > HIGH_MEMORY_BYTES) {
    suggestions.push({
      priority: "medium",
      type: "high_memory_usage",
      description:
        `Memory usage is ${(memoryBytes / 1_000_000).toFixed(1)} MB. ` +
        "Heuristic: avoid loading full contract state in a single call — use pagination or lazy loading.",
    });
  }

  // ── Ledger entry analysis ───────────────────────────────────────────────────

  if (ledgerReads !== undefined && ledgerReads > HIGH_LEDGER_READS) {
    suggestions.push({
      priority: "medium",
      type: "high_ledger_reads",
      description:
        `${ledgerReads} ledger entries are read — consider batching reads or caching frequently accessed entries off-chain.`,
    });
  }

  if (ledgerWrites !== undefined && ledgerWrites > HIGH_LEDGER_WRITES) {
    suggestions.push({
      priority: "high",
      type: "high_ledger_writes",
      description:
        `${ledgerWrites} ledger entries are written — each write has a significant fee impact. ` +
        "Consider deferring non-critical writes or aggregating state updates.",
      estimatedSavingPct: Math.round(((ledgerWrites - HIGH_LEDGER_WRITES / 2) / ledgerWrites) * 100),
    });
  }

  // ── Read-only suggestion ────────────────────────────────────────────────────

  if (
    sim?.readOnly === false &&
    ledgerWrites !== undefined &&
    ledgerWrites === 0 &&
    (ledgerReads ?? 0) > 0
  ) {
    suggestions.push({
      priority: "low",
      type: "consider_read_only",
      description:
        "This call performs no ledger writes. If the contract method is purely read-only, " +
        "consider using readContract() instead — it skips auth assembly and reduces fee.",
    });
  }

  // ── Already optimized ───────────────────────────────────────────────────────

  if (suggestions.length === 0) {
    suggestions.push({
      priority: "low",
      type: "already_optimized",
      description: "No optimization opportunities detected based on the available metrics.",
    });
  }

  // Sort: high → medium → low
  const priorityOrder: Record<OptimizationPriority, number> = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const observedMetrics: {
    feeStroops?: number;
    cpuInstructions?: number;
    memoryBytes?: number;
    ledgerReads?: number;
    ledgerWrites?: number;
  } = {};
  if (feeStroops !== undefined) observedMetrics.feeStroops = feeStroops;
  if (cpuInstructions !== undefined) observedMetrics.cpuInstructions = cpuInstructions;
  if (memoryBytes !== undefined) observedMetrics.memoryBytes = memoryBytes;
  if (ledgerReads !== undefined) observedMetrics.ledgerReads = ledgerReads;
  if (ledgerWrites !== undefined) observedMetrics.ledgerWrites = ledgerWrites;

  return {
    suggestions,
    dataAvailable: true,
    observedMetrics,
  };
}
