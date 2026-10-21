import { describe, expect, it, vi } from "vitest";
import {
  LedgerEntryCache,
  createLedgerEntryCache,
} from "../soroban/ledgerEntryCache";

describe("LedgerEntryCache Statistics & Management (#852)", () => {
  it("initializes with zeroed statistics", () => {
    const cache = new LedgerEntryCache({ maxEntries: 10 });
    const stats = cache.getStats();

    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.memoryUsed).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.size).toBe(0);
    expect(stats.capacity).toBe(10);
  });

  it("accurately tracks hits and misses", () => {
    const cache = createLedgerEntryCache<string>({ maxEntries: 5 });

    // Miss on empty cache
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);

    // Set key1 and hit it
    cache.set("key1", "val1");
    expect(cache.get("key1")).toBe("val1");
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hitRate).toBe(0.5); // 1 / 2

    // Another hit
    expect(cache.get("key1")).toBe("val1");
    expect(cache.getStats().hits).toBe(2);
    expect(cache.getStats().hitRate).toBe(0.6667); // 2 / 3
  });

  it("tracks memoryUsed when entries are added, overwritten, and deleted", () => {
    const cache = new LedgerEntryCache<string>();

    cache.set("k1", "small");
    const mem1 = cache.getStats().memoryUsed;
    expect(mem1).toBeGreaterThan(0);

    // Overwriting updates memory size
    cache.set("k1", "a much longer string value with more bytes");
    const mem2 = cache.getStats().memoryUsed;
    expect(mem2).toBeGreaterThan(mem1);

    // Delete reduces memoryUsed
    cache.delete("k1");
    expect(cache.getStats().memoryUsed).toBe(0);
  });

  it("tracks evictions when maxEntries limit is exceeded (LRU)", () => {
    const onEvict = vi.fn();
    const cache = new LedgerEntryCache<number>({
      maxEntries: 2,
      onEvict,
    });

    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.getStats().size).toBe(2);
    expect(cache.getStats().evictions).toBe(0);

    // Access "a" so "b" becomes the least recently used
    cache.get("a");

    // Adding "c" should evict "b"
    cache.set("c", 3);
    expect(cache.getStats().evictions).toBe(1);
    expect(cache.getStats().size).toBe(2);
    expect(onEvict).toHaveBeenCalledWith("b", 2);

    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("tracks evictions and misses when entries expire", () => {
    vi.useFakeTimers();
    try {
      const cache = new LedgerEntryCache<string>({ defaultTtlMs: 1000 });
      cache.set("expiring", "value");

      expect(cache.get("expiring")).toBe("value");
      expect(cache.getStats().hits).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(1500);

      expect(cache.get("expiring")).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
      expect(cache.getStats().evictions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows resetting stats for benchmarking without clearing cached entries", () => {
    const cache = new LedgerEntryCache<string>({ maxEntries: 10 });
    cache.set("k1", "v1");
    cache.get("k1"); // hit
    cache.get("k2"); // miss

    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().size).toBe(1);

    cache.resetStats();
    const resetStats = cache.getStats();
    expect(resetStats.hits).toBe(0);
    expect(resetStats.misses).toBe(0);
    expect(resetStats.evictions).toBe(0);
    expect(resetStats.hitRate).toBe(0);
    // Entry is preserved
    expect(resetStats.size).toBe(1);
    expect(resetStats.memoryUsed).toBeGreaterThan(0);
    expect(cache.get("k1")).toBe("v1");
    expect(cache.getStats().hits).toBe(1);
  });
});
