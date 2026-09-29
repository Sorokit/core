import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSmartCache,
  generateCacheKey,
  hashParams,
  SmartCache,
} from "../shared/smartCache";
import { createInMemoryCache } from "../shared/cache";

describe("SmartCache & Key Generation", () => {
  describe("hashParams", () => {
    it("should deterministically hash objects regardless of key order", () => {
      const p1 = { b: 2, a: 1, c: { y: "hello", x: [3, 2, 1] } };
      const p2 = { a: 1, c: { x: [3, 2, 1], y: "hello" }, b: 2 };
      expect(hashParams(p1)).toBe(hashParams(p2));
    });

    it("should handle null and primitives", () => {
      expect(hashParams(null)).toBe("");
      expect(hashParams(undefined)).toBe("");
      expect(hashParams(42)).toBe("42");
      expect(hashParams("test")).toBe("test");
    });
  });

  describe("generateCacheKey", () => {
    it("generates simple keys without options", () => {
      expect(generateCacheKey("getAccount")).toBe("sorokit:getAccount");
    });

    it("generates structured keys with options", () => {
      const key = generateCacheKey("getAccount", {
        dataType: "account",
        account: "GABC123",
        params: { active: true },
      });
      expect(key).toBe("sorokit:account:getAccount:acc:GABC123:p:{active:true}");
    });

    it("generates contract invocation keys", () => {
      const key = generateCacheKey("invoke", {
        dataType: "contract",
        contractId: "CADDR123",
        method: "balance_of",
        params: ["GABC123"],
      });
      expect(key).toBe(
        "sorokit:contract:invoke:ctr:CADDR123:fn:balance_of:p:[GABC123]"
      );
    });
  });

  describe("SmartCache operations", () => {
    let cache: SmartCache;

    beforeEach(() => {
      cache = createSmartCache({ defaultTtlMs: 10_000 });
    });

    it("gets, sets, and tracks metrics", () => {
      expect(cache.get("key1")).toBeUndefined();
      cache.set("key1", { data: "test" });
      expect(cache.get("key1")).toEqual({ data: "test" });

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(1);
      expect(metrics.misses).toBe(1);
      expect(metrics.sets).toBe(1);
      expect(metrics.hitRate).toBe(0.5);
    });

    it("getOrSet computes on miss and returns cached on hit", async () => {
      const fetcher = vi.fn().mockResolvedValue("fetched_val");
      const res1 = await cache.getOrSet("fetchKey", fetcher);
      expect(res1).toBe("fetched_val");
      expect(fetcher).toHaveBeenCalledTimes(1);

      const res2 = await cache.getOrSet("fetchKey", fetcher);
      expect(res2).toBe("fetched_val");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("respects dataType TTL configuration", () => {
      const storage = createInMemoryCache();
      const setSpy = vi.spyOn(storage, "set");
      const customCache = createSmartCache({
        storage,
        ttlByDataType: {
          account: 5000,
        },
      });

      customCache.set("accKey", "val", { dataType: "account" });
      expect(setSpy).toHaveBeenCalledWith("accKey", "val", 5000);
    });

    it("invalidates keys and tracks invalidation metrics", () => {
      cache.set("key1", "val1");
      expect(cache.get("key1")).toBe("val1");
      cache.invalidate("key1");
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.getMetrics().invalidations).toBe(1);
    });

    it("invalidates for accounts and contracts on state change", () => {
      cache.set("accKey1", "val1", { account: "GABC123" });
      cache.set("accKey2", "val2", { account: "GDEF456" });
      cache.set("ctrKey1", "val3", { contractId: "CADDR1" });

      cache.onStateChange({
        type: "payment",
        affectedAccount: "GABC123",
      });

      expect(cache.get("accKey1")).toBeUndefined();
      expect(cache.get("accKey2")).toBe("val2");

      cache.onStateChange({
        type: "contract_call",
        affectedContractId: "CADDR1",
      });

      expect(cache.get("ctrKey1")).toBeUndefined();
    });

    it("clears and resets metrics", () => {
      cache.set("k1", "v1");
      cache.clear();
      expect(cache.get("k1")).toBeUndefined();

      cache.resetMetrics();
      expect(cache.getMetrics().hits).toBe(0);
      expect(cache.getMetrics().misses).toBe(0);
      expect(cache.getMetrics().sets).toBe(0);
    });
  });
});
