/**
 * Event-invalidated cache with TTL (#972).
 *
 * A TTL-only cache serves stale data until the clock runs out. This cache
 * additionally lets an entry declare the events that make it stale
 * (`"accountUpdated"`, `"balanceChanged"`, ...); emitting one with
 * {@link EventSmartCache.invalidate} drops every entry registered for it
 * immediately.
 *
 * ```ts
 * const cache = new EventSmartCache<string>();
 * cache.set("balance:GABC", "100", 30_000, ["balanceChanged", "accountUpdated"]);
 * cache.get("balance:GABC");            // "100"
 * cache.invalidate("balanceChanged");   // entry removed
 * cache.get("balance:GABC");            // null
 * ```
 *
 * In-memory and per-instance only (no distributed cache). There are no
 * timers: expired entries are removed when read or via {@link EventSmartCache.prune},
 * and invalidation removes both the entry and its event bookkeeping, so
 * nothing lingers after an entry is gone.
 *
 * Named `EventSmartCache` to stay distinct from the Horizon/Soroban-oriented
 * `SmartCache` in `src/shared`.
 */

interface Entry<T> {
  value: T;
  /** `Date.now()` at or after which the entry is expired. */
  expiresAt: number;
  events: ReadonlySet<string>;
}

/** Hit/miss statistics for an {@link EventSmartCache}. */
export interface EventCacheStats {
  /** `get()` calls answered from a live entry. */
  hits: number;
  /** `get()` calls that found nothing live (absent, expired or invalidated). */
  misses: number;
  /** `hits / (hits + misses)`, or `0` before any lookup. */
  hitRate: number;
  /** Entries currently stored (expired-but-unread entries still count until pruned). */
  size: number;
}

export class EventSmartCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();
  /** event name -> keys registered for it. */
  private readonly byEvent = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;

  /**
   * Store `value` under `key` for `ttl` milliseconds. Re-setting a key
   * replaces its value, TTL and events.
   *
   * @param key          - Cache key.
   * @param value        - Value to store.
   * @param ttl          - Time to live in milliseconds; must be a positive finite number.
   * @param invalidateOn - Event name(s) that should drop this entry when invalidated.
   * @throws {RangeError} when `ttl` is not a positive finite number.
   */
  set(
    key: string,
    value: T,
    ttl: number,
    invalidateOn?: string | readonly string[],
  ): void {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError("ttl must be a positive, finite number of milliseconds");
    }
    // Drop the previous entry first so stale event registrations don't leak.
    this.remove(key);

    const events = new Set<string>(
      invalidateOn === undefined
        ? []
        : typeof invalidateOn === "string"
          ? [invalidateOn]
          : invalidateOn,
    );
    this.entries.set(key, { value, expiresAt: Date.now() + ttl, events });
    for (const event of events) {
      let keys = this.byEvent.get(event);
      if (!keys) {
        keys = new Set();
        this.byEvent.set(event, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Read a live value, or `null` when the key is absent, expired or was
   * invalidated. Counts as a hit or a miss, and removes an expired entry.
   */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.remove(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value;
  }

  /**
   * Remove every entry registered for `event`.
   *
   * @returns the number of entries removed.
   */
  invalidate(event: string): number {
    const keys = this.byEvent.get(event);
    if (!keys) return 0;
    let removed = 0;
    // Copy: remove() mutates the set while we iterate.
    for (const key of [...keys]) {
      if (this.remove(key)) removed += 1;
    }
    this.byEvent.delete(event);
    return removed;
  }

  /** Remove a single entry. @returns whether it existed. */
  delete(key: string): boolean {
    return this.remove(key);
  }

  /** Remove every entry and all event bookkeeping (stats are kept). */
  clear(): void {
    this.entries.clear();
    this.byEvent.clear();
  }

  /**
   * Remove all expired entries without counting hits or misses.
   *
   * @returns the number of entries removed.
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (now >= entry.expiresAt && this.remove(key)) removed += 1;
    }
    return removed;
  }

  /** Total `get()` hits so far. */
  hit(): number {
    return this.hits;
  }

  /** Total `get()` misses so far. */
  miss(): number {
    return this.misses;
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this.entries.size;
  }

  /** Hit/miss statistics. */
  stats(): EventCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      size: this.entries.size,
    };
  }

  /** Reset hit/miss counters. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    for (const event of entry.events) {
      const keys = this.byEvent.get(event);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.byEvent.delete(event);
    }
    return true;
  }
}

/** Create an {@link EventSmartCache}. */
export function createEventSmartCache<T = unknown>(): EventSmartCache<T> {
  return new EventSmartCache<T>();
}
