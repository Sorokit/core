import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { estimateFee } from "../transaction/estimateFee";
import type { FeeEstimate } from "../transaction/estimateFee";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_FEE_CACHE_TTL_MS } from "../shared/constants";

// ─── Hoisted mocks (must be defined before vi.mock is hoisted) ────────────────

const mocks = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  fromXDR: vi.fn(),
  isSimulationSuccess: vi.fn(),
  isSimulationError: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mocks.simulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: mocks.isSimulationSuccess,
        isSimulationError: mocks.isSimulationError,
      },
    },
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: mocks.fromXDR,
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const MOCK_XDR = "AAAAAQAAAAC-mock-transaction-xdr-for-testing-purposes-only-AAAA";

const CACHED_FEE: FeeEstimate = {
  fee: "1100",
  feeFloat: 1100,
  feeXlm: "0.0001100",
  baseFee: "100",
  simulated: true,
};

function makeCacheKey(xdr: string): string {
  return `sorokit:fee:${createHash("sha256").update(xdr).digest("hex")}`;
}

function makeEmptyCache(): SorokitCache & {
  getCalls: number;
  setCalls: Array<{ key: string; value: unknown; ttl: number | undefined }>;
} {
  const store = new Map<string, unknown>();
  const setCalls: Array<{ key: string; value: unknown; ttl: number | undefined }> = [];
  let getCalls = 0;
  return {
    get getCalls() {
      return getCalls;
    },
    get setCalls() {
      return setCalls;
    },
    get: (key) => {
      getCalls++;
      return store.get(key);
    },
    set: (key, value, ttl) => {
      setCalls.push({ key, value, ttl });
      store.set(key, value);
    },
    invalidate: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

function makeCacheWithHit(xdr: string, value: FeeEstimate): SorokitCache & {
  simulateCallCount: number;
} {
  const store = new Map<string, unknown>([[makeCacheKey(xdr), value]]);
  let simulateCallCount = 0;
  return {
    get simulateCallCount() {
      return simulateCallCount;
    },
    get: (key) => {
      simulateCallCount++;
      return store.get(key);
    },
    set: () => {},
    invalidate: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("estimateFee — caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: simulation returns a success result
    mocks.simulateTransaction.mockResolvedValue({ minResourceFee: "1000" });
    mocks.fromXDR.mockReturnValue({});
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
  });

  describe("cache hit", () => {
    it("returns cached fee without calling RPC", async () => {
      const cache = makeCacheWithHit(MOCK_XDR, CACHED_FEE);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual(CACHED_FEE);
      }
      // RPC simulation must NOT have been called
      expect(mocks.simulateTransaction).not.toHaveBeenCalled();
    });

    it("returns the exact cached object, not a re-computed one", async () => {
      const cache = makeCacheWithHit(MOCK_XDR, CACHED_FEE);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.fee).toBe(CACHED_FEE.fee);
        expect(result.data.feeFloat).toBe(CACHED_FEE.feeFloat);
        expect(result.data.feeXlm).toBe(CACHED_FEE.feeXlm);
        expect(result.data.simulated).toBe(CACHED_FEE.simulated);
      }
    });
  });

  describe("cache miss", () => {
    it("calls RPC simulation when cache is empty", async () => {
      const cache = makeEmptyCache();

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      expect(result.status).toBe("ok");
      expect(mocks.simulateTransaction).toHaveBeenCalledOnce();
    });

    it("stores the result in cache after a miss", async () => {
      const cache = makeEmptyCache();

      await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      expect(cache.setCalls).toHaveLength(1);
      const stored = cache.setCalls[0];
      expect(stored?.key).toBe(makeCacheKey(MOCK_XDR));
      expect((stored?.value as FeeEstimate).simulated).toBe(true);
    });

    it("uses SHA256 of the XDR as the cache key", async () => {
      const cache = makeEmptyCache();

      await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      const expectedKey = makeCacheKey(MOCK_XDR);
      expect(cache.setCalls[0]?.key).toBe(expectedKey);
    });
  });

  describe("cache expiry (simulated by cache returning undefined)", () => {
    it("calls RPC again after expiry (cache returns no value)", async () => {
      // Simulate an expired cache: get() always returns undefined
      const expiredCache: SorokitCache = {
        get: () => undefined,
        set: vi.fn(),
        invalidate: vi.fn(),
        clear: vi.fn(),
      };

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        expiredCache,
      );

      expect(result.status).toBe("ok");
      expect(mocks.simulateTransaction).toHaveBeenCalledOnce();
      // Result stored in cache again after the fresh simulation
      expect(expiredCache.set).toHaveBeenCalledOnce();
    });
  });

  describe("cache TTL", () => {
    it("passes the default 5-minute TTL to cache.set()", async () => {
      const cache = makeEmptyCache();

      await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
      );

      expect(cache.setCalls[0]?.ttl).toBe(DEFAULT_FEE_CACHE_TTL_MS);
    });

    it("passes a custom TTL when provided", async () => {
      const cache = makeEmptyCache();
      const customTtl = 60_000; // 1 minute

      await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
        cache,
        customTtl,
      );

      expect(cache.setCalls[0]?.ttl).toBe(customTtl);
    });
  });

  describe("backward compatibility — no cache provided", () => {
    it("calls RPC and returns a fee estimate when no cache is given", async () => {
      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
      );

      expect(result.status).toBe("ok");
      expect(mocks.simulateTransaction).toHaveBeenCalledOnce();
    });

    it("returns a correctly shaped FeeEstimate without cache", async () => {
      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
      );

      if (result.status === "ok") {
        expect(typeof result.data.fee).toBe("string");
        expect(typeof result.data.feeFloat).toBe("number");
        expect(typeof result.data.feeXlm).toBe("string");
        expect(typeof result.data.baseFee).toBe("string");
        expect(typeof result.data.simulated).toBe("boolean");
        expect(result.data.simulated).toBe(true);
      }
    });

    it("falls back to base fee when simulation returns an error", async () => {
      mocks.isSimulationSuccess.mockReturnValue(false);
      mocks.isSimulationError.mockReturnValue(true);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        { kind: "xdr", transactionXdr: MOCK_XDR },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.simulated).toBe(false);
      }
    });
  });
});
