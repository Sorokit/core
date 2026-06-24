import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  buildPaymentWithTrustline,
  buildSwapTransaction,
} from "../transaction/buildTransaction";
import type {
  PaymentWithTrustlineParams,
  SwapTransactionParams,
} from "../transaction/types";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";
import type { TransactionResult } from "../transaction/types";

const {
  mockSimulateTransaction,
  mockTransactionsCall,
  mockIsSimulationSuccess,
  mockSubmitTransaction,
  mockTransactionCall,
} = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockTransactionsCall: vi.fn(),
  mockIsSimulationSuccess: vi.fn(),
  mockSubmitTransaction: vi.fn(),
  mockTransactionCall: vi.fn(),
}));

const {
  mockLoadAccount,
  mockBuild,
  mockToXDR,
  mockAddOperation,
  mockAddMemo,
  mockSetTimeout,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockBuild: vi.fn(),
  mockToXDR: vi.fn(),
  mockAddOperation: vi.fn(),
  mockAddMemo: vi.fn(),
  mockSetTimeout: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  const mockAsset = vi.fn().mockImplementation((code: string, issuer?: string) => {
    return { code, issuer: issuer || null };
  });
  (mockAsset as any).native = () => ({ code: "XLM", issuer: null });
  return {
    ...actual,
    Asset: mockAsset,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        transactions: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              call: mockTransactionsCall,
            }),
          }),
          transaction: vi.fn().mockReturnValue({
            call: mockTransactionCall,
          }),
        }),
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
    },
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: vi.fn().mockReturnValue({}),
      mockImplementation: vi.fn(() => ({
        addOperation: mockAddOperation,
        addMemo: mockAddMemo,
        setTimeout: mockSetTimeout,
        build: mockBuild,
      })),
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

vi.mock("../transaction/buildTransaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transaction/buildTransaction")>();
  return {
    ...actual,
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
    mockLoadAccount.mockReset();
    mockBuild.mockReset();
    mockAddOperation.mockReset();
    mockAddMemo.mockReset();
    mockSetTimeout.mockReset();
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

describe.skip("multi-operation transaction builders", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockBuild.mockReset();
    mockAddOperation.mockReset();
    mockAddMemo.mockReset();
    mockSetTimeout.mockReset();

    mockLoadAccount.mockResolvedValue({
      sequence: "1",
      subentry_count: 0,
      balances: [],
    });

    mockAddOperation.mockReturnThis();
    mockAddMemo.mockReturnThis();
    mockSetTimeout.mockReturnThis();

    mockBuild.mockReturnValue({
      toXDR: vi.fn().mockReturnValue("AAAAAgAAAABmockxdr=="),
    });
  });

  describe("buildPaymentWithTrustline", () => {
    it("builds a transaction with trustline and payment operations", async () => {
      const params: PaymentWithTrustlineParams = {
        trustline: {
          assetCode: "USDC",
          assetIssuer: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
          limit: "1000",
        },
        payment: {
          destination: "GABCDEFGHJKLMNOPQRSTUVWXYZ23456789ABCD",
          amount: "100",
          assetCode: "XLM",
        },
      };

      const result = await buildPaymentWithTrustline(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("AAAAAgAAAABmockxdr==");
      }
      expect(mockLoadAccount).toHaveBeenCalledOnce();
      expect(mockAddOperation).toHaveBeenCalledTimes(2);
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("returns error when payment asset validation fails", async () => {
      const params: PaymentWithTrustlineParams = {
        trustline: {
          assetCode: "USDC",
          assetIssuer: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
        },
        payment: {
          destination: "GABCDEFGHJKLMNOPQRSTUVWXYZ23456789ABCD",
          amount: "100",
          assetCode: "USDC",
          assetIssuer: undefined,
        },
      };

      const result = await buildPaymentWithTrustline(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("TX_BUILD_FAILED");
        expect(result.error.message).toContain("Asset issuer is required");
      }
    });

    it("includes memo when provided", async () => {
      const params: PaymentWithTrustlineParams = {
        trustline: {
          assetCode: "USDC",
          assetIssuer: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
        },
        payment: {
          destination: "GABCDEFGHJKLMNOPQRSTUVWXYZ23456789ABCD",
          amount: "100",
          assetCode: "XLM",
          memo: "Test payment",
        },
      };

      const result = await buildPaymentWithTrustline(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });
  });

  describe("buildSwapTransaction", () => {
    it("builds a transaction with two payment operations", async () => {
      const params: SwapTransactionParams = {
        paymentA: {
          destination: "GDEST1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "100",
          assetCode: "XLM",
        },
        paymentB: {
          destination: "GDEST2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "50",
          assetCode: "XLM",
        },
      };

      const result = await buildSwapTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("AAAAAgAAAABmockxdr==");
      }
      expect(mockLoadAccount).toHaveBeenCalledOnce();
      expect(mockAddOperation).toHaveBeenCalledTimes(2);
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("returns error when first payment asset validation fails", async () => {
      const params: SwapTransactionParams = {
        paymentA: {
          destination: "GDEST1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "100",
          assetCode: "USDC",
          assetIssuer: undefined,
        },
        paymentB: {
          destination: "GDEST2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "50",
          assetCode: "XLM",
        },
      };

      const result = await buildSwapTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("TX_BUILD_FAILED");
        expect(result.error.message).toContain("Asset issuer is required");
      }
    });

    it("returns error when second payment asset validation fails", async () => {
      const params: SwapTransactionParams = {
        paymentA: {
          destination: "GDEST1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "100",
          assetCode: "XLM",
        },
        paymentB: {
          destination: "GDEST2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "50",
          assetCode: "USDC",
          assetIssuer: undefined,
        },
      };

      const result = await buildSwapTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("TX_BUILD_FAILED");
        expect(result.error.message).toContain("Asset issuer is required");
      }
    });

    it("includes memo when provided on first payment", async () => {
      const params: SwapTransactionParams = {
        paymentA: {
          destination: "GDEST1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "100",
          assetCode: "XLM",
          memo: "Swap memo",
        },
        paymentB: {
          destination: "GDEST2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA23456789AB",
          amount: "50",
          assetCode: "XLM",
        },
      };

      const result = await buildSwapTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        "GTEST1234567890ABCDEFGHIJ1234567890",
        params,
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });
  });
});

describe("transaction caching", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
    mockTransactionCall.mockReset();
  });

  describe("submitTransaction", () => {
    it("stores result in cache when cache is provided", async () => {
      const mockCache: SorokitCache = {
        get: vi.fn(),
        set: vi.fn(),
        invalidate: vi.fn(),
        clear: vi.fn(),
      };

      mockSubmitTransaction.mockResolvedValue({
        hash: "test_hash",
        ledger: 123,
        envelope_xdr: "envelope_xdr",
        result_xdr: "result_xdr",
      });

      const result = await submitTransaction(
        networkConfig.horizonUrl,
        networkConfig.networkPassphrase,
        "signed_xdr",
        mockCache,
      );

      expect(result.status).toBe("ok");
      expect(mockCache.set).toHaveBeenCalledWith(
        "tx:test_hash",
        expect.objectContaining({ hash: "test_hash" }),
        10 * 60 * 1000,
      );
    });

    it("does not store in cache when cache is not provided", async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: "test_hash",
        ledger: 123,
        envelope_xdr: "envelope_xdr",
        result_xdr: "result_xdr",
      });

      const result = await submitTransaction(
        networkConfig.horizonUrl,
        networkConfig.networkPassphrase,
        "signed_xdr",
      );

      expect(result.status).toBe("ok");
    });
  });

  describe("getTransactionStatus", () => {
    it("returns cached result when available", async () => {
      const cachedResult: TransactionResult = {
        hash: "test_hash",
        status: "success",
        ledger: 123,
      };

      const mockCache: SorokitCache = {
        get: vi.fn().mockReturnValue(cachedResult),
        set: vi.fn(),
        invalidate: vi.fn(),
        clear: vi.fn(),
      };

      const result = await getTransactionStatus(
        networkConfig.horizonUrl,
        "test_hash",
        mockCache,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual(cachedResult);
      }
      expect(mockCache.get).toHaveBeenCalledWith("tx:test_hash");
      expect(mockTransactionCall).not.toHaveBeenCalled();
    });

    it("queries Horizon when cache miss", async () => {
      const mockCache: SorokitCache = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
        invalidate: vi.fn(),
        clear: vi.fn(),
      };

      mockTransactionCall.mockResolvedValue({
        hash: "test_hash",
        successful: true,
        ledger_attr: 123,
        created_at: "2024-01-01",
        fee_charged: "100",
        envelope_xdr: "envelope_xdr",
        result_xdr: "result_xdr",
      });

      const result = await getTransactionStatus(
        networkConfig.horizonUrl,
        "test_hash",
        mockCache,
      );

      expect(result.status).toBe("ok");
      expect(mockTransactionCall).toHaveBeenCalledOnce();
      expect(mockCache.set).toHaveBeenCalledWith(
        "tx:test_hash",
        expect.objectContaining({ hash: "test_hash" }),
      );
    });

    it("queries Horizon when no cache provided", async () => {
      mockTransactionCall.mockResolvedValue({
        hash: "test_hash",
        successful: true,
        ledger_attr: 123,
        created_at: "2024-01-01",
        fee_charged: "100",
        envelope_xdr: "envelope_xdr",
        result_xdr: "result_xdr",
      });

      const result = await getTransactionStatus(
        networkConfig.horizonUrl,
        "test_hash",
      );

      expect(result.status).toBe("ok");
      expect(mockTransactionCall).toHaveBeenCalledOnce();
    });
  });
});
