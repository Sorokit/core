/**
 * Lightweight memory-usage monitoring for development (#707).
 *
 * Long-running apps (SPAs, indexers, bots) previously had no visibility into
 * SDK-side retained state. These helpers estimate retained entries/bytes for
 * contract caches and snapshot stores, and emit `console.warn` guidance when
 * configurable thresholds are exceeded. They never throw and are safe to call
 * in production (warnings only).
 */

export interface MemoryUsageSample {
  /** Estimated heap bytes, when the runtime exposes it (Node `process.memoryUsage`). */
  heapBytes?: number;
  /** Number of entries retained across SDK stores, when provided. */
  retainedEntries?: number;
  /** Caller-supplied label for the sample. */
  label?: string;
  /** Epoch ms at which the sample was taken. */
  sampledAt: number;
}

export interface MemoryMonitorOptions {
  /** Warn when retained entries exceed this count. Default: 10_000. */
  maxRetainedEntries?: number;
  /** Warn when heap bytes exceed this. Default: 256 MiB. */
  maxHeapBytes?: number;
  /** Only warn once per process unless reset. Default: true. */
  warnOnce?: boolean;
}

let warned = false;

/** Reset the once-per-process warning latch (tests / dev). */
export function resetMemoryMonitorWarnings(): void {
  warned = false;
}

function readHeapBytes(): number | undefined {
  try {
    const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed?: number } } }).process;
    const heapUsed = proc?.memoryUsage?.().heapUsed;
    return typeof heapUsed === "number" ? heapUsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sample current memory usage and warn in development when thresholds are
 * exceeded. Returns the sample; never throws.
 */
export function checkMemoryUsage(
  retainedEntries?: number,
  options?: MemoryMonitorOptions,
  label?: string,
): MemoryUsageSample {
  const sample: MemoryUsageSample = {
    sampledAt: Date.now(),
    ...(readHeapBytes() !== undefined ? { heapBytes: readHeapBytes() } : {}),
    ...(retainedEntries !== undefined ? { retainedEntries } : {}),
    ...(label !== undefined ? { label } : {}),
  };

  const maxEntries = options?.maxRetainedEntries ?? 10_000;
  const maxHeap = options?.maxHeapBytes ?? 256 * 1024 * 1024;
  const warnOnce = options?.warnOnce ?? true;
  if (warnOnce && warned) return sample;

  const overEntries = retainedEntries !== undefined && retainedEntries > maxEntries;
  const overHeap = sample.heapBytes !== undefined && sample.heapBytes > maxHeap;
  if ((overEntries || overHeap) && typeof console !== "undefined") {
    warned = true;
    console.warn(
      `[sorokit] high memory usage detected${label ? ` (${label})` : ""}: ` +
        `${retainedEntries !== undefined ? `${retainedEntries} retained entries; ` : ""}` +
        `${sample.heapBytes !== undefined ? `heap ~${Math.round(sample.heapBytes / 1024 / 1024)} MiB; ` : ""}` +
        "prune snapshot stores / metadata caches (see prune* helpers) or tighten retention policies.",
    );
  }
  return sample;
}

/** Estimate bytes for a JSON-serializable value (UTF-8 length of JSON). */
export function estimateValueBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}
