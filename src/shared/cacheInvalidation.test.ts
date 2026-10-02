import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createInMemoryCache } from "./cache";
import type { SorokitCache } from "./cache";
import {
  CacheInvalidationManager,
  createCacheInvalidationManager,
  calculateAdaptiveTtl,
  getBaseTtl,
  getAffectedCacheKeys,
  invalidateAccountCachesForTransaction,
  createInvalidationPattern,
  type StateModifyingOperation,
  type HorizonInvalidationEvent,
} from "./cacheInvalidation";

describe("cacheInvalidation", () => {
  let cache: SorokitCache;
  let manager: CacheInvalidationManager;

  beforeEach(() => {
    cache = createInMemoryCache();
    manager = createCacheInvalidationManager({
      cache,
      horizonUrl: "https://horizon-testnet.stellar.org",
      strategy: "default",
      adaptiveTtlEnabled: true,
    });
  });

  afterEach(() => {
    manager.shutdown();
    vi.clearAllTimers();
  });

  describe("calculateAdaptiveTtl", () => {
    it("should return base TTL when no frequency hint provided", () => {
      const ttl = calculateAdaptiveTtl("account");
      expect(ttl).toBe(30_000); // 30 seconds
    });

    it("should return base TTL when frequency hint is 0", () => {
      const ttl = calculateAdaptiveTtl("account", 0);
      expect(ttl).toBe(30_000); // 30 seconds
    });

    it("should reduce TTL for high frequency data", () => {
      const baseTtl = calculateAdaptiveTtl("account");
      const highFreqTtl = calculateAdaptiveTtl("account", 1); // Frequency = 1 (highest)
      expect(highFreqTtl).toBeLessThan(baseTtl);
      expect(highFreqTtl).toBeGreaterThanOrEqual(5_000); // Min TTL
    });

    it("should keep TTL within min/max bounds", () => {
      const ttl = calculateAdaptiveTtl("balance", 2); // Extreme frequency
      expect(ttl).toBeGreaterThanOrEqual(5_000); // Min TTL for balance
      expect(ttl).toBeLessThanOrEqual(60_000); // Max TTL for balance
    });

    it("should return appropriate TTL for different data types", () => {
      expect(calculateAdaptiveTtl("account")).toBe(30_000);
      expect(calculateAdaptiveTtl("balance")).toBe(30_000);
      expect(calculateAdaptiveTtl("trustline")).toBe(60_000);
      expect(calculateAdaptiveTtl("operations")).toBe(60_000);
      expect(calculateAdaptiveTtl("contract_metadata")).toBe(3_600_000);
    });
  });

  describe("getBaseTtl", () => {
    it("should return base TTL for known data types", () => {
      expect(getBaseTtl("account")).toBe(30_000);
      expect(getBaseTtl("fee_estimate")).toBe(300_000);
      expect(getBaseTtl("transaction")).toBe(300_000);
      expect(getBaseTtl("contract_metadata")).toBe(3_600_000);
    });

    it("should return default fallback for unknown data types", () => {
      const ttl = getBaseTtl("invalid_type" as any);
      expect(ttl).toBe(60_000);
    });
  });

  describe("getAffectedCacheKeys", () => {
    it("should identify affected keys for payment operations", () => {
      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        affectedAssets: ["native"],
        timestamp: Date.now(),
      };

      const affected = getAffectedCacheKeys(operation);

      expect(affected.account).toContain("account:get:*:GXXXXX...");
      expect(affected.balance).toContain("account:balances:*:GXXXXX...");
      expect(affected.operations).toContain("account:operations:*:GXXXXX...");
    });

    it("should identify affected keys for trustline operations", () => {
      const operation: StateModifyingOperation = {
        type: "trustline",
        affectedAccount: "GXXXXX...",
        affectedAssets: ["USDC"],
        timestamp: Date.now(),
      };

      const affected = getAffectedCacheKeys(operation);

      expect(affected.trustline).toContain("account:trustlines:*:GXXXXX...");
      expect(affected.trustline.some((k) => k.includes("USDC"))).toBe(true);
    });

    it("should identify affected keys for contract write operations", () => {
      const operation: StateModifyingOperation = {
        type: "contract_write",
        affectedContracts: ["CAAAAA..."],
        timestamp: Date.now(),
      };

      const affected = getAffectedCacheKeys(operation);

      expect(affected.contractRead.some((k) => k.includes("CAAAAA..."))).toBe(
        true
      );
    });

    it("should identify affected keys for account merge operations", () => {
      const operation: StateModifyingOperation = {
        type: "account_merge",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      const affected = getAffectedCacheKeys(operation);

      // Account merge affects all account-related caches
      expect(affected.account.length).toBeGreaterThan(0);
      expect(affected.balance.length).toBeGreaterThan(0);
    });
  });

  describe("createInvalidationPattern", () => {
    it("should create matching pattern for account data type", () => {
      const pattern = createInvalidationPattern("account", "GXXXXX...");
      expect(pattern.test("account:get:https://horizon:GXXXXX...")).toBe(true);
      expect(pattern.test("account:get:https://other:GYYYY...")).toBe(false);
    });

    it("should create matching pattern for balance data type", () => {
      const pattern = createInvalidationPattern("balance", "GXXXXX...");
      expect(pattern.test("account:balances:https://horizon:GXXXXX...")).toBe(
        true
      );
      expect(pattern.test("account:balances:https://horizon:GYYYY...")).toBe(
        false
      );
    });

    it("should create matching pattern for contract_read", () => {
      const pattern = createInvalidationPattern("contract_read");
      expect(pattern.test("sorokit:contract-read:CAAAAA...:method:args")).toBe(
        true
      );
      expect(pattern.test("other:key")).toBe(false);
    });
  });

  describe("CacheInvalidationManager - default strategy", () => {
    beforeEach(() => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "default",
      });
    });

    it("should immediately invalidate cache on operation", () => {
      cache.set("account:get:https://horizon:GXXXXX...", { seq: 1 });

      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      expect(cache.get("account:get:https://horizon:GXXXXX...")).toBeUndefined();
    });

    it("should increment invalidation stats", () => {
      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      const stats = manager.getStats();
      expect(stats.totalInvalidations).toBeGreaterThan(0);
      expect(stats.invalidationsByStrategy.default).toBeGreaterThan(0);
    });

    it("should track which data types were invalidated", () => {
      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      const stats = manager.getStats();
      expect(stats.invalidationsByType.account).toBeGreaterThan(0);
      expect(stats.invalidationsByType.balance).toBeGreaterThan(0);
    });
  });

  describe("CacheInvalidationManager - smart strategy", () => {
    beforeEach(() => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "smart",
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should batch multiple operations within 100ms window", async () => {
      cache.set("account:get:https://horizon:GXXXXX...", { seq: 1 });
      cache.set("account:balances:https://horizon:GXXXXX...", []);

      const op1: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      const op2: StateModifyingOperation = {
        type: "trustline",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(op1);
      manager.invalidateAfterOperation(op2);

      // Operations should be queued but not invalidated yet
      let stats = manager.getStats();
      expect(stats.totalInvalidations).toBe(0);

      // Advance time to trigger batched invalidation
      vi.advanceTimersByTime(150);
      await vi.runAllTimersAsync();

      stats = manager.getStats();
      expect(stats.totalInvalidations).toBeGreaterThan(0);
    });
  });

  describe("CacheInvalidationManager - aggressive strategy", () => {
    beforeEach(() => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "aggressive",
      });
    });

    it("should invalidate immediately on operation", () => {
      cache.set("account:get:https://horizon:GXXXXX...", { seq: 1 });

      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      expect(cache.get("account:get:https://horizon:GXXXXX...")).toBeUndefined();
    });

    it("should also handle Horizon events", () => {
      cache.set("account:get:https://horizon:GXXXXX...", { seq: 1 });
      cache.set("account:balances:https://horizon:GXXXXX...", []);

      const event: HorizonInvalidationEvent = {
        type: "account_modified",
        affectedAccount: "GXXXXX...",
        ledgerSequence: 100,
        timestamp: Date.now(),
      };

      manager.invalidateAfterEvent(event);

      expect(cache.get("account:get:https://horizon:GXXXXX...")).toBeUndefined();
      expect(
        cache.get("account:balances:https://horizon:GXXXXX...")
      ).toBeUndefined();
    });

    it("should handle trustline modification events", () => {
      cache.set("account:trustlines:https://horizon:GXXXXX...", []);

      const event: HorizonInvalidationEvent = {
        type: "trustline_modified",
        affectedAccount: "GXXXXX...",
        affectedAssets: ["USDC"],
        timestamp: Date.now(),
      };

      manager.invalidateAfterEvent(event);

      expect(
        cache.get("account:trustlines:https://horizon:GXXXXX...")
      ).toBeUndefined();
    });

    it("should handle contract state change events", () => {
      cache.set("sorokit:contract-read:CAAAAA...:method:args", "result");

      const event: HorizonInvalidationEvent = {
        type: "contract_state_changed",
        affectedContracts: ["CAAAAA..."],
        timestamp: Date.now(),
      };

      manager.invalidateAfterEvent(event);

      expect(
        cache.get("sorokit:contract-read:CAAAAA...:method:args")
      ).toBeUndefined();
    });
  });

  describe("CacheInvalidationManager - manual operations", () => {
    it("should manually invalidate specific cache keys", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      manager.invalidateCacheKeys(["key1", "key2"]);

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBeUndefined();
    });

    it("should manually invalidate cache by prefix", () => {
      cache.set("account:get:url:GXXXXX...", { seq: 1 });
      cache.set("account:balances:url:GXXXXX...", []);
      cache.set("other:key", "value");

      manager.invalidateCachePrefix("account:");

      expect(cache.get("account:get:url:GXXXXX...")).toBeUndefined();
      expect(cache.get("account:balances:url:GXXXXX...")).toBeUndefined();
      expect(cache.get("other:key")).toBe("value");
    });

    it("should change strategy at runtime", () => {
      expect(manager.getStats().invalidationsByStrategy.default).toBe(0);

      manager.setStrategy("default");

      cache.set("account:get:https://horizon:GXXXXX...", { seq: 1 });

      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      expect(manager.getStats().invalidationsByStrategy.default).toBeGreaterThan(
        0
      );
    });

    it("should track last invalidation time", () => {
      const before = Date.now();

      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      const stats = manager.getStats();
      expect(stats.lastInvalidationTime).toBeDefined();
      expect(stats.lastInvalidationTime!).toBeGreaterThanOrEqual(before);
    });

    it("should reset statistics", () => {
      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: "GXXXXX...",
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      let stats = manager.getStats();
      expect(stats.totalInvalidations).toBeGreaterThan(0);

      manager.resetStats();

      stats = manager.getStats();
      expect(stats.totalInvalidations).toBe(0);
      expect(stats.lastInvalidationTime).toBeUndefined();
    });
  });

  describe("CacheInvalidationManager - Horizon event listening", () => {
    it("should only start listening with aggressive strategy", () => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "smart",
      });

      manager.startHorizonEventListening("GXXXXX...");

      const stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(false);
    });

    it("should start Horizon event listening with aggressive strategy", () => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "aggressive",
      });

      manager.startHorizonEventListening("GXXXXX...");

      const stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(true);
    });

    it("should stop Horizon event listening", () => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "aggressive",
      });

      manager.startHorizonEventListening("GXXXXX...");

      let stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(true);

      manager.stopHorizonEventListening("GXXXXX...");

      stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(false);
    });

    it("should prevent duplicate listeners for same account", () => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "aggressive",
      });

      manager.startHorizonEventListening("GXXXXX...");
      manager.startHorizonEventListening("GXXXXX..."); // Should be ignored

      // If duplicate prevention works, stats should still show one listener
      const stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(true);
    });
  });

  describe("CacheInvalidationManager - shutdown", () => {
    it("should clean up resources on shutdown", () => {
      manager = createCacheInvalidationManager({
        cache,
        horizonUrl: "https://horizon-testnet.stellar.org",
        strategy: "aggressive",
      });

      manager.startHorizonEventListening("GXXXXX...");

      let stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(true);

      manager.shutdown();

      stats = manager.getStats();
      expect(stats.eventPollingActive).toBe(false);
    });
  });

  describe("invalidateAccountCachesForTransaction", () => {
    it("should invalidate all account-related caches", () => {
      const publicKey = "GXXXXX...";

      cache.set(`account:get:https://horizon:${publicKey}`, { seq: 1 });
      cache.set(
        `account:balances:https://horizon:${publicKey}`,
        []
      );
      cache.set(`account:operations:https://horizon:${publicKey}`, []);
      cache.set(`account:effects:https://horizon:${publicKey}`, []);
      cache.set(`account:offers:https://horizon:${publicKey}`, []);
      cache.set(`account:trades:https://horizon:${publicKey}`, []);

      invalidateAccountCachesForTransaction(cache, publicKey);

      expect(
        cache.get(`account:get:https://horizon:${publicKey}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:balances:https://horizon:${publicKey}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:operations:https://horizon:${publicKey}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:effects:https://horizon:${publicKey}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:offers:https://horizon:${publicKey}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:trades:https://horizon:${publicKey}`)
      ).toBeUndefined();
    });

    it("should be safe to call with non-existent keys", () => {
      expect(() => {
        invalidateAccountCachesForTransaction(cache, "GXXXXX...");
      }).not.toThrow();
    });
  });

  describe("integration scenarios", () => {
    it("should handle complex multi-operation invalidation", () => {
      const account1 = "GXXXXX...";
      const account2 = "GYYYY...";

      cache.set(`account:get:https://horizon:${account1}`, { seq: 1 });
      cache.set(`account:get:https://horizon:${account2}`, { seq: 1 });
      cache.set(`account:balances:https://horizon:${account1}`, []);
      cache.set(`account:balances:https://horizon:${account2}`, []);

      // Operation 1: Payment from account1 to account2
      const op1: StateModifyingOperation = {
        type: "payment",
        affectedAccount: account1,
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(op1);

      // Account1 caches should be invalidated
      expect(
        cache.get(`account:get:https://horizon:${account1}`)
      ).toBeUndefined();
      expect(
        cache.get(`account:balances:https://horizon:${account1}`)
      ).toBeUndefined();

      // Account2 caches should NOT be invalidated (not the source account)
      expect(
        cache.get(`account:get:https://horizon:${account2}`)
      ).toBeDefined();
      expect(
        cache.get(`account:balances:https://horizon:${account2}`)
      ).toBeDefined();
    });

    it("should handle operations affecting multiple assets", () => {
      const account = "GXXXXX...";

      cache.set(`account:assetBalances:https://horizon:${account}:USDC`, []);
      cache.set(`account:assetBalances:https://horizon:${account}:EUR`, []);
      cache.set(`account:assetBalances:https://horizon:${account}:native`, []);

      const operation: StateModifyingOperation = {
        type: "payment",
        affectedAccount: account,
        affectedAssets: ["USDC", "EUR"],
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      const stats = manager.getStats();
      expect(stats.totalInvalidations).toBeGreaterThan(0);
    });

    it("should handle operations affecting multiple contracts", () => {
      const contract1 = "CAAAAA...";
      const contract2 = "CBBBBB...";

      cache.set(`sorokit:contract-read:${contract1}:method:args`, "result1");
      cache.set(`sorokit:contract-read:${contract2}:method:args`, "result2");

      const operation: StateModifyingOperation = {
        type: "contract_write",
        affectedContracts: [contract1, contract2],
        timestamp: Date.now(),
      };

      manager.invalidateAfterOperation(operation);

      expect(
        cache.get(`sorokit:contract-read:${contract1}:method:args`)
      ).toBeUndefined();
      expect(
        cache.get(`sorokit:contract-read:${contract2}:method:args`)
      ).toBeUndefined();
    });
  });
});
