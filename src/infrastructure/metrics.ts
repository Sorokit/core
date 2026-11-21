/**
 * Operation Metrics Collection — Latencies and Error Rates (#922)
 *
 * Tracks SDK operation durations, Horizon/RPC response times, and error counts
 * with aggregated latency percentiles and error-rate statistics.
 */

export interface InfrastructureDurationRecord {
  operation: string;
  durationMs: number;
  timestamp: number;
}

export interface InfrastructureErrorRecord {
  operation: string;
  message: string;
  code?: string;
  timestamp: number;
}

export interface InfrastructureOperationStats {
  operation: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p95DurationMs: number;
}

export interface InfrastructureMetricsSnapshot {
  durations: InfrastructureDurationRecord[];
  errors: InfrastructureErrorRecord[];
  operations: Record<string, InfrastructureOperationStats>;
  totalOperations: number;
  totalErrors: number;
  overallErrorRate: number;
}

const MAX_RECORDS = 5000;
const durationRecords: InfrastructureDurationRecord[] = [];
const errorRecords: InfrastructureErrorRecord[] = [];
const operationDurations = new Map<string, number[]>();
const operationErrorCounts = new Map<string, number>();

function extractErrorDetails(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code: string }).code)
        : undefined;
    return {
      message: error.message,
      ...(code !== undefined ? { code } : {}),
    };
  }
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const message =
      typeof obj.message === "string" ? obj.message : JSON.stringify(error);
    const code = typeof obj.code === "string" ? obj.code : undefined;
    return {
      message,
      ...(code !== undefined ? { code } : {}),
    };
  }
  return { message: String(error) };
}

function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return sortedValues[idx] ?? 0;
}

/**
 * Record the execution duration (in milliseconds) of an SDK or Horizon operation (#922).
 */
export function recordOperationDuration(name: string, ms: number): void {
  if (typeof name !== "string" || name.trim().length === 0) return;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;

  const normalizedName = name.trim();
  if (durationRecords.length >= MAX_RECORDS) {
    durationRecords.shift();
  }
  durationRecords.push({
    operation: normalizedName,
    durationMs: ms,
    timestamp: Date.now(),
  });

  const existing = operationDurations.get(normalizedName);
  if (existing) {
    existing.push(ms);
  } else {
    operationDurations.set(normalizedName, [ms]);
  }
}

/**
 * Record an error encountered during an SDK or Horizon operation (#922).
 */
export function recordError(name: string, error: unknown): void {
  if (typeof name !== "string" || name.trim().length === 0) return;
  const normalizedName = name.trim();
  const details = extractErrorDetails(error);

  if (errorRecords.length >= MAX_RECORDS) {
    errorRecords.shift();
  }
  errorRecords.push({
    operation: normalizedName,
    message: details.message,
    ...(details.code !== undefined ? { code: details.code } : {}),
    timestamp: Date.now(),
  });

  operationErrorCounts.set(
    normalizedName,
    (operationErrorCounts.get(normalizedName) ?? 0) + 1,
  );
}

/**
 * Return all recorded duration/error metrics and aggregated per-operation stats (#922).
 */
export function getMetrics(): InfrastructureMetricsSnapshot {
  const allOpNames = new Set<string>([
    ...operationDurations.keys(),
    ...operationErrorCounts.keys(),
  ]);

  const operations: Record<string, InfrastructureOperationStats> = {};
  let totalOperations = 0;
  let totalErrors = 0;

  for (const op of allOpNames) {
    const samples = operationDurations.get(op) ?? [];
    const errCount = operationErrorCounts.get(op) ?? 0;
    const callCount = samples.length + errCount;

    totalOperations += callCount;
    totalErrors += errCount;

    const sorted = [...samples].sort((a, b) => a - b);
    const totalDurationMs = samples.reduce((sum, v) => sum + v, 0);
    const avgDurationMs = samples.length > 0 ? totalDurationMs / samples.length : 0;
    const minDurationMs = sorted.length > 0 ? sorted[0]! : 0;
    const maxDurationMs = sorted.length > 0 ? sorted[sorted.length - 1]! : 0;
    const p95DurationMs = calculatePercentile(sorted, 95);

    operations[op] = {
      operation: op,
      callCount,
      errorCount: errCount,
      errorRate: callCount > 0 ? errCount / callCount : 0,
      totalDurationMs,
      avgDurationMs,
      minDurationMs,
      maxDurationMs,
      p95DurationMs,
    };
  }

  return {
    durations: [...durationRecords],
    errors: [...errorRecords],
    operations,
    totalOperations,
    totalErrors,
    overallErrorRate: totalOperations > 0 ? totalErrors / totalOperations : 0,
  };
}

/**
 * Clear all recorded operation durations and error metrics.
 */
export function resetMetrics(): void {
  durationRecords.length = 0;
  errorRecords.length = 0;
  operationDurations.clear();
  operationErrorCounts.clear();
}
