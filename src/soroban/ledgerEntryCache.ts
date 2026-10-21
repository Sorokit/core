/**
 * Statistics tracked by LedgerEntryCache.
 */
export interface LedgerEntryCacheStats {
  /** Total number of successful cache hits. */
  hits: number;
  /** Total number of cache misses (entry absent or expired). */
  misses: number;
  /** Total number of cache evictions due to capacity limits or expiration. */
  evictions: number;
  /** Estimated memory used by cached entries in bytes. */
  memoryUsed: number;
  /** Cache hit rate between 0 and 1 (hits / (hits + misses)). */
  hitRate: number;
  /** Current count of active entries in the cache. */
  size: number;
  /** Maximum entry capacity, or null if unlimited. */
  capacity: number | null;
}

export interface LedgerEntryCacheOptions {
  /** Maximum number of entries before LRU eviction. Defaults to 1000. Set 0 or Infinity for unlimited. */
  maxEntries?: number;
  /** Default TTL in milliseconds for entries without an explicit TTL. */
  defaultTtlMs?: number;
  /** Callback fired when an entry is evicted. */
  onEvict?: (key: string, value: unknown) => void;
}

interface CacheItem<T> {
  key: string;
  value: T;
  bytes: number;
  expiresAt: number | null;
  lastAccessed: number;
}

/**
 * Estimate size of an entry in bytes for memory tracking.
 */
function estimateEntrySizeBytes(key: string, value: unknown): number {
  let bytes = key.length * 2; // UTF-16 characters
  if (value === undefined || value === null) {
    return bytes;
  }
  if (typeof value === "string") {
    bytes += value.length * 2;
  } else if (typeof value === "number") {
    bytes += 8;
  } else if (typeof value === "boolean") {
    bytes += 4;
  } else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    bytes += value.byteLength;
  } else {
    try {
      bytes += JSON.stringify(value).length * 2;
    } catch {
      bytes += 128; // Fallback estimate
    }
  }
  return bytes;
}

/**
 * LedgerEntryCache stores frequently queried Soroban ledger entries with
 * full visibility into cache hits, misses, evictions, and memory usage.
 */
export class LedgerEntryCache<T = unknown> {
  private readonly store = new Map<string, CacheItem<T>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs?: number;
  private readonly onEvict?: (key: string, value: unknown) => void;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private totalMemoryBytes = 0;

  constructor(options: LedgerEntryCacheOptions = {}) {
    this.maxEntries =
      options.maxEntries !== undefined && options.maxEntries >= 0
        ? options.maxEntries
        : 1000;
    this.defaultTtlMs = options.defaultTtlMs;
    this.onEvict = options.onEvict;
  }

  /**
   * Look up an entry by key.
   * Increments hits on success; increments misses if absent or expired.
   */
  get(key: string): T | undefined {
    const item = this.store.get(key);
    if (!item) {
      this.misses++;
      return undefined;
    }

    const now = Date.now();
    if (item.expiresAt !== null && now > item.expiresAt) {
      // Expired entry
      this.evictItem(key, item);
      this.misses++;
      return undefined;
    }

    // Refresh access time (LRU)
    item.lastAccessed = now;
    // Map insertion order update for LRU
    this.store.delete(key);
    this.store.set(key, item);

    this.hits++;
    return item.value;
  }

  /**
   * Store an entry in the cache.
   * Evicts the least recently used entry if capacity would be exceeded.
   */
  set(key: string, value: T, ttlMs?: number): void {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const expiresAt =
      effectiveTtl !== undefined && effectiveTtl > 0 ? now + effectiveTtl : null;

    const estimatedBytes = estimateEntrySizeBytes(key, value);

    // If key already exists, replace it and update memory
    if (this.store.has(key)) {
      const existing = this.store.get(key)!;
      this.totalMemoryBytes -= existing.bytes;
      this.store.delete(key);
    } else if (this.maxEntries > 0 && this.store.size >= this.maxEntries) {
      // Evict LRU (first key in map iteration order)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestItem = this.store.get(oldestKey)!;
        this.evictItem(oldestKey, oldestItem);
      }
    }

    const item: CacheItem<T> = {
      key,
      value,
      bytes: estimatedBytes,
      expiresAt,
      lastAccessed: now,
    };

    this.store.set(key, item);
    this.totalMemoryBytes += estimatedBytes;
  }

  /**
   * Check if a key exists and has not expired (does not alter hit/miss stats).
   */
  has(key: string): boolean {
    const item = this.store.get(key);
    if (!item) return false;
    if (item.expiresAt !== null && Date.now() > item.expiresAt) {
      this.evictItem(key, item);
      return false;
    }
    return true;
  }

  /**
   * Remove a specific entry.
   */
  delete(key: string): boolean {
    const item = this.store.get(key);
    if (!item) return false;
    this.totalMemoryBytes = Math.max(0, this.totalMemoryBytes - item.bytes);
    this.store.delete(key);
    return true;
  }

  /**
   * Invalidate a key (alias for delete).
   */
  invalidate(key: string): void {
    this.delete(key);
  }

  /**
   * Clear all entries in the cache. Retains lifetime hit/miss statistics.
   */
  clear(): void {
    this.store.clear();
    this.totalMemoryBytes = 0;
  }

  /**
   * Retrieve aggregate cache performance and memory statistics.
   */
  getStats(): LedgerEntryCacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      memoryUsed: this.totalMemoryBytes,
      hitRate: Number(hitRate.toFixed(4)),
      size: this.store.size,
      capacity: this.maxEntries > 0 ? this.maxEntries : null,
    };
  }

  /**
   * Reset hit, miss, and eviction counters for benchmarking.
   * Active cached entries are preserved.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private evictItem(key: string, item: CacheItem<T>): void {
    this.store.delete(key);
    this.totalMemoryBytes = Math.max(0, this.totalMemoryBytes - item.bytes);
    this.evictions++;
    if (this.onEvict) {
      try {
        this.onEvict(key, item.value);
      } catch {
        // Suppress callback errors during eviction
      }
    }
  }
}

/**
 * Factory to create a LedgerEntryCache.
 */
export function createLedgerEntryCache<T = unknown>(
  options?: LedgerEntryCacheOptions,
): LedgerEntryCache<T> {
  return new LedgerEntryCache<T>(options);
}
