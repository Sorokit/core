import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";

const {
  mockSimulateTransaction,
  mockTransactionsCall,
  mockIsSimulationSuccess,
} = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockTransactionsCall: vi.fn(),
  mockIsSimulationSuccess: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        transactions: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              call: mockTransactionsCall,
            }),
          }),
        }),
      })),
    },
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: vi.fn().mockReturnValue({}),
    },
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: mockIsSimulationSuccess,
        isSimulationError: actual.rpc.Api.isSimulationError,
      },
    },
  };
});

import {
  calculateMedian,
  isFeeSurge,
  fetchRecentMedianFee,
  MEDIAN_FEE_CACHE_KEY,
} from "../transaction/feeSurge";
import { estimateFee } from "../transaction/estimateFee";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function createMockCache(initial?: unknown): SorokitCache & {
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  if (initial !== undefined) {
    store.set(MEDIAN_FEE_CACHE_KEY, initial);
  }
  return {
    store,
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    invalidate: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

function mockSuccessfulSimulation(totalFeeStroops: number) {
  mockSimulateTransaction.mockResolvedValue({
    minResourceFee: String(totalFeeStroops - 100),
    transactionData: {},
    latestLedger: 1,
    id: "1",
    events: [],
  });
}

function mockRecentTransactionFees(fees: number[]) {
  mockTransactionsCall.mockResolvedValue({
    records: fees.map((fee) => ({ fee_charged: String(fee) })),
  });
}

describe("transaction fee surge", () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset();
    mockTransactionsCall.mockReset();
    mockIsSimulationSuccess.mockReset();
    mockIsSimulationSuccess.mockReturnValue(true);
  });

  describe("calculateMedian", () => {
    it("returns the middle value for an odd-length array", () => {
      expect(calculateMedian([100, 300, 200])).toBe(200);
    });

    it("returns the average of two middle values for an even-length array", () => {
      expect(calculateMedian([100, 200, 300, 400])).toBe(250);
    });
  });

  describe("isFeeSurge", () => {
    it("detects surge when fee exceeds 2x median", () => {
      expect(isFeeSurge(500, 200)).toBe(true);
    });

    it("does not detect surge at exactly 2x median", () => {
      expect(isFeeSurge(400, 200)).toBe(false);
    });

    it("does not detect surge below 2x median", () => {
      expect(isFeeSurge(300, 200)).toBe(false);
    });
  });

  describe("fetchRecentMedianFee", () => {
    it("returns cached median without calling Horizon", async () => {
      const cache = createMockCache(150);

      const median = await fetchRecentMedianFee(
        networkConfig.horizonUrl,
        cache,
      );

      expect(median).toBe(150);
      expect(mockTransactionsCall).not.toHaveBeenCalled();
    });

    it("returns null when Horizon returns no transactions", async () => {
      mockTransactionsCall.mockResolvedValue({ records: [] });

      const median = await fetchRecentMedianFee(networkConfig.horizonUrl);

      expect(median).toBeNull();
    });

    it("stores fetched median in cache", async () => {
      mockRecentTransactionFees([100, 200, 300]);
      const cache = createMockCache();

      const median = await fetchRecentMedianFee(
        networkConfig.horizonUrl,
        cache,
      );

      expect(median).toBe(200);
      expect(cache.get(MEDIAN_FEE_CACHE_KEY)).toBe(200);
    });
  });

  describe("estimateFee", () => {
    it("returns surge: false for a normal fee relative to recent median", async () => {
      mockSuccessfulSimulation(200);
      mockRecentTransactionFees([100, 100, 100, 100, 100]);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          kind: "xdr",
          transactionXdr: "AAAAAgAAAABmockxdr==",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.surge).toBe(false);
      }
    });

    it("returns surge: true when estimated fee exceeds 2x recent median", async () => {
      mockSuccessfulSimulation(500);
      mockRecentTransactionFees([100, 100, 100, 100, 100]);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          kind: "xdr",
          transactionXdr: "AAAAAgAAAABmockxdr==",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.surge).toBe(true);
      }
    });

    it("omits surge when recent fee history is unavailable", async () => {
      mockSuccessfulSimulation(500);
      mockTransactionsCall.mockRejectedValue(new Error("Horizon unavailable"));

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          kind: "xdr",
          transactionXdr: "AAAAAgAAAABmockxdr==",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.surge).toBeUndefined();
      }
    });

    it("invokes onFeeSurge callback when surge is detected", async () => {
      mockSuccessfulSimulation(500);
      mockRecentTransactionFees([100, 100, 100, 100, 100]);
      const onFeeSurge = vi.fn();

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          kind: "xdr",
          transactionXdr: "AAAAAgAAAABmockxdr==",
        },
        { onFeeSurge },
      );

      expect(result.status).toBe("ok");
      expect(onFeeSurge).toHaveBeenCalledOnce();
      if (result.status === "ok") {
        expect(onFeeSurge).toHaveBeenCalledWith(result.data);
      }
    });

    it("uses cached median fee without calling Horizon", async () => {
      mockSuccessfulSimulation(500);
      const cache = createMockCache(100);

      const result = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          kind: "xdr",
          transactionXdr: "AAAAAgAAAABmockxdr==",
        },
        { cache },
      );

      expect(result.status).toBe("ok");
      expect(mockTransactionsCall).not.toHaveBeenCalled();
      if (result.status === "ok") {
        expect(result.data.surge).toBe(true);
      }
    });
  });
});
