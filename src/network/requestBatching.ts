/**
 * Time-windowed request batching, complementary to requestDedup.ts.
 *
 * requestDedup.ts coalesces truly concurrent, identical in-flight calls
 * (two callers asking for the same key *while the first request is still
 * pending* share one promise). createRequestBatcher generalizes this to
 * calls that arrive over a short time window rather than strictly
 * concurrently: every request() call for a distinct key made within
 * `windowMs` of the first is collected and handed to a single caller-supplied
 * `batchFetcher` in one call, once, instead of each key triggering its own
 * fetch. Identical keys within a window are deduped to one entry (matching
 * the "identical requests over a short window" case), same as
 * requestDedup.ts's concurrent case, just widened to a window instead of
 * strict overlap.
 *
 * The batcher has no knowledge of Horizon, Soroban RPC, or any specific
 * transport — `batchFetcher` decides how (or whether) N distinct keys become
 * fewer network round trips. For genuinely identical keys (the common case:
 * many callers requesting the same account/resource within a few
 * milliseconds of each other) that's always exactly one underlying call
 * regardless of what batchFetcher does, since the batch only ever contains
 * one entry per distinct key.
 */

export interface RequestBatcherConfig {
  enabled?: boolean;
  /** Time window in ms to collect requests before firing the batch. Default: 10. */
  windowMs?: number;
  /** Maximum distinct keys per batch; reaching it fires immediately without waiting for windowMs. Default: 20. */
  maxBatch?: number;
}

export interface RequestBatcherStats {
  /** Total request() calls made, including ones that shared a batch/window with another. */
  totalRequests: number;
  /** Total batchFetcher invocations — i.e. actual underlying calls made. */
  totalBatches: number;
  /** requestCount of the most recently completed batch. */
  lastBatchSize: number;
}

export type BatchFetcher<K, V> = (keys: readonly K[]) => Promise<Map<K, V> | ReadonlyMap<K, V>>;

interface PendingEntry<V> {
  resolve: (value: V) => void;
  reject: (reason: unknown) => void;
}

export interface RequestBatcher<K, V> {
  /** Enqueues `key`; resolves once the batch containing it has been fetched and split. */
  request(key: K): Promise<V>;
  /** Cumulative stats since the batcher was created. */
  getStats(): RequestBatcherStats;
}

/**
 * Creates a batcher for one logical resource type (e.g. "get account").
 * Each distinct `keyFn(key)` result gets exactly one batchFetcher entry per
 * window; every caller requesting that same key within the window receives
 * the same resolved value (or the same rejection).
 */
export function createRequestBatcher<K, V>(
  batchFetcher: BatchFetcher<K, V>,
  config?: RequestBatcherConfig,
  keyFn: (key: K) => string = (key) => JSON.stringify(key),
): RequestBatcher<K, V> {
  const enabled = config?.enabled ?? true;
  const windowMs = config?.windowMs ?? 10;
  const maxBatch = config?.maxBatch ?? 20;

  const stats: RequestBatcherStats = { totalRequests: 0, totalBatches: 0, lastBatchSize: 0 };

  let pendingKeys: Map<string, K> | null = null;
  let pendingEntries: Map<string, PendingEntry<V>[]> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const keysMap = pendingKeys;
    const entriesMap = pendingEntries;
    pendingKeys = null;
    pendingEntries = null;
    if (!keysMap || !entriesMap || keysMap.size === 0) return;

    const keys = Array.from(keysMap.values());
    stats.totalBatches += 1;
    stats.lastBatchSize = keys.length;

    batchFetcher(keys)
      .then((results) => {
        for (const [keyId, key] of keysMap) {
          const waiters = entriesMap.get(keyId) ?? [];
          if (results.has(key)) {
            const value = results.get(key) as V;
            for (const waiter of waiters) waiter.resolve(value);
          } else {
            const error = new Error(`requestBatching: batchFetcher did not return a result for key ${keyId}`);
            for (const waiter of waiters) waiter.reject(error);
          }
        }
      })
      .catch((error: unknown) => {
        for (const waiters of entriesMap.values()) {
          for (const waiter of waiters) waiter.reject(error);
        }
      });
  }

  function request(key: K): Promise<V> {
    stats.totalRequests += 1;

    if (!enabled) {
      return batchFetcher([key]).then((results) => {
        if (!results.has(key)) {
          throw new Error("requestBatching: batchFetcher did not return a result for the requested key");
        }
        return results.get(key) as V;
      });
    }

    const keyId = keyFn(key);

    return new Promise<V>((resolve, reject) => {
      if (!pendingKeys) {
        pendingKeys = new Map();
        pendingEntries = new Map();
      }
      pendingKeys.set(keyId, key);
      const existingWaiters = pendingEntries!.get(keyId);
      if (existingWaiters) {
        existingWaiters.push({ resolve, reject });
      } else {
        pendingEntries!.set(keyId, [{ resolve, reject }]);
      }

      if (pendingKeys.size >= maxBatch) {
        flush();
        return;
      }

      if (timer === null) {
        timer = setTimeout(flush, windowMs);
      }
    });
  }

  return { request, getStats: () => ({ ...stats }) };
}
