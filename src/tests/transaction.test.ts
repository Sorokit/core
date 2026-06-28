import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { estimateFee } from "../transaction/estimateFee";
import type { FeeEstimate } from "../transaction/estimateFee";
import type { SorokitCache } from "../shared/cache";
import { DEFAULT_FEE_CACHE_TTL_MS } from "../shared/constants";
import {
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
  buildPaymentWithTrustline,
  buildSwapTransaction,
  clearSequenceCache,
} from "../transaction/buildTransaction";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import type {
  PaymentWithTrustlineParams,
  SwapTransactionParams,
} from "../transaction/types";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";
import type { TransactionResult } from "../transaction/types";
import {
  applyTransactionFilters,
  streamTransactions,
} from "../transaction/streamTransactions";
import { TokenBucketRateLimiter } from "../shared/utils";
import {
  createTransactionContext,
  TRANSACTION_CONTEXT_TTL_MS,
} from "../transaction/transactionContext";

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

// ─── Hoisted mocks (must be defined before vi.mock is hoisted) ────────────────

const transactionBuilderInstances: Array<{ memo?: unknown }> = [];

const mocks = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  fromXDR: vi.fn(),
  isSimulationSuccess: vi.fn(),
  isSimulationError: vi.fn(),
  loadAccount: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    static fromXDR = mocks.fromXDR;
    memo?: unknown;

    constructor(_sourceAccount: unknown, _options: unknown) {
      transactionBuilderInstances.push(this);
    }

    addOperation() {
      return this;
    }

    setTimeout() {
      return this;
    }

    addMemo(memo: unknown) {
      this.memo = memo;
      return this;
    }

    build() {
      return { toXDR: () => MOCK_XDR };
    }
  }

  const mockAsset = vi.fn().mockImplementation((code: string, issuer?: string) => {
    if (code === "XLM") return actual.Asset.native();
    return new actual.Asset(code, issuer || "");
  });
  (mockAsset as any).native = () => actual.Asset.native();

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        transactions: vi.fn().mockImplementation(() => {
          const builder: any = {
            forAccount: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            order: vi.fn(() => builder),
            cursor: vi.fn(() => builder),
            call: mockTransactionsCall,
            transaction: vi.fn().mockReturnValue({
              call: mockTransactionCall,
            }),
          };
          return builder;
        }),
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
    },
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: mocks.fromXDR,
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
        simulateTransaction: mocks.simulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: mocks.isSimulationSuccess,
        isSimulationError: mocks.isSimulationError,
      },
    },
    TransactionBuilder: MockTransactionBuilder,

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
// ─── Helpers ──────────────────────────────────────────────────────────────────

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const MOCK_XDR = "AAAAAQAAAAA=";

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

const TRANSACTION_FIXTURES: TransactionResult[] = [
  {
    hash: "tx_1",
    status: "success",
    ledger: 100,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    hash: "tx_2",
    status: "failed",
    ledger: 110,
    createdAt: "2024-01-02T00:00:00Z",
  },
  {
    hash: "tx_3",
    status: "pending",
    ledger: 120,
    createdAt: "2024-01-03T00:00:00Z",
  },
  {
    hash: "tx_4",
    status: "success",
    ledger: 130,
    createdAt: "2024-01-04T00:00:00Z",
  },
];

function transactionHashes(transactions: TransactionResult[]): string[] {
  return transactions.map((tx) => tx.hash);
}

function makeHorizonRecord(
  tx: TransactionResult,
  pagingToken: string,
): Record<string, unknown> {
  return {
    hash: tx.hash,
    successful: tx.status === "success",
    ledger_attr: tx.ledger,
    created_at: tx.createdAt,
    fee_charged: tx.fee ?? "100",
    envelope_xdr: tx.envelopeXdr ?? "envelope_xdr",
    result_xdr: tx.resultXdr ?? "result_xdr",
    paging_token: pagingToken,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────


describe("transaction streaming filters", () => {
  it("returns the first page with default pagination when no filters are provided", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES);

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_2", "tx_3", "tx_4"]);
  });

  it("filters by minimum ledger", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      minLedger: 110,
    });

    expect(transactionHashes(result)).toEqual(["tx_2", "tx_3", "tx_4"]);
  });

  it("filters by maximum ledger", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      maxLedger: 120,
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_2", "tx_3"]);
  });

  it("filters by combined ledger range", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      minLedger: 110,
      maxLedger: 120,
    });

    expect(transactionHashes(result)).toEqual(["tx_2", "tx_3"]);
  });

  it("excludes transactions without ledger when ledger filtering is active", () => {
    const result = applyTransactionFilters(
      [{ hash: "missing_ledger", status: "success" }, ...TRANSACTION_FIXTURES],
      { minLedger: 100 },
    );

    expect(transactionHashes(result)).not.toContain("missing_ledger");
  });

  it("filters by success status", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["success"],
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_4"]);
  });

  it("filters by failed status", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["failed"],
    });

    expect(transactionHashes(result)).toEqual(["tx_2"]);
  });

  it("filters by pending status", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["pending"],
    });

    expect(transactionHashes(result)).toEqual(["tx_3"]);
  });

  it("filters by multiple statuses", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["success", "pending"],
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_3", "tx_4"]);
  });

  it("does not filter by status when statuses is empty", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: [],
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_2", "tx_3", "tx_4"]);
  });

  it("filters by afterDate inclusively", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      afterDate: "2024-01-02T00:00:00Z",
    });

    expect(transactionHashes(result)).toEqual(["tx_2", "tx_3", "tx_4"]);
  });

  it("filters by beforeDate inclusively", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      beforeDate: new Date("2024-01-03T00:00:00Z"),
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_2", "tx_3"]);
  });

  it("filters by combined date range", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      afterDate: "2024-01-02T00:00:00Z",
      beforeDate: "2024-01-03T00:00:00Z",
    });

    expect(transactionHashes(result)).toEqual(["tx_2", "tx_3"]);
  });

  it("excludes missing or invalid createdAt values when date filtering is active", () => {
    const result = applyTransactionFilters(
      [
        { hash: "missing_date", status: "success", ledger: 90 },
        {
          hash: "invalid_date",
          status: "success",
          ledger: 91,
          createdAt: "not-a-date",
        },
        ...TRANSACTION_FIXTURES,
      ],
      { afterDate: "2024-01-01T00:00:00Z" },
    );

    expect(transactionHashes(result)).not.toContain("missing_date");
    expect(transactionHashes(result)).not.toContain("invalid_date");
  });

  it("applies offset after filters", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["success", "pending"],
      offset: 1,
    });

    expect(transactionHashes(result)).toEqual(["tx_3", "tx_4"]);
  });

  it("applies limit after filters", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      statuses: ["success", "pending"],
      limit: 2,
    });

    expect(transactionHashes(result)).toEqual(["tx_1", "tx_3"]);
  });

  it("applies combined filters and pagination", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      minLedger: 100,
      maxLedger: 130,
      statuses: ["success", "pending"],
      afterDate: "2024-01-01T00:00:00Z",
      beforeDate: "2024-01-04T00:00:00Z",
      offset: 1,
      limit: 1,
    });

    expect(transactionHashes(result)).toEqual(["tx_3"]);
  });

  it("returns an empty page when filters match no transactions", () => {
    const result = applyTransactionFilters(TRANSACTION_FIXTURES, {
      minLedger: 999,
    });

    expect(result).toEqual([]);
  });

  it("streamTransactions yields filtered results and advances cursor from fetched page", async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: TRANSACTION_FIXTURES.map((tx, index) =>
        makeHorizonRecord(tx, `cursor_${index + 1}`),
      ),
    });

    const stream = streamTransactions(
      networkConfig.horizonUrl,
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      {
        maxPolls: 1,
        statuses: ["success"],
        limit: 1,
        offset: 1,
      },
    );

    const { value } = await stream.next();

    expect(value?.status).toBe("ok");
    if (value?.status === "ok") {
      expect(transactionHashes(value.data.transactions)).toEqual(["tx_4"]);
      expect(value.data.nextCursor).toBe("cursor_4");
    }
  });
});

function mockRecentFeeHistory(fees: string[]): void {
  mockTransactionsCall.mockResolvedValueOnce({
    records: fees.map((fee_charged) => ({ fee_charged })),
  });
}

describe("feeSurge helpers", () => {
  it("calculateMedian returns the middle value for odd-length arrays", () => {
    expect(calculateMedian([100, 300, 200])).toBe(200);
  });

  it("calculateMedian averages the two middle values for even-length arrays", () => {
    expect(calculateMedian([100, 200, 300, 400])).toBe(250);
  });

  it("isFeeSurge returns true when fee exceeds 2x median", () => {
    expect(isFeeSurge(501, 250)).toBe(true);
  });

  it("isFeeSurge returns false when fee is at or below 2x median", () => {
    expect(isFeeSurge(500, 250)).toBe(false);
    expect(isFeeSurge(499, 250)).toBe(false);
  });

  it("isFeeSurge returns false when median is zero", () => {
    expect(isFeeSurge(1000, 0)).toBe(false);
  });
});

describe("estimateFee — surge detection", () => {
  beforeEach(() => {
    transactionBuilderInstances.length = 0;
    mockTransactionsCall.mockReset();
    mocks.simulateTransaction.mockResolvedValue({ minResourceFee: "1000" });
    mocks.fromXDR.mockReturnValue({});
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
  });

  it("sets surge: false for a normal fee below 2x the recent median", async () => {
    // Simulated fee = 1000 + 100 (BASE_FEE) = 1100 stroops
    mockRecentFeeHistory(Array(10).fill("600"));

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("1100");
      expect(result.data.surge).toBe(false);
    }
  });

  it("sets surge: true when fee exceeds 2x the recent median", async () => {
    mockRecentFeeHistory(Array(10).fill("400"));

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.surge).toBe(true);
    }
  });

  it("omits surge when recent fee history is unavailable", async () => {
    mockTransactionsCall.mockRejectedValueOnce(new Error("network error"));

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.surge).toBeUndefined();
    }
  });

  it("omits surge when Horizon returns no transactions", async () => {
    mockTransactionsCall.mockResolvedValueOnce({ records: [] });

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.surge).toBeUndefined();
    }
  });

  it("invokes onFeeSurge callback when a surge is detected", async () => {
    mockRecentFeeHistory(Array(10).fill("400"));
    const onFeeSurge = vi.fn();

    await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { onFeeSurge },
    );

    expect(onFeeSurge).toHaveBeenCalledOnce();
    expect(onFeeSurge).toHaveBeenCalledWith(
      expect.objectContaining({ fee: "1100", surge: true }),
    );
  });

  it("does not invoke onFeeSurge when fee is normal", async () => {
    mockRecentFeeHistory(Array(10).fill("600"));
    const onFeeSurge = vi.fn();

    await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { onFeeSurge },
    );

    expect(onFeeSurge).not.toHaveBeenCalled();
  });

  it("fetchRecentMedianFee uses the last 10 transactions and caches the median", async () => {
    mockRecentFeeHistory(["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"]);
    const cache = makeEmptyCache();

    const median = await fetchRecentMedianFee(networkConfig.horizonUrl, cache);

    expect(median).toBe(550);
    expect(cache.setCalls).toContainEqual(
      expect.objectContaining({ key: MEDIAN_FEE_CACHE_KEY, value: 550 }),
    );
  });
});

describe("estimateFee — caching", () => {
  beforeEach(() => {
    transactionBuilderInstances.length = 0;
    mockSimulateTransaction.mockReset();
    mockTransactionsCall.mockReset();
    mockIsSimulationSuccess.mockReset();
    mockIsSimulationSuccess.mockReturnValue(true);
    mockLoadAccount.mockReset();
    mockBuild.mockReset();
    mockAddOperation.mockReset();
    mockAddMemo.mockReset();
    mockSetTimeout.mockReset();
    vi.clearAllMocks();

    // Default: simulation returns a success result
    mocks.simulateTransaction.mockResolvedValue({ minResourceFee: "1000" });
    mocks.fromXDR.mockReturnValue({});
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
    mocks.loadAccount.mockResolvedValue({});
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

  describe("transaction builders — memo validation", () => {
    const sourcePublicKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
    const destination = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";
    const issuerPublicKey = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";

    beforeEach(() => {
      mockLoadAccount.mockResolvedValue({
        accountId: () => sourcePublicKey,
        sequenceNumber: () => "1",
        incrementSequenceNumber: () => {},
      });
      transactionBuilderInstances.length = 0;
    });

    it("fails payment build when requireMemo is true and no memo provided", async () => {
      const result = await buildPaymentTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          destination,
          amount: "10",
          requireMemo: true,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Memo is required");
      }
    });

    it("builds payment transaction with valid text memo", async () => {
      const result = await buildPaymentTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          destination,
          amount: "10",
          memo: "hello",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(transactionBuilderInstances).toHaveLength(1);
      expect((transactionBuilderInstances[0].memo as any)?.type).toBe("text");
      expect((transactionBuilderInstances[0].memo as any)?.value).toBe("hello");
    });

    it("fails payment transaction with invalid hash memo", async () => {
      const result = await buildPaymentTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          destination,
          amount: "10",
          memo: "deadbeef",
          memoType: "hash",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Invalid memo for type hash");
      }
    });

    it("builds create account transaction with valid id memo", async () => {
      const result = await buildCreateAccountTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          destination,
          startingBalance: "2",
          memo: "1234567890",
          memoType: "id",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(transactionBuilderInstances).toHaveLength(1);
      expect((transactionBuilderInstances[0].memo as any)?.type).toBe("id");
    });

    it("builds trustline transaction with valid return memo", async () => {
      const result = await buildTrustlineTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetCode: "USD",
          assetIssuer: issuerPublicKey,
          memo: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          memoType: "return",
        },
      );

      if (result.status === "error") {
        console.error("Trustline build error", result.error);
      }

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(transactionBuilderInstances).toHaveLength(1);
      expect((transactionBuilderInstances[0].memo as any)?.type).toBe("return");
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
        MOCK_XDR,
        mockCache,
      );

      expect(result.status).toBe("ok");
      expect(mockCache.set).toHaveBeenCalledWith(
        "tx:test_hash",
        expect.objectContaining({ hash: "test_hash" }),
        DEFAULT_FEE_CACHE_TTL_MS,
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
        MOCK_XDR,
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

describe("sequence number auto-fetch cache", () => {
  const sourceKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
  const destination = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";

  beforeEach(() => {
    mockLoadAccount.mockReset();
    clearSequenceCache();
  });

  afterEach(() => {
    clearSequenceCache();
  });

  it("calls Horizon on cache miss and returns a result", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      sequence: "100",
      sequenceNumber: () => "100",
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => sourceKey,
    });

    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourceKey,
      {
        destination,
        amount: "10",
        autoFetchSequence: true,
      },
    );

    expect(mockLoadAccount).toHaveBeenCalledOnce();
    // Result may succeed or fail depending on mock build; we just verify Horizon was called
    expect(result).toBeDefined();
  });

  it("does not call Horizon when cache is populated within TTL", async () => {
    const sourceKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => sourceKey,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination,
      amount: "10",
      autoFetchSequence: true as const,
    };

    // First call populates the cache
    const res1 = await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    expect(res1.status).toBe("ok");
    mockLoadAccount.mockReset();

    // Second call within TTL should use cache
    const res2 = await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    expect(res2.status).toBe("ok");

    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("calls Horizon again after cache TTL expires", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => sourceKey,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination,
      amount: "10",
      autoFetchSequence: true as const,
    };

    // Populate cache using a past timestamp
    const realDateNow = Date.now;
    // First call with normal time
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    mockLoadAccount.mockReset();
    mockLoadAccount.mockResolvedValue(mockAccount);

    // Simulate time past TTL by mocking Date.now to return future time
    Date.now = vi.fn().mockReturnValue(realDateNow() + 6_000); // 6 seconds later

    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);

    Date.now = realDateNow; // restore
    expect(mockLoadAccount).toHaveBeenCalledOnce();
  });

  it("does not use cache when autoFetchSequence is false", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => sourceKey,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination,
      amount: "10",
    };

    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);

    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
  });

  it("clearSequenceCache() removes all cached entries", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => sourceKey,
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination,
      amount: "10",
      autoFetchSequence: true as const,
    };

    // Populate cache
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    mockLoadAccount.mockReset();
    mockLoadAccount.mockResolvedValue(mockAccount);

    clearSequenceCache();

    // Cache cleared — should fetch again
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    expect(mockLoadAccount).toHaveBeenCalledOnce();
  });
});

describe("createTransactionContext (#36)", () => {
  const CTX_SOURCE = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
  const CTX_DEST   = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";
  const CTX_ISSUER = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockLoadAccount.mockResolvedValue({
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => CTX_SOURCE,
    });
  });

  it("pre-fetches account on creation and returns an ok context", async () => {
    const result = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    expect(result.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledOnce();
  });

  it("buildPayment reuses cached account — no extra loadAccount call", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");
    mockLoadAccount.mockClear();

    await ctxResult.data.buildPayment({ destination: CTX_DEST, amount: "10" });
    await ctxResult.data.buildPayment({ destination: CTX_DEST, amount: "5" });

    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("buildCreateAccount reuses cached account", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");
    mockLoadAccount.mockClear();

    const r = await ctxResult.data.buildCreateAccount({
      destination: CTX_DEST,
      startingBalance: "1",
    });
    expect(r.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("buildTrustline reuses cached account", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");
    mockLoadAccount.mockClear();

    const r = await ctxResult.data.buildTrustline({
      assetCode: "USDC",
      assetIssuer: CTX_ISSUER,
    });
    expect(r.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("isExpired() returns false immediately after creation", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");
    expect(ctxResult.data.isExpired()).toBe(false);
  });

  it("isExpired() returns true after invalidate()", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");
    ctxResult.data.invalidate();
    expect(ctxResult.data.isExpired()).toBe(true);
  });

  it("refreshes account after context expires (invalidated)", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    if (ctxResult.status !== "ok") throw new Error("expected ok");

    ctxResult.data.invalidate();
    mockLoadAccount.mockClear();

    await ctxResult.data.buildPayment({ destination: CTX_DEST, amount: "1" });
    expect(mockLoadAccount).toHaveBeenCalledOnce();
  });

  it("returns TX_BUILD_FAILED when account cannot be loaded", async () => {
    mockLoadAccount.mockReset();
    mockLoadAccount.mockRejectedValue(new Error("account not found"));

    const result = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      CTX_SOURCE,
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });

  it("TRANSACTION_CONTEXT_TTL_MS is 5 minutes", () => {
    expect(TRANSACTION_CONTEXT_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("TokenBucketRateLimiter — rate limiting on submit", () => {
  it("acquire() resolves immediately when tokens are available", async () => {
    const limiter = new TokenBucketRateLimiter(5);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("constructor throws when maxRequestsPerSecond is 0", () => {
    expect(() => new TokenBucketRateLimiter(0)).toThrow(
      "maxRequestsPerSecond must be a positive number",
    );
  });

  it("constructor throws when maxRequestsPerSecond is negative", () => {
    expect(() => new TokenBucketRateLimiter(-5)).toThrow(
      "maxRequestsPerSecond must be a positive number",
    );
  });
});
import { Operation } from "@stellar/stellar-sdk";
import {
  buildReverseTransaction,
  buildPathPayment,
  buildAtomicSwap,
} from "../transaction/buildTransaction";
import type { PathPaymentParams, AtomicSwapParams } from "../transaction/types";

const SRC = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
const DST = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";

function fakeAccount() {
  return {
    accountId: () => SRC,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };
}

describe("buildReverseTransaction (#45)", () => {
  let paymentSpy: ReturnType<typeof vi.spyOn>;
  let changeTrustSpy: ReturnType<typeof vi.spyOn>;
  let accountMergeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.loadAccount.mockResolvedValue(fakeAccount());
    transactionBuilderInstances.length = 0;
    paymentSpy = vi.spyOn(Operation, "payment").mockReturnValue({} as any);
    changeTrustSpy = vi.spyOn(Operation, "changeTrust").mockReturnValue({} as any);
    accountMergeSpy = vi.spyOn(Operation, "accountMerge").mockReturnValue({} as any);
  });

  afterEach(() => {
    paymentSpy.mockRestore();
    changeTrustSpy.mockRestore();
    accountMergeSpy.mockRestore();
  });

  it("reverses a payment operation — returns ok with XDR", async () => {
    mocks.fromXDR.mockReturnValue({
      operations: [
        { type: "payment", destination: DST, asset: {}, amount: "100", source: undefined },
      ],
    });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "original-xdr",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe(MOCK_XDR);
    expect(paymentSpy).toHaveBeenCalledOnce();
  });

  it("reverses a changeTrust operation — sets limit to 0", async () => {
    mocks.fromXDR.mockReturnValue({
      operations: [
        { type: "changeTrust", line: {}, limit: "1000" },
      ],
    });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "original-xdr",
    );

    expect(result.status).toBe("ok");
    expect(changeTrustSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: "0" }));
  });

  it("reverses a createAccount operation — returns ok with XDR", async () => {
    mocks.fromXDR.mockReturnValue({
      operations: [
        { type: "createAccount", destination: DST, startingBalance: "1", source: undefined },
      ],
    });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "original-xdr",
    );

    expect(result.status).toBe("ok");
    expect(accountMergeSpy).toHaveBeenCalledOnce();
  });

  it("returns TX_BUILD_FAILED for unsupported operation types", async () => {
    mocks.fromXDR.mockReturnValue({
      operations: [{ type: "manageOffer" }],
    });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "original-xdr",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toContain("Cannot reverse operation type");
    }
  });

  it("returns TX_BUILD_FAILED when the original transaction has no operations", async () => {
    mocks.fromXDR.mockReturnValue({ operations: [] });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "original-xdr",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });

  it("returns TX_BUILD_FAILED when fromXDR throws", async () => {
    mocks.fromXDR.mockImplementation(() => { throw new Error("invalid xdr"); });

    const result = await buildReverseTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      "bad-xdr",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });

  it("returns TX_BUILD_FAILED early when originalXdr is detectably malformed (#90)", async () => {
    // isXdrInvalidError catches these before fromXDR is even called
    const cases = ["", "!!!bad!!!", "AAAA"];
    for (const xdrInput of cases) {
      const result = await buildReverseTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SRC,
        xdrInput,
      );
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("malformed");
      }
    }
  });
});

describe("buildPathPayment (#47)", () => {
  let strictSendSpy: ReturnType<typeof vi.spyOn>;
  let strictReceiveSpy: ReturnType<typeof vi.spyOn>;

  const baseParams: PathPaymentParams = {
    destination: DST,
    mode: "strict-send",
    amount: "100",
    slippageAmount: "95",
    sendAssetCode: "XLM",
    destAssetCode: "USDC",
    destAssetIssuer: "GABC",
  };

  beforeEach(() => {
    mocks.loadAccount.mockResolvedValue(fakeAccount());
    transactionBuilderInstances.length = 0;
    strictSendSpy = vi.spyOn(Operation, "pathPaymentStrictSend").mockReturnValue({} as any);
    strictReceiveSpy = vi.spyOn(Operation, "pathPaymentStrictReceive").mockReturnValue({} as any);
  });

  afterEach(() => {
    strictSendSpy.mockRestore();
    strictReceiveSpy.mockRestore();
  });

  it("builds a strict-send path payment — returns ok with XDR", async () => {
    const result = await buildPathPayment(networkConfig.horizonUrl, networkConfig, SRC, baseParams);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe(MOCK_XDR);
    expect(strictSendSpy).toHaveBeenCalledOnce();
  });

  it("builds a strict-receive path payment — returns ok with XDR", async () => {
    const result = await buildPathPayment(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { ...baseParams, mode: "strict-receive" },
    );
    expect(result.status).toBe("ok");
    expect(strictReceiveSpy).toHaveBeenCalledOnce();
  });

  it("builds a path payment with intermediate path assets", async () => {
    const result = await buildPathPayment(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { ...baseParams, path: [{ assetCode: "BTC", assetIssuer: "GBTC" }] },
    );
    expect(result.status).toBe("ok");
    expect(strictSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.arrayContaining([expect.anything()]) }),
    );
  });

  it("returns TX_BUILD_FAILED when dest asset issuer is missing for non-native asset", async () => {
    const result = await buildPathPayment(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { ...baseParams, destAssetCode: "USDC", destAssetIssuer: undefined },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });

  it("returns TX_BUILD_FAILED when Horizon loadAccount fails", async () => {
    mocks.loadAccount.mockRejectedValue(new Error("network error"));
    const result = await buildPathPayment(networkConfig.horizonUrl, networkConfig, SRC, baseParams);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });
});

describe("buildAtomicSwap (#47)", () => {
  let strictSendSpy: ReturnType<typeof vi.spyOn>;
  let strictReceiveSpy: ReturnType<typeof vi.spyOn>;

  const legA: PathPaymentParams = {
    destination: DST,
    mode: "strict-send",
    amount: "100",
    slippageAmount: "95",
    sendAssetCode: "XLM",
    destAssetCode: "USDC",
    destAssetIssuer: "GABC",
  };

  const legB: PathPaymentParams = {
    destination: SRC,
    mode: "strict-send",
    amount: "50",
    slippageAmount: "45",
    sendAssetCode: "USDC",
    sendAssetIssuer: "GABC",
    destAssetCode: "XLM",
  };

  beforeEach(() => {
    mocks.loadAccount.mockResolvedValue(fakeAccount());
    transactionBuilderInstances.length = 0;
    strictSendSpy = vi.spyOn(Operation, "pathPaymentStrictSend").mockReturnValue({} as any);
    strictReceiveSpy = vi.spyOn(Operation, "pathPaymentStrictReceive").mockReturnValue({} as any);
  });

  afterEach(() => {
    strictSendSpy.mockRestore();
    strictReceiveSpy.mockRestore();
  });

  it("builds an atomic swap with two legs — returns ok with XDR", async () => {
    const result = await buildAtomicSwap(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { legA, legB },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe(MOCK_XDR);
    expect(strictSendSpy).toHaveBeenCalledTimes(2);
  });

  it("builds an atomic swap with mixed strict-send and strict-receive legs", async () => {
    const result = await buildAtomicSwap(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { legA, legB: { ...legB, mode: "strict-receive" } },
    );
    expect(result.status).toBe("ok");
    expect(strictSendSpy).toHaveBeenCalledTimes(1);
    expect(strictReceiveSpy).toHaveBeenCalledTimes(1);
  });

  it("returns TX_BUILD_FAILED when legA dest asset issuer is missing", async () => {
    const result = await buildAtomicSwap(
      networkConfig.horizonUrl,
      networkConfig,
      SRC,
      { legA: { ...legA, destAssetCode: "USDC", destAssetIssuer: undefined }, legB },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });

  it("returns TX_BUILD_FAILED when Horizon loadAccount fails", async () => {
    mocks.loadAccount.mockRejectedValue(new Error("timeout"));
    const result = await buildAtomicSwap(networkConfig.horizonUrl, networkConfig, SRC, { legA, legB });
    expect(result.status).toBe("error");
  });
});

// ─── Issue #91 — custom memoValidator callback ────────────────────────────────

describe("custom memoValidator callback (#91)", () => {
  const sourcePublicKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
  const destination = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";
  const issuerPublicKey = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";

  const validatorOk = (): SorokitResult<void> => ({
    status: "ok",
    data: undefined,
    error: null,
  });
  const validatorErr = (message: string): SorokitResult<void> => ({
    status: "error",
    data: null,
    error: { code: SorokitErrorCode.TX_BUILD_FAILED, message },
  });

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockLoadAccount.mockResolvedValue({
      accountId: () => sourcePublicKey,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
      subentry_count: 0,
      balances: [],
    });
    transactionBuilderInstances.length = 0;
  });

  // ── Payment ────────────────────────────────────────────────────────────────

  it("builds payment when custom memoValidator returns ok and memo is attached (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorOk());
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memo: "INV-42",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("ok");
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith("INV-42");
    expect(transactionBuilderInstances).toHaveLength(1);
    expect(transactionBuilderInstances[0]?.memo).toBeDefined();
  });

  it("returns TX_BUILD_FAILED when payment custom memoValidator returns error (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorErr("Memo must start with INV-"));
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memo: "BAD-42",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toBe("Memo must start with INV-");
    }
    // Transaction must not be built when validator rejects
    expect(transactionBuilderInstances).toHaveLength(0);
  });

  // ── Trustline ──────────────────────────────────────────────────────────────

  it("builds trustline when custom memoValidator returns ok (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorOk());
    const result = await buildTrustlineTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        assetCode: "USD",
        assetIssuer: issuerPublicKey,
        memo: "TL-ALLOWED",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("ok");
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith("TL-ALLOWED");
    expect(transactionBuilderInstances).toHaveLength(1);
  });

  it("returns TX_BUILD_FAILED when trustline custom memoValidator returns error (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorErr("Trustline memo not on whitelist"));
    const result = await buildTrustlineTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        assetCode: "USD",
        assetIssuer: issuerPublicKey,
        memo: "TL-BAD",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toBe("Trustline memo not on whitelist");
    }
    expect(transactionBuilderInstances).toHaveLength(0);
  });

  // ── Account create ─────────────────────────────────────────────────────────

  it("builds create account when custom memoValidator returns ok (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorOk());
    const result = await buildCreateAccountTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        startingBalance: "1",
        memo: "WELCOME-1",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("ok");
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith("WELCOME-1");
    expect(transactionBuilderInstances).toHaveLength(1);
  });

  it("returns TX_BUILD_FAILED when create account custom memoValidator returns error (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorErr("Refused by policy"));
    const result = await buildCreateAccountTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        startingBalance: "1",
        memo: "X",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toBe("Refused by policy");
    }
    expect(transactionBuilderInstances).toHaveLength(0);
  });

  // ── Backward compatibility + edge cases ────────────────────────────────────

  it("does not invoke memoValidator when no memo is provided (backward-compatible) (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorOk());
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("ok");
    expect(validator).not.toHaveBeenCalled();
  });

  it("validator runs BEFORE memo type validation — a bad hash value is rejected by validator first (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorErr("Rejected by validator"));
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memo: "deadbeef", // would also fail later as hash (length != 32 hex chars)
        memoType: "hash",
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toBe("Rejected by validator");
    }
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("builds payment without memoValidator (backward-compatible — feature is optional) (#91)", async () => {
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memo: "no-validator",
      },
    );

    expect(result.status).toBe("ok");
    expect(transactionBuilderInstances).toHaveLength(1);
  });

  it("works in combination with requireMemo — validator receives the memo string (#91)", async () => {
    const validator = vi.fn().mockReturnValue(validatorOk());
    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      {
        destination,
        amount: "10",
        memo: "REQ-OK",
        requireMemo: true,
        memoValidator: validator,
      },
    );

    expect(result.status).toBe("ok");
    expect(validator).toHaveBeenCalledWith("REQ-OK");
  });
});

describe("validateTransactionXdr (#99)", () => {
  const realSdk = vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk",
  );

  async function buildSamplePaymentXdr(opts?: {
    destination?: string;
    amount?: string;
    fee?: string;
  }): Promise<{ xdr: string; networkPassphrase: string }> {
    const sdk = await realSdk;
    const source = sdk.Keypair.random();
    const dest =
      opts?.destination ?? sdk.Keypair.random().publicKey();
    const account = new sdk.Account(source.publicKey(), "1");
    const tx = new sdk.TransactionBuilder(account, {
      fee: opts?.fee ?? sdk.BASE_FEE,
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(
        sdk.Operation.payment({
          destination: dest,
          asset: sdk.Asset.native(),
          amount: opts?.amount ?? "10",
        }),
      )
      .setTimeout(100)
      .build();
    return { xdr: tx.toXDR(), networkPassphrase: sdk.Networks.TESTNET };
  }

  it("returns valid for a well-formed payment transaction", async () => {
    const { validateTransactionXdr } = await import(
      "../transaction/validateTransactionXdr"
    );
    const { xdr, networkPassphrase } = await buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, { networkPassphrase });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(true);
    expect(result.data.errors).toEqual([]);
    expect(result.data.operationCount).toBe(1);
  });

  it("flags malformed XDR with an XDR_INVALID finding", async () => {
    const { validateTransactionXdr } = await import(
      "../transaction/validateTransactionXdr"
    );
    const result = validateTransactionXdr("not-a-real-xdr", {
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.valid).toBe(false);
    expect(result.data.errors[0].code).toBe("XDR_INVALID");
  });

  it("flags fees that exceed the per-op cap as warnings", async () => {
    const { validateTransactionXdr } = await import(
      "../transaction/validateTransactionXdr"
    );
    const { xdr, networkPassphrase } = await buildSamplePaymentXdr({
      fee: "5000000",
    });
    const result = validateTransactionXdr(xdr, {
      networkPassphrase,
      maxFeePerOpStroops: 1000,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.warnings.some((w) => w.code === "FEE_TOO_HIGH")).toBe(true);
  });

  it("respects disallowed operation types", async () => {
    const { validateTransactionXdr } = await import(
      "../transaction/validateTransactionXdr"
    );
    const { xdr, networkPassphrase } = await buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, {
      networkPassphrase,
      disallowedOperationTypes: ["payment"],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.valid).toBe(false);
    expect(result.data.errors.some((e) => e.code === "OPERATION_DISALLOWED")).toBe(true);
  });

  it("invokes custom operation validator", async () => {
    const { validateTransactionXdr } = await import(
      "../transaction/validateTransactionXdr"
    );
    const { xdr, networkPassphrase } = await buildSamplePaymentXdr();
    const result = validateTransactionXdr(xdr, {
      networkPassphrase,
      customOperationValidator: () => [
        { severity: "error", code: "CUSTOM_FAIL", message: "blocked" },
      ],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.errors.some((e) => e.code === "CUSTOM_FAIL")).toBe(true);
  });
});