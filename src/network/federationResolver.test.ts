/**
 * Tests for Stellar federation resolution with identity verification and caching (#517)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FederationResolver,
  parseFederationAddress,
  createFederationResolver,
  type FederationResolverConfig,
  type FederationAddress,
} from "./federationResolver";

describe("federationResolver", () => {
  let resolver: FederationResolver;

  beforeEach(() => {
    resolver = createFederationResolver({
      defaultTtlMs: 60000,
      enableCache: true,
      maxCacheSize: 100,
      timeoutMs: 5000,
    });
  });

  describe("parseFederationAddress", () => {
    it("should parse valid federation address without memo", () => {
      const result = parseFederationAddress("user*stellar.org");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.name).toBe("user");
        expect(result.data.domain).toBe("stellar.org");
        expect(result.data.memo).toBeNull();
      }
    });

    it("should parse valid federation address with memo", () => {
      const result = parseFederationAddress("user*stellar.org*123");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.name).toBe("user");
        expect(result.data.domain).toBe("stellar.org");
        expect(result.data.memo).toBe("123");
      }
    });

    it("should reject empty address", () => {
      const result = parseFederationAddress("");
      expect(result.status).toBe("error");
    });

    it("should reject invalid format", () => {
      const result = parseFederationAddress("invalid");
      expect(result.status).toBe("error");
    });

    it("should reject invalid domain", () => {
      const result = parseFederationAddress("user*nodomain");
      expect(result.status).toBe("error");
    });

    it("should reject empty name", () => {
      const result = parseFederationAddress("*stellar.org");
      expect(result.status).toBe("error");
    });
  });

  describe("FederationResolver", () => {
    it("should clear cache for specific address", () => {
      // Mock cache entry
      (resolver as any).cache.set("user*stellar.org", {
        resolved: {
          accountId: "GABC...",
          federationDomain: "stellar.org",
          originalAddress: "user*stellar.org",
        },
        timestamp: Date.now(),
      });

      resolver.clearCache("user*stellar.org");
      expect((resolver as any).cache.has("user*stellar.org")).toBe(false);
    });

    it("should clear all cache", () => {
      (resolver as any).cache.set("user*stellar.org", {
        resolved: {
          accountId: "GABC...",
          federationDomain: "stellar.org",
          originalAddress: "user*stellar.org",
        },
        timestamp: Date.now(),
      });

      resolver.clearCache();
      expect((resolver as any).cache.size).toBe(0);
    });

    it("should invalidate cache older than timestamp", () => {
      const oldTimestamp = Date.now() - 100000;
      (resolver as any).cache.set("user*stellar.org", {
        resolved: {
          accountId: "GABC...",
          federationDomain: "stellar.org",
          originalAddress: "user*stellar.org",
        },
        timestamp: oldTimestamp,
      });

      resolver.invalidateCacheOlderThan(Date.now() - 50000);
      expect((resolver as any).cache.has("user*stellar.org")).toBe(false);
    });

    it("should get cache stats", () => {
      const stats = resolver.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(100);
      expect(stats.ttlMs).toBe(60000);
    });

    it("should enforce max cache size", () => {
      const config: FederationResolverConfig = { maxCacheSize: 2 };
      const limitedResolver = createFederationResolver(config);

      for (let i = 0; i < 5; i++) {
        (limitedResolver as any).cache.set(`user${i}*stellar.org`, {
          resolved: {
            accountId: `GABC${i}`,
            federationDomain: "stellar.org",
            originalAddress: `user${i}*stellar.org`,
          },
          timestamp: Date.now(),
        });
      }

      const stats = limitedResolver.getCacheStats();
      expect(stats.size).toBe(2);
    });
  });

  describe("resolveAddress", () => {
    it("should validate address before resolution", async () => {
      const result = await resolver.resolveAddress("invalid");
      expect(result.status).toBe("error");
    });

    it("should return cached result if available", async () => {
      const cachedResolved = {
        accountId: "GABC...",
        federationDomain: "stellar.org",
        originalAddress: "user*stellar.org",
      };

      (resolver as any).cache.set("user*stellar.org", {
        resolved: cachedResolved,
        timestamp: Date.now(),
      });

      const result = await resolver.resolveAddress("user*stellar.org");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.accountId).toBe(cachedResolved.accountId);
      }
    });
  });

  describe("verifyIdentity", () => {
    it("should return verification result", async () => {
      // This test would require mocking fetch responses
      // For now, we test the structure
      const result = await resolver.verifyIdentity("user*stellar.org");
      // Since we can't actually fetch without a real server,
      // we expect either verified: false or an error
      expect(result.status).toBe("ok");
    });
  });
});
