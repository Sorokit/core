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
    mockRecentFeeHistory(["100", "200", "300", "400", "500", "600", 
