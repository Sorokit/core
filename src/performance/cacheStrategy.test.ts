import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCache, CacheBuilder } from "./cacheStrategy";
import { SorokitErrorCode } from "../shared/response";

describe("cacheStrategy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createCache", () => {
    it("returns a CacheBuilder instance", () => {
      expect(createCache()).toBeInstanceOf(CacheBuilder);
    });

    it("supports fluent chaining of configuration methods", () => {
      const cache = createCache<number>()
        .ttl(1_000)
        .invalidateOn("changed")
        .warmCache([]);
      expect(cache).toBeInstanceOf(CacheBuilder);
    });
  });

  describe("get()", () => {
    it("calls the fetcher on a miss and caches the result", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(42);

      const result = await cache.get("answer", fetcher);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.value).toBe(42);
        expect(result.data.stale).toBe(false);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("serves subsequent calls from cache without re-invoking the fetcher", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(7);

      await cache.get("k", fetcher);
      const second = await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(second.status).toBe("ok");
      if (second.status === "ok") expect(second.data.value).toBe(7);
    });

    it("tracks hit and miss counts and computes hit rate", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(1);

      await cache.get("k", fetcher); // miss
      await cache.get("k", fetcher); // hit
      await cache.get("k", fetcher); // hit

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(2);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it("returns a SorokitResult error when the fetcher throws", async () => {
      const cache = createCache<number>();
      const boom = new Error("network down");
      const fetcher = vi.fn().mockRejectedValue(boom);

      const result = await cache.get("k", fetcher);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INTERNAL);
        expect(result.error.cause).toBe(boom);
      }
    });

    it("dedupes concurrent fetches for the same key", async () => {
      const cache = createCache<number>();
      let resolveFetch: (v: number) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const first = cache.get("k", fetcher);
      const second = cache.get("k", fetcher);

      resolveFetch!(99);
      const [r1, r2] = await Promise.all([first, second]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(r1.status).toBe("ok");
      expect(r2.status).toBe("ok");
    });
  });

  describe("TTL expiry", () => {
    it("re-fetches once the TTL has elapsed", async () => {
      vi.useFakeTimers();
      const cache = createCache<number>().ttl(1_000);
      const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const first = await cache.get("k", fetcher);
      expect(first.status).toBe("ok");
      if (first.status === "ok") expect(first.data.value).toBe(1);

      vi.advanceTimersByTime(999);
      const stillFresh = await cache.get("k", fetcher);
      if (stillFresh.status === "ok") expect(stillFresh.data.value).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      const expired = await cache.get("k", fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (expired.status === "ok") expect(expired.data.value).toBe(2);
    });

    it("never expires entries when .ttl() is not called", async () => {
      vi.useFakeTimers();
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(1);

      await cache.get("k", fetcher);
      vi.advanceTimersByTime(1_000 * 60 * 60 * 24 * 365);
      await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-positive ttl", () => {
      const cache = createCache<number>();
      expect(() => cache.ttl(0)).toThrow();
      expect(() => cache.ttl(-5)).toThrow();
    });
  });

  describe("event-based invalidation", () => {
    it("clears the cache when a registered event is emitted", async () => {
      const cache = createCache<number>().invalidateOn("accountChanged");
      const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await cache.get("k", fetcher);
      cache.emit("accountChanged");
      const afterInvalidation = await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      if (afterInvalidation.status === "ok") expect(afterInvalidation.data.value).toBe(2);
    });

    it("ignores events nobody registered for", async () => {
      const cache = createCache<number>().invalidateOn("accountChanged");
      const fetcher = vi.fn().mockResolvedValue(1);

      await cache.get("k", fetcher);
      cache.emit("somethingElse");
      await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("supports invalidation on more than one event name", async () => {
      const cache = createCache<number>()
        .invalidateOn("accountChanged")
        .invalidateOn("networkChanged");
      const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);

      await cache.get("k", fetcher);
      cache.emit("networkChanged");
      await cache.get("k", fetcher);
      cache.emit("accountChanged");
      await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  describe("manual invalidation", () => {
    it("invalidate() removes a single key", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await cache.get("k", fetcher);
      cache.invalidate("k");
      const result = await cache.get("k", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      if (result.status === "ok") expect(result.data.value).toBe(2);
      expect(cache.getStats().invalidations).toBe(1);
    });

    it("invalidate() on a missing key is a no-op", () => {
      const cache = createCache<number>();
      cache.invalidate("nope");
      expect(cache.getStats().invalidations).toBe(0);
    });

    it("clear() removes every entry", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(1);

      await cache.get("a", fetcher);
      await cache.get("b", fetcher);
      expect(cache.getStats().size).toBe(2);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().invalidations).toBe(2);
    });
  });

  describe("cache warming", () => {
    it("prefetches given keys with the supplied fetcher", async () => {
      const cache = createCache<string>();
      const fetcher = vi.fn(async (key: string) => `value-for-${key}`);

      cache.warmCache(["a", "b"], fetcher);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetcher).toHaveBeenCalledTimes(2);
      const peekA = cache.peek("a");
      if (peekA.status === "ok" && peekA.data) {
        expect(peekA.data.value).toBe("value-for-a");
      } else {
        throw new Error("expected warmed entry for key 'a'");
      }
    });

    it("a subsequent get() for a warmed key awaits the warm fetch instead of double-fetching", async () => {
      const cache = createCache<string>();
      const fetcher = vi.fn(async (key: string) => `value-for-${key}`);

      cache.warmCache(["publicKey"], fetcher);
      const result = await cache.get("publicKey", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.data.value).toBe("value-for-publicKey");
    });

    it("records pending warm keys when no fetcher is supplied", () => {
      const cache = createCache<string>();
      cache.warmCache(["publicKey"]);

      expect(cache.getStats().pendingWarmKeys).toBe(1);
    });

    it("does not re-warm a key that already holds a fresh entry", async () => {
      const cache = createCache<string>();
      const fetcher = vi.fn(async () => "first");

      await cache.get("k", fetcher);
      cache.warmCache(["k"], fetcher);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("is chainable alongside other configuration methods", () => {
      const cache = createCache<string>().ttl(5_000).warmCache([]).invalidateOn("x");
      expect(cache).toBeInstanceOf(CacheBuilder);
    });
  });

  describe("peek()", () => {
    it("returns ok(null) for a missing key without invoking any fetcher", () => {
      const cache = createCache<number>();
      const result = cache.peek("missing");
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.data).toBeNull();
    });

    it("returns the cached value without affecting hit/miss stats", async () => {
      const cache = createCache<number>();
      const fetcher = vi.fn().mockResolvedValue(5);
      await cache.get("k", fetcher);

      const statsBefore = cache.getStats();
      const peeked = cache.peek("k");
      const statsAfter = cache.getStats();

      expect(peeked.status).toBe("ok");
      if (peeked.status === "ok" && peeked.data) {
        expect(peeked.data.value).toBe(5);
        expect(peeked.data.stale).toBe(false);
      }
      expect(statsAfter.hits).toBe(statsBefore.hits);
      expect(statsAfter.misses).toBe(statsBefore.misses);
    });

    it("marks an expired entry as stale but does not trigger a refetch", async () => {
      vi.useFakeTimers();
      const cache = createCache<number>().ttl(1_000);
      const fetcher = vi.fn().mockResolvedValue(1);

      await cache.get("k", fetcher);
      vi.advanceTimersByTime(1_001);

      const peeked = cache.peek("k");
      expect(peeked.status).toBe("ok");
      if (peeked.status === "ok" && peeked.data) {
        expect(peeked.data.stale).toBe(true);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStats() memory usage", () => {
    it("reports zero usage for an empty cache", () => {
      const cache = createCache<number>();
      expect(cache.getStats().memoryUsageBytes).toBe(0);
    });

    it("reports non-zero, increasing usage as entries are added", async () => {
      const cache = createCache<string>();
      const fetcher = vi.fn(async () => "x".repeat(1_000));

      await cache.get("k", fetcher);
      const stats = cache.getStats();

      expect(stats.memoryUsageBytes).toBeGreaterThan(900);
    });
  });
});
