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
  clear(): void;
}

export function createMemoryCache(): SorokitCache {
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
      let expiresAt: number | undefined;
      if (ttlMs !== undefined) {
        if (typeof ttlMs !== 'number' || ttlMs <= 0 || !Number.isInteger(ttlMs)) {
          throw new Error('TTL must be a positive integer');
        }
        expiresAt = Date.now() + ttlMs;
      }
      store.set(key, { value, expiresAt });
    },
    invalidate(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
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
    clear(): void {
      userCache.clear();
    },
  };
}
