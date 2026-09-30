/**
 * Advanced cache invalidation and expiration strategies (#675)
 *
 * `createCache()` gives callers a small, chainable, in-memory cache builder
 * that sits alongside the existing cache primitives in `src/shared`
 * ({@link SorokitCache}, `SmartCache`, `CacheInvalidationManager`). Those
 * existing utilities are oriented around Horizon/Soroban cache-key
 * bookkeeping (accounts, contracts, trustlines); this module is a
 * general-purpose, application-facing cache that any caller can configure
 * with a fluent builder and use for arbitrary keyed data:
 *
 * ```ts
 * const accountCache = createCache<AccountData>()
 *   .ttl(30_000)                      // 30 second TTL
 *   .invalidateOn("accountChanged")   // cleared when that event fires
 *   .warmCache([publicKey], fetchAccountData);
 *
 * const result = await accountCache.get(publicKey, () => fetchAccountData(publicKey));
 * if (result.status === "ok") {
 *   console.log(result.data.value, result.data.stale);
 * }
 *
 * // Elsewhere, after an account-changing operation:
 * accountCache.emit("accountChanged");
 * ```
 *
 * Every async operation resolves to a {@link SorokitResult}, matching the
 * error-handling convention used across the rest of sorokit-core.
 */

import { ok, err, SorokitErrorCode, type SorokitResult } from "../shared/response";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A cached value plus the bookkeeping metadata callers need to reason about
 * freshness without re-fetching.
 */
export interface CachedData<T> {
  /** The cached value itself. */
  value: T;
  /** `Date.now()` at the time this value was stored. */
  cachedAt: number;
  /** `Date.now()` after which this value is considered expired, or `null` if it never expires. */
  expiresAt: number | null;
  /** `true` when this value was served past its TTL (only possible via {@link CacheBuilder.peek}). */
  stale: boolean;
}

/** Hit-rate and memory-usage metrics for a cache instance. */
export interface CacheStats {
  /** Number of `.get()` calls served from a live cache entry. */
  hits: number;
  /** Number of `.get()` calls that required invoking the fetcher. */
  misses: number;
  /** `hits / (hits + misses)`, or `0` when no requests have been made yet. */
  hitRate: number;
  /** Number of values currently stored (including any not-yet-expired warmed entries). */
  size: number;
  /** Estimated memory footprint of all cached values, in bytes. */
  memoryUsageBytes: number;
  /** Total number of entries written via `.get()` or `.warmCache()`. */
  sets: number;
  /** Total number of entries removed via `.invalidate()`, `.clear()`, TTL expiry, or event invalidation. */
  invalidations: number;
  /** Keys passed to `.warmCache()` that have not yet been populated with data. */
  pendingWarmKeys: number;
}

/** A function that produces a fresh value for a given cache key. */
export type CacheFetcher<T> = (key: string) => Promise<T>;

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  expiresAt: number | null;
}

/**
 * Configurable, chainable cache builder returned by {@link createCache}.
 *
 * The `.ttl()`, `.invalidateOn()`, and `.warmCache()` methods are
 * configuration steps and return `this` so they can be chained; `.get()`
 * and `.peek()` are the read operations.
 */
export class CacheBuilder<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly invalidationEvents = new Set<string>();
  private readonly pendingWarmKeys = new Set<string>();
  private readonly inFlight = new Map<string, Promise<SorokitResult<CachedData<T>>>>();

  private ttlMs: number | null = null;
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private invalidations = 0;

  /**
   * Sets the default time-to-live applied to every entry written after this
   * call. Does not retroactively change the expiry of already-cached values.
   *
   * @param ms Positive integer number of milliseconds. `0` or negative
   * values are rejected since a cache that instantly expires everything is
   * almost always a configuration mistake — use `.invalidate()`/`.clear()`
   * for that intent instead.
   */
  ttl(ms: number): this {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error("ttl() requires a positive number of milliseconds");
    }
    this.ttlMs = ms;
    return this;
  }

  /**
   * Registers an event name that, when passed to {@link emit}, clears every
   * entry in this cache. A cache can be invalidated by multiple events.
   *
   * @param event Application-defined event name, e.g. `"accountChanged"`.
   */
  invalidateOn(event: string): this {
    this.invalidationEvents.add(event);
    return this;
  }

  /**
   * Emits an event previously registered with {@link invalidateOn}, clearing
   * this cache. Emitting an event nobody registered for is a no-op.
   */
  emit(event: string): void {
    if (this.invalidationEvents.has(event)) {
      this.clear();
    }
  }

  /**
   * Prefetches (warms) the given keys.
   *
   * When `fetcher` is supplied, each key not already cached with a live
   * entry is fetched immediately and the resulting promise is tracked so a
   * subsequent `.get(key, ...)` call for the same key awaits the warm fetch
   * instead of re-invoking its own fetcher. Warm fetch failures are
   * swallowed here (the cache simply remains empty for that key) — the
   * error is surfaced properly on the next `.get()` call for that key,
   * which retries the fetch and returns a `SorokitResult` error.
   *
   * When `fetcher` is omitted, the keys are only recorded as "pending warm"
   * (visible via `.getStats().pendingWarmKeys`) for callers that want to
   * warm a cache instance ahead of knowing how to fetch each key — a later
   * `.warmCache(keys, fetcher)` or `.get(key, fetcher)` call clears the
   * pending marker for that key.
   */
  warmCache(keys: string[], fetcher?: CacheFetcher<T>): this {
    for (const key of keys) {
      if (this.isFresh(key)) continue;

      if (!fetcher) {
        this.pendingWarmKeys.add(key);
        continue;
      }

      this.pendingWarmKeys.delete(key);
      if (this.inFlight.has(key)) continue;

      const warmPromise = this.fetchAndStore(key, fetcher);
      this.inFlight.set(key, warmPromise);
      void warmPromise.finally(() => {
        if (this.inFlight.get(key) === warmPromise) {
          this.inFlight.delete(key);
        }
      });
    }
    return this;
  }

  /**
   * Reads a cache entry without triggering a fetch and without affecting
   * hit-rate statistics. Returns `ok(null)` when the key is missing or
   * expired rather than an error, since "not cached" is an expected,
   * non-exceptional outcome of a peek.
   */
  peek(key: string): SorokitResult<CachedData<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return ok(null);

    const expired = entry.expiresAt !== null && Date.now() > entry.expiresAt;
    return ok({
      value: entry.value,
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
      stale: expired,
    });
  }

  /**
   * Gets a value from the cache, invoking `fetcher` on a miss or expiry and
   * caching its result. Concurrent `.get()` calls for the same key while a
   * fetch is already in flight (including one started by `.warmCache()`)
   * share that single fetch rather than issuing duplicate requests.
   */
  async get(key: string, fetcher: CacheFetcher<T>): Promise<SorokitResult<CachedData<T>>> {
    const existingFetch = this.inFlight.get(key);
    if (existingFetch) {
      return existingFetch;
    }

    if (this.isFresh(key)) {
      this.hits++;
      const entry = this.store.get(key)!;
      return ok({
        value: entry.value,
        cachedAt: entry.cachedAt,
        expiresAt: entry.expiresAt,
        stale: false,
      });
    }

    this.misses++;
    const fetchPromise = this.fetchAndStore(key, fetcher);
    this.inFlight.set(key, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      if (this.inFlight.get(key) === fetchPromise) {
        this.inFlight.delete(key);
      }
    }
  }

  /** Manually invalidates a single cache key. Invalidating a missing key is a no-op. */
  invalidate(key: string): void {
    if (this.store.delete(key)) {
      this.invalidations++;
    }
    this.pendingWarmKeys.delete(key);
  }

  /** Manually invalidates every cache entry. */
  clear(): void {
    this.invalidations += this.store.size;
    this.store.clear();
    this.pendingWarmKeys.clear();
  }

  /** Returns hit-rate and memory-usage statistics for this cache instance. */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
      size: this.store.size,
      memoryUsageBytes: this.estimateMemoryUsage(),
      sets: this.sets,
      invalidations: this.invalidations,
      pendingWarmKeys: this.pendingWarmKeys.size,
    };
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private isFresh(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.invalidations++;
      return false;
    }
    return true;
  }

  private async fetchAndStore(
    key: string,
    fetcher: CacheFetcher<T>,
  ): Promise<SorokitResult<CachedData<T>>> {
    let value: T;
    try {
      value = await fetcher(key);
    } catch (cause) {
      return err<CachedData<T>>(
        SorokitErrorCode.INTERNAL,
        `Cache fetcher failed for key "${key}"`,
        cause,
        undefined,
        { context: { operation: "cacheStrategy.get", parameters: { key } } },
      );
    }

    const cachedAt = Date.now();
    const expiresAt = this.ttlMs !== null ? cachedAt + this.ttlMs : null;
    this.store.set(key, { value, cachedAt, expiresAt });
    this.pendingWarmKeys.delete(key);
    this.sets++;

    return ok({ value, cachedAt, expiresAt, stale: false });
  }

  private estimateMemoryUsage(): number {
    let total = 0;
    for (const entry of this.store.values()) {
      total += estimateByteSize(entry.value);
    }
    return total;
  }
}

/**
 * Creates a new, empty {@link CacheBuilder}.
 *
 * @example
 * const cache = createCache<number>().ttl(60_000);
 * const result = await cache.get("answer", async () => 42);
 */
export function createCache<T = unknown>(): CacheBuilder<T> {
  return new CacheBuilder<T>();
}

// ─── Internal utilities ─────────────────────────────────────────────────────

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

/** Best-effort serialized byte size of a value, used for memory-usage tracking. */
function estimateByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(stableSerialize(value)).byteLength;
  } catch {
    // Circular references or values that cannot be serialized (e.g. BigInt)
    // fall back to 0 rather than breaking stats collection.
    return 0;
  }
}
