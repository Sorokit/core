import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventSmartCache, createEventSmartCache } from "./smartCache";

describe("EventSmartCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an instance via the factory", () => {
    expect(createEventSmartCache<number>()).toBeInstanceOf(EventSmartCache);
  });

  describe("TTL", () => {
    it("returns a stored value before the TTL elapses", () => {
      const cache = new EventSmartCache<string>();
      cache.set("k", "v", 1_000);
      vi.advanceTimersByTime(999);
      expect(cache.get("k")).toBe("v");
    });

    it("returns null once the TTL has elapsed and removes the entry", () => {
      const cache = new EventSmartCache<string>();
      cache.set("k", "v", 1_000);
      vi.advanceTimersByTime(1_000);
      expect(cache.get("k")).toBeNull();
      expect(cache.size).toBe(0);
    });

    it("returns null for unknown keys", () => {
      expect(new EventSmartCache().get("nope")).toBeNull();
    });

    it("replaces value and TTL when a key is set again", () => {
      const cache = new EventSmartCache<string>();
      cache.set("k", "old", 1_000);
      vi.advanceTimersByTime(900);
      cache.set("k", "new", 1_000);
      vi.advanceTimersByTime(900);
      expect(cache.get("k")).toBe("new");
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid ttl %s", (ttl) => {
      expect(() => new EventSmartCache().set("k", 1, ttl)).toThrow(RangeError);
    });

    it("prune() removes only expired entries", () => {
      const cache = new EventSmartCache<number>();
      cache.set("short", 1, 100);
      cache.set("long", 2, 10_000);
      vi.advanceTimersByTime(500);
      expect(cache.prune()).toBe(1);
      expect(cache.size).toBe(1);
      expect(cache.get("long")).toBe(2);
    });
  });

  describe("event invalidation", () => {
    it("removes every entry registered for the event", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 10_000, "accountUpdated");
      cache.set("b", 2, 10_000, ["accountUpdated", "balanceChanged"]);
      cache.set("c", 3, 10_000, "balanceChanged");

      expect(cache.invalidate("accountUpdated")).toBe(2);
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).toBeNull();
      expect(cache.get("c")).toBe(3);
    });

    it("leaves entries without events untouched", () => {
      const cache = new EventSmartCache<number>();
      cache.set("plain", 1, 10_000);
      cache.set("tagged", 2, 10_000, "evt");
      cache.invalidate("evt");
      expect(cache.get("plain")).toBe(1);
    });

    it("returns 0 for an event nothing listens to", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 10_000, "evt");
      expect(cache.invalidate("other")).toBe(0);
      expect(cache.get("a")).toBe(1);
    });

    it("invalidating twice is a no-op the second time", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 10_000, "evt");
      expect(cache.invalidate("evt")).toBe(1);
      expect(cache.invalidate("evt")).toBe(0);
    });

    it("drops stale event registrations when a key is re-set", () => {
      const cache = new EventSmartCache<number>();
      cache.set("k", 1, 10_000, "old");
      cache.set("k", 2, 10_000, "new");
      expect(cache.invalidate("old")).toBe(0);
      expect(cache.get("k")).toBe(2);
      expect(cache.invalidate("new")).toBe(1);
    });

    it("an entry removed by one event no longer reacts to its other events", () => {
      const cache = new EventSmartCache<number>();
      cache.set("k", 1, 10_000, ["e1", "e2"]);
      expect(cache.invalidate("e1")).toBe(1);
      cache.set("k", 2, 10_000);
      expect(cache.invalidate("e2")).toBe(0);
      expect(cache.get("k")).toBe(2);
    });

    it("cleans event bookkeeping when entries expire or are deleted", () => {
      const cache = new EventSmartCache<number>();
      cache.set("expiring", 1, 100, "evt");
      cache.set("deleted", 2, 10_000, "evt");
      vi.advanceTimersByTime(200);
      cache.get("expiring");
      expect(cache.delete("deleted")).toBe(true);
      expect(cache.delete("deleted")).toBe(false);
      expect(cache.invalidate("evt")).toBe(0);
      expect(cache.size).toBe(0);
    });

    it("clear() empties entries and event bookkeeping", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 10_000, "evt");
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.invalidate("evt")).toBe(0);
    });

    it("does not retain memory across many invalidation cycles", () => {
      const cache = new EventSmartCache<number>();
      for (let i = 0; i < 1_000; i += 1) {
        cache.set(`k${i}`, i, 10_000, ["bulk", `own${i}`]);
      }
      expect(cache.invalidate("bulk")).toBe(1_000);
      expect(cache.size).toBe(0);
      expect(cache.invalidate("own5")).toBe(0);
    });
  });

  describe("stats", () => {
    it("tracks hits and misses via get()", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 1_000);
      cache.get("a");
      cache.get("a");
      cache.get("missing");

      expect(cache.hit()).toBe(2);
      expect(cache.miss()).toBe(1);
      expect(cache.stats()).toEqual({ hits: 2, misses: 1, hitRate: 2 / 3, size: 1 });
    });

    it("counts expired and invalidated reads as misses", () => {
      const cache = new EventSmartCache<number>();
      cache.set("ttl", 1, 100);
      cache.set("evt", 2, 10_000, "e");
      vi.advanceTimersByTime(200);
      cache.invalidate("e");
      cache.get("ttl");
      cache.get("evt");
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });
    });

    it("reports a hit rate of 0 before any lookup", () => {
      expect(new EventSmartCache().stats().hitRate).toBe(0);
    });

    it("resetStats() zeroes the counters but keeps entries", () => {
      const cache = new EventSmartCache<number>();
      cache.set("a", 1, 1_000);
      cache.get("a");
      cache.resetStats();
      expect(cache.stats()).toEqual({ hits: 0, misses: 0, hitRate: 0, size: 1 });
    });
  });
});
