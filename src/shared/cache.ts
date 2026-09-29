/**
 * Pluggable cache interface.
 *
 * sorokit-core is stateless by default.
 * Pass a SorokitCache implementation to createSorokitClient() to enable
 * caching of account/balance data.
 *
 * sorokit-ui ships a React Query adapter.
 * For Node scripts, a simple Map-based implementation is sufficient.
 */
export interface SorokitCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs?: number): void;
  invalidate(key: string): void;
  invalidateByPrefix?(prefix: string): void;
  clear(): void;
}

export function createInMemoryCache(defaultTtlMs?: number): SorokitCache {
  const store = new Map<string, { value: unknown; expiresAt?: number }>();

  return {
    get(key: string): unknown {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: unknown, ttlMs?: number): void {
      const finalTtlMs = ttlMs ?? defaultTtlMs;
      if (finalTtlMs !== undefined) {
        if (typeof finalTtlMs !== 'number' || finalTtlMs <= 0 || !Number.isInteger(finalTtlMs)) {
          throw new Error('TTL must be a positive integer');
        }
        store.set(key, { value, expiresAt: Date.now() + finalTtlMs });
      } else {
        store.set(key, { value });
      }
    },
    invalidate(key: string): void {
      store.delete(key);
      if (key.includes("*")) {
        const regex = new RegExp(
          "^" +
            key
              .split("*")
              .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".*") +
            "$",
        );
        for (const k of Array.from(store.keys())) {
          if (regex.test(k)) {
            store.delete(k);
          }
        }
      }
    },
    invalidateByPrefix(prefix: string): void {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
    clear(): void {
      store.clear();
    },
  };
}

/**
 * Invalidate a cached contract read result by its cache key.
 *
 * Use this to manually bust a specific entry when you know the contract
 * state has changed (e.g. after submitting a write transaction).
 *
 * Safe to call even if the cache or key does not exist — it is a no-op
 * in that case.
 *
 * @example
 * const cacheKey = createContractReadCacheKey(contractId, "get_price", args);
 * invalidateContractState(cacheKey, cache);
 */
export function invalidateContractState(
  cacheKey: string,
  cache: SorokitCache,
): void {
  cache.invalidate(cacheKey);
}

export function wrapCache(userCache: SorokitCache): SorokitCache {
  return {
    get(key: string): unknown {
      return userCache.get(key);
    },
    set(key: string, value: unknown, ttlMs?: number): void {
      if (ttlMs !== undefined) {
        if (typeof ttlMs !== 'number' || ttlMs <= 0 || !Number.isInteger(ttlMs)) {
          throw new Error('TTL must be a positive integer');
        }
      }
      userCache.set(key, value, ttlMs);
    },
    invalidate(key: string): void {
      userCache.invalidate(key);
    },
    ...(userCache.invalidateByPrefix
      ? { invalidateByPrefix: (prefix: string): void => userCache.invalidateByPrefix?.(prefix) }
      : {}),
    clear(): void {
      userCache.clear();
    },
  };
}
