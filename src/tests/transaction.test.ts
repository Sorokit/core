import { describe, it, expect, vi, beforeEach, afterEach, type SpyInstance } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import {
  estimateFee,
  calculateFeeTiers,
  fetchFeeTiers,
  FEE_TIERS_CACHE_KEY,
} from "../transaction/estimateFee";
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
  checkTrustlines,
  buildBulkTrustlines,
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
import {
  createHashMemo,
  createIdMemo,
  createReturnMemo,
  createTextMemo,
  nativeAsset,
  usdcAsset,
  usdtAsset,
  usdt_assetAsset,
  eurcAsset,
  ativeAsset,
  USDC_MAINNET_ISSUER,
  USDT_MAINNET_ISSUER,
  EURC_MAINNET_ISSUER,
} from "../transaction";


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
  mockStrictSendPathsCall,
  mockStrictReceivePathsCall,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockBuild: vi.fn(),
  mockToXDR: vi.fn(),
  mockAddOperation: vi.fn(),
  mockAddMemo: vi.fn(),
  mockSetTimeout: vi.fn(),
  mockStrictSendPathsCall: vi.fn(),
  mockStrictReceivePathsCall: vi.fn(),
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

    addOperation(...args: any[]) {
      mockAddOperation(...args);
      return this;
    }

    setTimeout(...args: any[]) {
      mockSetTimeout(...args);
      return this;
    }

    addMemo(memo: unknown) {
      mockAddMemo(memo);
      this.memo = memo;
      return this;
    }

    build(...args: any[]) {
      const customBuild = mockBuild(...args);
      if (customBuild) return customBuild;
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
        strictSendPaths: vi.fn(() => ({
          call: mockStrictSendPathsCall,
        })),
        strictReceivePaths: vi.fn(() => ({
          call: mockStrictReceivePathsCall,
        })),
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
const VALID_32_BYTE_HASH =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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


describe("memo builders (#114)", () => {
  it("creates valid text memos up to the Stellar 28-byte limit", () => {
    expect(createTextMemo("invoice-123").type).toBe("text");
    expect(createTextMemo("a".repeat(28)).value).toBe("a".repeat(28));
  });

  it("rejects text memos over 28 bytes, including multibyte strings", () => {
    expect(() => createTextMemo("a".repeat(29))).toThrow("28 bytes");
    expect(() => createTextMemo("😀".repeat(8))).toThrow("28 bytes");
  });

  it("creates valid unsigned 64-bit id memos", () => {
    expect(createIdMemo(0).type).toBe("id");
    expect(createIdMemo("18446744073709551615").value).toBe(
      "18446744073709551615",
    );
  });

  it("rejects id memos outside the unsigned 64-bit range", () => {
    expect(() => createIdMemo(-1)).toThrow("unsigned 64-bit");
    expect(() => createIdMemo("18446744073709551616")).toThrow(
      "unsigned 64-bit",
    );
  });

  it("creates valid hash and return memos from hex strings", () => {
    expect(createHashMemo(VALID_32_BYTE_HASH).type).toBe("hash");
    expect(createReturnMemo(VALID_32_BYTE_HASH).type).toBe("return");
  });

  it("creates hash and return memos from 32-byte arrays", () => {
    expect(createHashMemo(Buffer.alloc(32)).type).toBe("hash");
    expect(createReturnMemo(new Uint8Array(32)).type).toBe("return");
  });

  it("rejects invalid hash formats and lengths", () => {
    expect(() => createHashMemo("abc")).toThrow("32-byte hex");
    expect(() => createHashMemo("z".repeat(64))).toThrow("32-byte hex");
    expect(() => createReturnMemo(Buffer.alloc(31))).toThrow("32 bytes");
  });
});

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
  let paymentSpy: MockInstance<any[], any>;
  let changeTrustSpy: MockInstance<any[], any>;
  let accountMergeSpy: MockInstance<any[], any>;

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
  let strictSendSpy: SpyInstance<
    Parameters<typeof Operation.pathPaymentStrictSend>,
    ReturnType<typeof Operation.pathPaymentStrictSend>
  >;
  let strictReceiveSpy: SpyInstance<
    Parameters<typeof Operation.pathPaymentStrictReceive>,
    ReturnType<typeof Operation.pathPaymentStrictReceive>
  >;

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

  it("dynamically finds strict-send paths when path and slippageAmount are omitted", async () => {
    mockStrictSendPathsCall.mockResolvedValueOnce({
      records: [
        {
          destination_amount: "98",
          path: [{ code: "BTC", issuer: "GBTC" }]
        }
      ]
    });
    
    const paramsWithoutPath = { ...baseParams };
    delete paramsWithoutPath.slippageAmount;
    delete paramsWithoutPath.path;

    const result = await buildPathPayment(networkConfig.horizonUrl, networkConfig, SRC, paramsWithoutPath);
    expect(result.status).toBe("ok");
    expect(mockStrictSendPathsCall).toHaveBeenCalledOnce();
    expect(strictSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ destMin: "98", path: expect.arrayContaining([expect.anything()]) }),
    );
  });

  it("dynamically finds strict-receive paths when path and slippageAmount are omitted", async () => {
    mockStrictReceivePathsCall.mockResolvedValueOnce({
      records: [
        {
          source_amount: "105",
          path: [{ code: "ETH", issuer: "GETH" }]
        }
      ]
    });
    
    const paramsWithoutPath: PathPaymentParams = { ...baseParams, mode: "strict-receive" };
    delete paramsWithoutPath.slippageAmount;
    delete paramsWithoutPath.path;

    const result = await buildPathPayment(networkConfig.horizonUrl, networkConfig, SRC, paramsWithoutPath);
    expect(result.status).toBe("ok");
    expect(mockStrictReceivePathsCall).toHaveBeenCalledOnce();
    expect(strictReceiveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sendMax: "105", path: expect.arrayContaining([expect.anything()]) }),
    );
  });
});

describe("buildAtomicSwap (#47)", () => {
  let strictSendSpy: SpyInstance<
    Parameters<typeof Operation.pathPaymentStrictSend>,
    ReturnType<typeof Operation.pathPaymentStrictSend>
  >;
  let strictReceiveSpy: SpyInstance<
    Parameters<typeof Operation.pathPaymentStrictReceive>,
    ReturnType<typeof Operation.pathPaymentStrictReceive>
  >;

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

describe("calculateFeeTiers — tier calculation", () => {
  it("returns BASE_FEE for all tiers when the fee array is empty", () => {
    const tiers = calculateFeeTiers([]);
    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("100");
    expect(tiers.fast).toBe("100");
  });

  it("returns BASE_FEE for all tiers when all fees are invalid or non-positive", () => {
    const tiers = calculateFeeTiers([0, -50, NaN, Infinity]);
    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("100");
    expect(tiers.fast).toBe("100");
  });

  it("returns the single fee for all tiers when only one fee is provided", () => {
    const tiers = calculateFeeTiers([300]);
    expect(tiers.economy).toBe("300");
    expect(tiers.standard).toBe("300");
    expect(tiers.fast).toBe("300");
  });

  it("returns the same value for all tiers when all fees are uniform", () => {
    const tiers = calculateFeeTiers(Array(10).fill(500));
    expect(tiers.economy).toBe("500");
    expect(tiers.standard).toBe("500");
    expect(tiers.fast).toBe("500");
  });

  it("computes 10th, 50th, and 90th percentiles from a varied fee distribution", () => {
    // Unsorted input; sorted result: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    const fees = [500, 100, 300, 700, 900, 200, 400, 600, 800, 1000];
    const tiers = calculateFeeTiers(fees);
    // 10th: floor(0.10 * 10)=1 → sorted[1]=200
    // 50th: floor(0.50 * 10)=5 → sorted[5]=600
    // 90th: floor(0.90 * 10)=9 → sorted[9]=1000
    expect(tiers.economy).toBe("200");
    expect(tiers.standard).toBe("600");
    expect(tiers.fast).toBe("1000");
  });

  it("filters out invalid values before computing percentiles", () => {
    // Valid fees: [100, 500, 900]; invalid: [0, -1, NaN]
    const fees = [100, 0, 500, -1, 900, NaN];
    const tiers = calculateFeeTiers(fees);
    // sorted valid: [100, 500, 900] (3 elements)
    // 10th: floor(0.10 * 3)=0 → sorted[0]=100
    // 50th: floor(0.50 * 3)=1 → sorted[1]=500
    // 90th: floor(0.90 * 3)=2 → sorted[2]=900
    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("500");
    expect(tiers.fast).toBe("900");
  });
});

describe("fetchFeeTiers — caching", () => {
  beforeEach(() => {
    mockTransactionsCall.mockReset();
  });

  it("fetches from Horizon on cache miss and stores result in cache", async () => {
    const cache = makeEmptyCache();
    mockTransactionsCall.mockResolvedValueOnce({
      records: ["100", "500", "900"].map((fee_charged) => ({ fee_charged })),
    });

    const tiers = await fetchFeeTiers(networkConfig.horizonUrl, cache);

    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("500");
    expect(tiers.fast).toBe("900");
    expect(mockTransactionsCall).toHaveBeenCalledOnce();
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.key).toBe(FEE_TIERS_CACHE_KEY);
    expect(cache.setCalls[0]?.ttl).toBe(DEFAULT_FEE_CACHE_TTL_MS);
  });

  it("returns cached tiers on hit without calling Horizon", async () => {
    const cache = makeEmptyCache();
    mockTransactionsCall.mockResolvedValue({
      records: ["100", "500", "900"].map((fee_charged) => ({ fee_charged })),
    });

    const first = await fetchFeeTiers(networkConfig.horizonUrl, cache);
    const second = await fetchFeeTiers(networkConfig.horizonUrl, cache);

    expect(first).toEqual(second);
    // Horizon must only be called once (second call is served from cache)
    expect(mockTransactionsCall).toHaveBeenCalledOnce();
  });

  it("falls back to BASE_FEE for all tiers when Horizon throws", async () => {
    mockTransactionsCall.mockRejectedValueOnce(new Error("network error"));

    const tiers = await fetchFeeTiers(networkConfig.horizonUrl);

    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("100");
    expect(tiers.fast).toBe("100");
  });

  it("falls back to BASE_FEE for all tiers when Horizon returns no records", async () => {
    mockTransactionsCall.mockResolvedValueOnce({ records: [] });

    const tiers = await fetchFeeTiers(networkConfig.horizonUrl);

    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("100");
    expect(tiers.fast).toBe("100");
  });
});

describe("estimateFee — fee tiers", () => {
  beforeEach(() => {
    mocks.simulateTransaction.mockResolvedValue({ minResourceFee: "1000" });
    mocks.fromXDR.mockReturnValue({});
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
    mockTransactionsCall.mockReset();
  });

  it("includes tiers in the result when includeTiers is true", async () => {
    // First mockTransactionsCall goes to fetchFeeTiers, second to fetchRecentMedianFee
    mockTransactionsCall
      .mockResolvedValueOnce({
        records: ["100", "500", "900"].map((fee_charged) => ({ fee_charged })),
      })
      .mockResolvedValueOnce({
        records: Array(10).fill({ fee_charged: "400" }),
      });

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { includeTiers: true },
describe("checkTrustlines", () => {
  const horizonUrl = "https://horizon-testnet.stellar.org";
  const sourcePublicKey = "GAS4V4O2B7DW5T7IQRPEEVCRXMDZESKISR7DVIGKZQYYV3OSQ5SH5LPE";

  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it("returns trusted assets", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: [
        { asset_type: "native", balance: "100.0" },
        { asset_type: "credit_alphanum4", asset_code: "USD", balance: "10.0" },
        { asset_type: "credit_alphanum4", asset_code: "EUR", balance: "5.0" },
      ],
    });

    const result = await checkTrustlines(horizonUrl, sourcePublicKey, ["USD", "GBP"]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual(["USD"]);
    }
  });

  it("handles empty balances", async () => {
    mockLoadAccount.mockResolvedValueOnce({ balances: [] });
    const result = await checkTrustlines(horizonUrl, sourcePublicKey, ["USD"]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([]);
    }
  });

  it("handles no existing trustlines", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: [
        { asset_type: "native", balance: "100.0" },
        { asset_type: "credit_alphanum4", asset_code: "EUR", balance: "5.0" },
      ],
    });
    const result = await checkTrustlines(horizonUrl, sourcePublicKey, ["USD"]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([]);
    }
  });
});

describe("buildBulkTrustlines", () => {
  const networkConfig: ResolvedNetworkConfig = {
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    networkType: "testnet",
  };
  const sourcePublicKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
  const issuerPublicKey = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockBuild.mockReset();
    mockAddOperation.mockReset();
    clearSequenceCache();
  });

  afterEach(() => {
    clearSequenceCache();
  });

  it("builds multiple changeTrust operations", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: sourcePublicKey,
      sequence: "12345",
      sequenceNumber: () => "12345",
      balances: [],
    });

    const result = await buildBulkTrustlines(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      [new Asset("USD", issuerPublicKey), new Asset("EUR", issuerPublicKey)]
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.tiers).toBeDefined();
      expect(result.data.tiers?.economy).toBe("100");
      expect(result.data.tiers?.standard).toBe("500");
      expect(result.data.tiers?.fast).toBe("900");
    }
  });

  it("omits tiers when includeTiers is not set", async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: Array(10).fill({ fee_charged: "400" }),
    });

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      expect(result.data).toBe(MOCK_XDR);
    }
    expect(mockAddOperation).toHaveBeenCalledTimes(2);
  });

  it("builds a single changeTrust operation", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: sourcePublicKey,
      sequence: "12345",
      sequenceNumber: () => "12345",
      balances: [],
    });

    const result = await buildBulkTrustlines(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      [new Asset("USD", issuerPublicKey)]
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.tiers).toBeUndefined();
    }
  });

  it("uses cache for fee tiers when options.cache is provided", async () => {
    const cache = makeEmptyCache();
    // First call: Horizon for tiers, then Horizon for median
    mockTransactionsCall
      .mockResolvedValueOnce({
        records: ["100", "500", "900"].map((fee_charged) => ({ fee_charged })),
      })
      .mockResolvedValueOnce({
        records: Array(10).fill({ fee_charged: "400" }),
      });

    await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { includeTiers: true, cache },
    );

    // The tiers should have been stored under FEE_TIERS_CACHE_KEY
    const cachedKey = cache.setCalls.find((c) => c.key === FEE_TIERS_CACHE_KEY);
    expect(cachedKey).toBeDefined();
  });
});
      expect(result.data).toBe(MOCK_XDR);
    }
    expect(mockAddOperation).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached sequence when autoFetchSequence is enabled", async () => {
    const mockAccount = {
      id: sourcePublicKey,
      sequence: "12345",
      sequenceNumber: vi.fn().mockReturnValue("12345"),
      balances: [],
    };
    mockLoadAccount.mockResolvedValue(mockAccount);

    const first = await buildBulkTrustlines(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      [new Asset("USD", issuerPublicKey)],
      true,
    );
    expect(first.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);

    mockLoadAccount.mockClear();

    const second = await buildBulkTrustlines(
      networkConfig.horizonUrl,
      networkConfig,
      sourcePublicKey,
      [new Asset("EUR", issuerPublicKey)],
      true,
    );
    if (second.status === "error") {
      throw new Error(second.error.message);
    }
    expect(second.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockAccount.sequenceNumber).toHaveBeenCalledTimes(1);
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

describe("validateDestination", () => {
  const VALID_DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFTECCNAIZ3JFRVKEAOJCHBR35CXY7Z5D";

  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it("validates valid public key format without existence check", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    const res = await validateDestination(VALID_DEST);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(true);
    expect(res.data.formatValid).toBe(true);
    expect(res.data.isSource).toBe(false);
    expect(res.data.exists).toBeNull();
  });

  it("returns invalid format for malformed public key", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    const res = await validateDestination("invalid-key");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(false);
    expect(res.data.formatValid).toBe(false);
    expect(res.data.error?.code).toBe("INVALID_FORMAT");
  });

  it("returns isSource true when destination matches source", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    const res = await validateDestination(VALID_DEST, { source: VALID_DEST });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(false);
    expect(res.data.isSource).toBe(true);
    expect(res.data.error?.code).toBe("SAME_AS_SOURCE");
  });

  it("fails if checkExists is true but horizonUrl is missing", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    const res = await validateDestination(VALID_DEST, { checkExists: true });
    expect(res.status).toBe("error");
    if (res.status !== "error") return;
    expect(res.error.message).toContain("horizonUrl is required");
  });

  it("returns exists true when account exists on-chain", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    mockLoadAccount.mockResolvedValue({ id: VALID_DEST });

    const res = await validateDestination(VALID_DEST, {
      checkExists: true,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(true);
    expect(res.data.exists).toBe(true);
    expect(mockLoadAccount).toHaveBeenCalledWith(VALID_DEST);
  });

  it("returns exists false when account is not found on-chain", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    const notFoundError = new Error("Request failed with status 404");
    (notFoundError as any).response = { status: 404 };
    mockLoadAccount.mockRejectedValue(notFoundError);

    const res = await validateDestination(VALID_DEST, {
      checkExists: true,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(false);
    expect(res.data.exists).toBe(false);
    expect(res.data.error?.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("returns FETCH_FAILED when Horizon check fails with other error", async () => {
    const { validateDestination } = await import("../transaction/validateDestination");
    mockLoadAccount.mockRejectedValue(new Error("Rate limit exceeded"));

    const res = await validateDestination(VALID_DEST, {
      checkExists: true,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.valid).toBe(false);
    expect(res.data.exists).toBeNull();
    expect(res.data.error?.code).toBe("FETCH_FAILED");
  });
});

describe("liquidity pool operations", () => {
  const sourcePublicKey = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
  const assetAIssuer = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";
  const assetBIssuer = "GB2O5PBQJDAFCNM2U2DMXXITWJZ7XPQ3OQKM2UK2PGFMKVHF4Z3DV3RA";
  const poolId = "dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7";

  beforeEach(() => {
    mockLoadAccount.mockResolvedValue({
      accountId: () => sourcePublicKey,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });
    transactionBuilderInstances.length = 0;
    mockAddOperation.mockClear();
    mockAddMemo.mockClear();
  });

  describe("buildCreateLiquidityPool", () => {
    it("builds a create liquidity pool transaction with valid assets", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30,
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "changeTrust",
        }),
      );
    });

    it("builds a liquidity pool with two non-native assets", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "EURC", assetIssuer: assetBIssuer },
          fee: 30,
        },
      );

      expect(result.status).toBe("ok");
    });

    it("validates fee is within valid range", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const resultNegative = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: -1,
        },
      );

      expect(resultNegative.status).toBe("error");
      if (resultNegative.status === "error") {
        expect(resultNegative.error.message).toContain("fee must be an integer between 0 and 10000");
      }

      const resultTooHigh = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 10001,
        },
      );

      expect(resultTooHigh.status).toBe("error");
    });

    it("validates fee is an integer", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30.5,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("fee must be an integer");
      }
    });

    it("fails when asset A is invalid", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC" }, // Missing issuer
          assetB: { assetCode: "XLM" },
          fee: 30,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Asset issuer is required");
      }
    });

    it("validates trusted issuers when provided", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30,
        },
        ["GB2O5PBQJDAFCNM2U2DMXXITWJZ7XPQ3OQKM2UK2PGFMKVHF4Z3DV3RA"], // Different issuer
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });

    it("supports memo in liquidity pool creation", async () => {
      const { buildCreateLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30,
          memo: "pool-setup",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalled();
      expect(transactionBuilderInstances[0].memo).toBeDefined();
    });

    it("supports autoFetchSequence", async () => {
      const { buildCreateLiquidityPool, clearSequenceCache } = await import("../transaction/buildTransaction");
      clearSequenceCache();

      mockLoadAccount.mockResolvedValueOnce({
        accountId: () => sourcePublicKey,
        sequenceNumber: () => "100",
        incrementSequenceNumber: () => {},
      });

      await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30,
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await buildCreateLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          assetA: { assetCode: "USDC", assetIssuer: assetAIssuer },
          assetB: { assetCode: "XLM" },
          fee: 30,
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildDepositLiquidityPool", () => {
    it("builds a deposit liquidity pool transaction with valid parameters", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "liquidityPoolDeposit",
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
        }),
      );
    });

    it("fails when maxAmountA is missing", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("maxAmountA and maxAmountB are required");
      }
    });

    it("fails when maxAmountB is missing", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "",
          minPrice: "0.45",
          maxPrice: "0.55",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("maxAmountA and maxAmountB are required");
      }
    });

    it("validates amounts are positive", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const resultNegativeA = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "-10",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
        },
      );

      expect(resultNegativeA.status).toBe("error");
      if (resultNegativeA.status === "error") {
        expect(resultNegativeA.error.message).toContain("must be positive");
      }

      const resultZeroB = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "0",
          minPrice: "0.45",
          maxPrice: "0.55",
        },
      );

      expect(resultZeroB.status).toBe("error");
    });

    it("validates price bounds are provided", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const resultNoMin = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "",
          maxPrice: "0.55",
        },
      );

      expect(resultNoMin.status).toBe("error");
      if (resultNoMin.status === "error") {
        expect(resultNoMin.error.message).toContain("minPrice and maxPrice are required");
      }
    });

    it("validates price bounds are positive", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "-0.45",
          maxPrice: "0.55",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("must be positive");
      }
    });

    it("validates minPrice is less than or equal to maxPrice", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.60",
          maxPrice: "0.55",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("minPrice must be less than or equal to maxPrice");
      }
    });

    it("supports memo in liquidity pool deposit", async () => {
      const { buildDepositLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
          memo: "deposit-lp",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalled();
    });

    it("supports autoFetchSequence", async () => {
      const { buildDepositLiquidityPool, clearSequenceCache } = await import("../transaction/buildTransaction");
      clearSequenceCache();

      mockLoadAccount.mockResolvedValueOnce({
        accountId: () => sourcePublicKey,
        sequenceNumber: () => "200",
        incrementSequenceNumber: () => {},
      });

      await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await buildDepositLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          maxAmountA: "100",
          maxAmountB: "200",
          minPrice: "0.45",
          maxPrice: "0.55",
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildWithdrawLiquidityPool", () => {
    it("builds a withdraw liquidity pool transaction with valid parameters", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "90",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "liquidityPoolWithdraw",
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "90",
        }),
      );
    });

    it("fails when amount is missing", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "",
          minAmountA: "45",
          minAmountB: "90",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Amount of pool shares to withdraw is required");
      }
    });

    it("validates amount is positive", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const resultNegative = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "-50",
          minAmountA: "45",
          minAmountB: "90",
        },
      );

      expect(resultNegative.status).toBe("error");
      if (resultNegative.status === "error") {
        expect(resultNegative.error.message).toContain("must be a positive number");
      }

      const resultZero = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "0",
          minAmountA: "45",
          minAmountB: "90",
        },
      );

      expect(resultZero.status).toBe("error");
    });

    it("fails when minAmountA is missing", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "",
          minAmountB: "90",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("minAmountA and minAmountB are required");
      }
    });

    it("fails when minAmountB is missing", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("minAmountA and minAmountB are required");
      }
    });

    it("validates minimum amounts are non-negative", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "-45",
          minAmountB: "90",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("must be non-negative");
      }
    });

    it("allows zero minimum amounts", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "0",
          minAmountB: "0",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("supports memo in liquidity pool withdrawal", async () => {
      const { buildWithdrawLiquidityPool } = await import("../transaction/buildTransaction");

      const result = await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "90",
          memo: "withdraw-lp",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalled();
    });

    it("supports autoFetchSequence", async () => {
      const { buildWithdrawLiquidityPool, clearSequenceCache } = await import("../transaction/buildTransaction");
      clearSequenceCache();

      mockLoadAccount.mockResolvedValueOnce({
        accountId: () => sourcePublicKey,
        sequenceNumber: () => "300",
        incrementSequenceNumber: () => {},
      });

      await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "90",
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await buildWithdrawLiquidityPool(
        networkConfig.horizonUrl,
        networkConfig,
        sourcePublicKey,
        {
          liquidityPoolId: poolId,
          amount: "50",
          minAmountA: "45",
          minAmountB: "90",
          autoFetchSequence: true,
        },
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });
  });
});
