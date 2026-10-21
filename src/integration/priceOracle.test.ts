import { describe, expect, it, vi } from "vitest";
import {
  PriceOracle,
  createPriceOracle,
  checkPriceFeedStaleness,
  validatePriceFeedQuote,
  normalizeTimestampToMs,
  DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS,
} from "./priceOracle";
import { SorokitErrorCode } from "../shared/response";

describe("PriceOracle & Staleness Detection (#844)", () => {
  const baseTime = 1_700_000_000_000; // Reference ms

  describe("normalizeTimestampToMs", () => {
    it("parses epoch ms", () => {
      expect(normalizeTimestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    });

    it("parses epoch seconds to ms", () => {
      expect(normalizeTimestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
    });

    it("parses Date object", () => {
      const d = new Date(1_700_000_000_000);
      expect(normalizeTimestampToMs(d)).toBe(1_700_000_000_000);
    });

    it("parses ISO date string", () => {
      const iso = new Date(1_700_000_000_000).toISOString();
      expect(normalizeTimestampToMs(iso)).toBe(1_700_000_000_000);
    });

    it("returns null for invalid inputs", () => {
      expect(normalizeTimestampToMs(undefined)).toBeNull();
      expect(normalizeTimestampToMs(null)).toBeNull();
      expect(normalizeTimestampToMs("not-a-date")).toBeNull();
      expect(normalizeTimestampToMs(NaN)).toBeNull();
    });
  });

  describe("checkPriceFeedStaleness", () => {
    it("flags fresh feeds within the 5-minute threshold", () => {
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 60_000, // 1 min old
      };
      const result = checkPriceFeedStaleness(quote, DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS, baseTime);
      expect(result.isStale).toBe(false);
      expect(result.ageMs).toBe(60_000);
    });

    it("flags feeds older than configurable threshold as stale", () => {
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 301_000, // 5 min 1 sec old
      };
      const result = checkPriceFeedStaleness(quote, DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS, baseTime);
      expect(result.isStale).toBe(true);
      expect(result.ageMs).toBe(301_000);
    });

    it("considers quotes without timestamp stale", () => {
      const quote = { asset: "XLM", price: 0.12 };
      const result = checkPriceFeedStaleness(quote, DEFAULT_PRICE_FEED_STALENESS_THRESHOLD_MS, baseTime);
      expect(result.isStale).toBe(true);
    });
  });

  describe("validatePriceFeedQuote", () => {
    it("accepts fresh quotes", () => {
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 30_000,
      };
      const res = validatePriceFeedQuote(quote, {
        getCurrentTimeMs: () => baseTime,
      });
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.status).toBe("fresh");
      }
    });

    it("rejects invalid prices", () => {
      const quote = {
        asset: "XLM",
        price: -5,
        timestamp: baseTime,
      };
      const res = validatePriceFeedQuote(quote, {
        getCurrentTimeMs: () => baseTime,
      });
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });

    it("rejects stale quotes when onStale is reject (default)", () => {
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 400_000, // > 5 mins
      };
      const res = validatePriceFeedQuote(quote, {
        getCurrentTimeMs: () => baseTime,
      });
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
        expect(res.error.message).toContain("stale");
      }
    });

    it("warns but accepts stale quotes when onStale is warn", () => {
      const warnFn = vi.fn();
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 400_000,
      };
      const res = validatePriceFeedQuote(quote, {
        onStale: "warn",
        onStaleWarning: warnFn,
        getCurrentTimeMs: () => baseTime,
      });
      expect(res.status).toBe("ok");
      expect(warnFn).toHaveBeenCalledTimes(1);
      if (res.status === "ok") {
        expect(res.data.status).toBe("stale");
      }
    });

    it("respects custom stalenessThresholdMs", () => {
      const quote = {
        asset: "XLM",
        price: 0.12,
        timestamp: baseTime - 70_000, // 70 seconds old
      };
      // 60 second threshold
      const res = validatePriceFeedQuote(quote, {
        stalenessThresholdMs: 60_000,
        getCurrentTimeMs: () => baseTime,
      });
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.message).toContain("stale");
      }
    });
  });

  describe("PriceOracle Class", () => {
    it("fetches and validates fresh price quotes", async () => {
      const mockProvider = {
        getPrice: vi.fn().mockResolvedValue({
          asset: "XLM",
          price: 0.15,
          timestamp: baseTime - 10_000,
        }),
      };
      const oracle = createPriceOracle(mockProvider, {
        getCurrentTimeMs: () => baseTime,
      });

      const res = await oracle.getPrice("XLM");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.price).toBe(0.15);
      }
    });

    it("rejects stale price feed from provider", async () => {
      const mockProvider = {
        getPrice: vi.fn().mockResolvedValue({
          asset: "XLM",
          price: 0.15,
          timestamp: baseTime - 600_000, // 10 min old
        }),
      };
      const oracle = createPriceOracle(mockProvider, {
        getCurrentTimeMs: () => baseTime,
      });

      const res = await oracle.getPrice("XLM");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.message).toContain("stale");
      }
    });

    it("estimates fee in target currency with fresh oracle price", async () => {
      const mockProvider = {
        getPrice: vi.fn().mockResolvedValue({
          asset: "XLM",
          price: 0.2, // $0.20 per XLM
          timestamp: baseTime - 10_000,
        }),
      };
      const oracle = new PriceOracle(mockProvider, {
        getCurrentTimeMs: () => baseTime,
      });

      // 10,000,000 stroops = 1 XLM -> $0.20
      const res = await oracle.estimateFeeInCurrency(10_000_000, "USD");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.feeInCurrency).toBeCloseTo(0.2);
        expect(res.data.xlmPrice).toBe(0.2);
      }
    });

    it("converts rate between assets safely", async () => {
      const mockProvider = {
        getPrice: vi.fn().mockImplementation(async (asset: string) => {
          if (asset === "XLM") {
            return { asset: "XLM", price: 0.1, timestamp: baseTime - 10_000 };
          }
          return { asset: "USDC", price: 1.0, timestamp: baseTime - 10_000 };
        }),
      };
      const oracle = new PriceOracle(mockProvider, {
        getCurrentTimeMs: () => baseTime,
      });

      const res = await oracle.convertRate(100, "XLM", "USDC");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.rate).toBeCloseTo(0.1);
        expect(res.data.convertedAmount).toBeCloseTo(10);
      }
    });
  });
});
