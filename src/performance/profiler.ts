/**
 * Lightweight SDK operation profiler.
 *
 * Timings use a monotonic high-resolution clock. Memory values are reported
 * as heap usage in megabytes when the host runtime exposes process memory data.
 */

export interface ProfilerMetric {
  /** Aggregated elapsed time in milliseconds. */
  duration: number;
  /** Duration in milliseconds (explicit alias for SDK metric consumers). */
  durationMs: number;
  /** Current heap usage in megabytes, when exposed by the runtime. */
  memory?: number;
  /** Heap usage in megabytes (explicit alias for SDK metric consumers). */
  memoryMB?: number;
  /** Number of completed profiling samples. */
  callCount: number;
}

interface ActiveProfile {
  startedAt: number;
}

interface MetricAccumulator {
  durationTotal: number;
  memoryTotal: number;
  memoryCallCount: number;
  callCount: number;
}

function now(): number {
  if (
    typeof globalThis.performance !== "undefined" &&
    typeof globalThis.performance.now === "function"
  ) {
    return globalThis.performance.now();
  }
  return Date.now();
}

function readMemoryMB(): number | undefined {
  try {
    const proc = (
      globalThis as {
        process?: { memoryUsage?: () => { heapUsed?: number } };
      }
    ).process;
    const heapUsed = proc?.memoryUsage?.().heapUsed;
    return typeof heapUsed === "number" ? heapUsed / (1024 * 1024) : undefined;
  } catch {
    return undefined;
  }
}

/** A reusable operation profiler with low-overhead in-memory aggregation. */
export class Profiler {
  private readonly activeProfiles = new Map<string, ActiveProfile>();
  private readonly metrics = new Map<string, MetricAccumulator>();

  /** Start timing an operation under the supplied label. */
  startProfiling(label: string): void {
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error("Profiler label must be a non-empty string");
    }
    this.activeProfiles.set(label, {
      startedAt: now(),
    });
  }

  /**
   * Stop timing an operation and return the elapsed milliseconds.
   * Returns 0 when the label has not been started.
   */
  stopProfiling(label: string): number {
    const active = this.activeProfiles.get(label);
    if (active === undefined) {
      return 0;
    }
    this.activeProfiles.delete(label);

    const duration = Math.max(0, now() - active.startedAt);
    const memory = readMemoryMB();
    const existing = this.metrics.get(label);
    if (existing === undefined) {
      this.metrics.set(label, {
        durationTotal: duration,
        memoryTotal: memory ?? 0,
        memoryCallCount: memory === undefined ? 0 : 1,
        callCount: 1,
      });
    } else {
      existing.durationTotal += duration;
      if (memory !== undefined) {
        existing.memoryTotal += memory;
        existing.memoryCallCount += 1;
      }
      existing.callCount += 1;
    }
    return duration;
  }

  /**
   * Automatically profile a synchronous or asynchronous operation.
   * The original return value or rejection is preserved.
   */
  profileOperation<T>(fn: () => T, label: string): T | Promise<Awaited<T>> {
    this.startProfiling(label);
    try {
      const result = fn();
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        return Promise.resolve(result).then(
          (value) => {
            this.stopProfiling(label);
            return value;
          },
          (error: unknown) => {
            this.stopProfiling(label);
            throw error;
          },
        ) as Promise<Awaited<T>>;
      }
      this.stopProfiling(label);
      return result;
    } catch (error) {
      this.stopProfiling(label);
      throw error;
    }
  }

  /** Return averaged metrics for every profiled label. */
  getMetrics(): Record<string, ProfilerMetric> {
    const result: Record<string, ProfilerMetric> = {};
    for (const [label, metric] of this.metrics) {
      const duration =
        metric.callCount > 0 ? metric.durationTotal / metric.callCount : 0;
      const memory =
        metric.memoryCallCount > 0
          ? metric.memoryTotal / metric.memoryCallCount
          : undefined;
      result[label] = {
        duration,
        durationMs: duration,
        callCount: metric.callCount,
        ...(memory !== undefined ? { memory, memoryMB: memory } : {}),
      };
    }
    return result;
  }

  /** Clear completed metrics and any unfinished profiles. */
  reset(): void {
    this.activeProfiles.clear();
    this.metrics.clear();
  }
}

export function createProfiler(): Profiler {
  return new Profiler();
}

const defaultProfiler = new Profiler();

export function startProfiling(label: string): void {
  defaultProfiler.startProfiling(label);
}

export function stopProfiling(label: string): number {
  return defaultProfiler.stopProfiling(label);
}

export function profileOperation<T>(
  fn: () => T,
  label: string,
): T | Promise<Awaited<T>> {
  return defaultProfiler.profileOperation(fn, label);
}

export function getMetrics(): Record<string, ProfilerMetric> {
  return defaultProfiler.getMetrics();
}
