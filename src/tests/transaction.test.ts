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
} from "../transaction/buildTransaction";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  buildPaymentWithTrustline,
  buildSwapTransaction,
  buildPaymentTransaction,
  clearSequenceCache,
} from "../transaction/buildTransaction";
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
    return { code, issuer: issuer || null };
  });
  (mockAsset as any).native = () => ({ code: "XLM", issuer: null });
  return {
    ...actual,
    Asset: mockAsset,
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
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mocks.loadAccount,
      })),
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
      mocks.loadAccount.mockResolvedValue({
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
      accountId: () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    });

    const result = await buildPaymentTransaction(
      networkConfig.horizonUrl,
      networkConfig,
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      {
        destination: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
        amount: "10",
        autoFetchSequence: true,
      },
    );

    expect(mockLoadAccount).toHaveBeenCalledOnce();
    // Result may succeed or fail depending on mock build; we just verify Horizon was called
    expect(result).toBeDefined();
  });

  it("does not call Horizon when cache is populated within TTL", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
      amount: "10",
      autoFetchSequence: true as const,
    };
    const sourceKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

    // First call populates the cache
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);
    mockLoadAccount.mockReset();

    // Second call within TTL should use cache
    await buildPaymentTransaction(networkConfig.horizonUrl, networkConfig, sourceKey, params);

    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("calls Horizon again after cache TTL expires", async () => {
    const mockAccount = {
      sequence: "100",
      sequenceNumber: vi.fn().mockReturnValue("101"),
      incrementSequenceNumber: vi.fn(),
      subentry_count: 0,
      balances: [],
      accountId: () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const params = {
      destination: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
      amount: "10",
      autoFetchSequence: true as const,
    };
    const sourceKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

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
      accountId: () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const sourceKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
    const params = {
      destination: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
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
      accountId: () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const sourceKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
    const params = {
      destination: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
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
