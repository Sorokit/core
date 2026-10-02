/** Opt-in coalescing of concurrent reads within one client instance. */
export interface DedupConfig {
  enabled?: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stableValue(record[key])]));
  }
  return value;
}

export function createRequestDeduplicator(config?: DedupConfig) {
  const inFlight = new Map<string, Promise<unknown>>();

  function deduplicate<T>(
    keyParts: unknown[],
    fetcher: (signal?: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (!config?.enabled) return fetcher(callerSignal);
    const key = JSON.stringify(stableValue(keyParts));
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;
    // A caller's timeout must not cancel a request shared by other callers.
    // Each client caller already enforces its own deadline with runWithTimeout.
    const pending = Promise.resolve().then(() => fetcher()).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  return { deduplicate };
}
