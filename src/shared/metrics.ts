/**
 * Lightweight in-memory metrics collector for SDK operation latency tracking.
 * All collection is optional — no metrics are recorded unless explicitly called.
 */

export interface MetricEntry {
  /** Name of the operation (e.g. "account.get", "transaction.submit") */
  operation: string;
  /** Wall-clock duration of the operation in milliseconds */
  durationMs: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Unix epoch ms at which the operation completed */
  timestamp: number;
}

export interface MetricSummary {
  /** Operation name */
  operation: string;
  /** Total number of recorded calls */
  count: number;
  /** Number of successful calls */
  successCount: number;
  /** Number of failed calls */
  failureCount: number;
  /** Minimum recorded duration in ms */
  min: number;
  /** Maximum recorded duration in ms */
  max: number;
  /** Mean duration in ms */
  avg: number;
  /** 99th-percentile duration in ms */
  p99: number;
}

export interface MetricsFilter {
  /** Restrict summary to a single operation name */
  operation?: string;
  /** Include only entries recorded at or after this timestamp (ms epoch) */
  since?: number;
}

class MetricsCollector {
  private readonly entries: MetricEntry[] = [];

  record(entry: MetricEntry): void {
    this.entries.push(entry);
  }

  getMetrics(filter?: MetricsFilter): MetricSummary[] {
    let filtered = this.entries;

    if (filter?.operation !== undefined) {
      filtered = filtered.filter((e) => e.operation === filter.operation);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      filtered = filtered.filter((e) => e.timestamp >= since);
    }

    const groups = new Map<string, MetricEntry[]>();
    for (const entry of filtered) {
      const group = groups.get(entry.operation) ?? [];
      group.push(entry);
      groups.set(entry.operation, group);
    }

    return Array.from(groups.entries()).map(([operation, entries]) => {
      const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);
      const sum = durations.reduce((acc, d) => acc + d, 0);
      const p99Idx = Math.min(
        Math.floor(0.99 * durations.length),
        durations.length - 1,
      );

      return {
        operation,
        count: entries.length,
        successCount: entries.filter((e) => e.success).length,
        failureCount: entries.filter((e) => !e.success).length,
        min: durations[0] ?? 0,
        max: durations[durations.length - 1] ?? 0,
        avg: entries.length > 0 ? sum / entries.length : 0,
        p99: durations[p99Idx] ?? 0,
      };
    });
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Module-level singleton. All `recordMetric` / `getMetrics` calls target this. */
export const metricsCollector = new MetricsCollector();

/**
 * Record a completed operation into the global metrics store.
 *
 * @param operation  Human-readable name (e.g. "account.get")
 * @param durationMs Duration measured with `performance.now()` or `Date.now()`
 * @param success    Whether the operation returned a success result
 */
export function recordMetric(
  operation: string,
  durationMs: number,
  success: boolean,
): void {
  metricsCollector.record({
    operation,
    durationMs,
    success,
    timestamp: Date.now(),
  });
}

/**
 * Return aggregated metric summaries from the global store.
 *
 * @param filter  Optional — restrict by operation name and/or start time
 */
export function getMetrics(filter?: MetricsFilter): MetricSummary[] {
  return metricsCollector.getMetrics(filter);
}

/**
 * Remove all recorded entries from the global store.
 * Useful between tests or when resetting a monitoring session.
 */
export function clearMetrics(): void {
  metricsCollector.clear();
}

/**
 * Wrap an async operation with automatic metric recording.
 * Uses `performance.now()` for high-resolution timing.
 *
 * @param operation  Name to record under
 * @param fn         Async function to time
 */
export async function withMetrics<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  let success = true;
  try {
    const result = await fn();
    return result;
  } catch (e) {
    success = false;
    throw e;
  } finally {
    const durationMs = performance.now() - start;
    recordMetric(operation, durationMs, success);
  }
}
