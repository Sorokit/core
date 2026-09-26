/**
 * Tests for getAccountActivitySummary custom date ranges, richer metrics,
 * and caching (#399).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";

const mockOperationsCall = vi.hoisted(() => vi.fn());

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        operations: vi.fn(() => {
          const builder: any = {
            forAccount: vi.fn(() => builder),
            order: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            call: mockOperationsCall,
          };
          return builder;
        }),
      })),
    },
  };
});

import {
  getAccountActivitySummary,
  clearAccountActivitySummaryCache,
  DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS,
} from "../account/getAccountActivitySummary";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

function paymentOp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "payment",
    created_at: new Date().toISOString(),
    transaction_successful: true,
    transaction_hash: `hash-${Math.random()}`,
    amount: "10",
    asset_type: "native",
    to: "",
    from: "",
    source_account: "",
    ...overrides,
  };
}

describe("getAccountActivitySummary custom ranges (#399)", () => {
  let publicKey: string;
  let counterparty: string;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAccountActivitySummaryCache();
    publicKey = Keypair.random().publicKey();
    counterparty = Keypair.random().publicKey();
  });

  it("rejects an invalid account address", async () => {
    const result = await getAccountActivitySummary(HORIZON_URL, "");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("rejects a custom range with only startDate provided", async () => {
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: "2026-01-01",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
  });

  it("rejects startDate after endDate", async () => {
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: "2026-06-20",
      endDate: "2026-06-01",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      expect(result.error.message).toMatch(/must not be after/i);
    }
  });

  it("rejects an invalid date string", async () => {
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: "not-a-date",
      endDate: "2026-06-01",
    });
    expect(result.status).toBe("error");
  });

  it("preserves predefined periods when no custom range is given", async () => {
    mockOperationsCall.mockResolvedValueOnce({ records: [] });
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "7d");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.period).toBe("7d");
    }
  });

  it("resolves period as 'custom' and returns the requested window boundaries", async () => {
    mockOperationsCall.mockResolvedValueOnce({ records: [] });
    const start = "2026-06-01T00:00:00Z";
    const end = "2026-06-30T23:59:59Z";
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: start,
      endDate: end,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.period).toBe("custom");
      expect(result.data.startDate).toBe(new Date(start).toISOString());
      expect(result.data.endDate).toBe(new Date(end).toISOString());
    }
  });

  it("excludes operations outside the requested custom range on both ends", async () => {
    mockOperationsCall.mockResolvedValueOnce({
      records: [
        paymentOp({ created_at: "2026-05-01T00:00:00Z", to: publicKey, amount: "5" }), // before range
        paymentOp({ created_at: "2026-06-15T00:00:00Z", to: publicKey, amount: "10" }), // in range
        paymentOp({ created_at: "2026-07-15T00:00:00Z", to: publicKey, amount: "20" }), // after range
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: "2026-06-01T00:00:00Z",
      endDate: "2026-06-30T23:59:59Z",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactionCount).toBe(1);
    expect(result.data.totalAmountIn).toBe("10");
  });

  it("computes averageTransactionSize across all payment operations", async () => {
    mockOperationsCall.mockResolvedValueOnce({
      records: [
        paymentOp({ to: publicKey, amount: "10", transaction_hash: "h1" }),
        paymentOp({ from: publicKey, source_account: publicKey, amount: "30", transaction_hash: "h2" }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.averageTransactionSize).toBe("20");
  });

  it("returns '0' averageTransactionSize when there are no payment operations", async () => {
    mockOperationsCall.mockResolvedValueOnce({ records: [] });
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.averageTransactionSize).toBe("0");
  });

  it("identifies top counterparties sorted by activity count", async () => {
    mockOperationsCall.mockResolvedValueOnce({
      records: [
        paymentOp({ to: publicKey, from: counterparty, amount: "5", transaction_hash: "h1" }),
        paymentOp({ to: publicKey, from: counterparty, amount: "5", transaction_hash: "h2" }),
        paymentOp({ from: publicKey, source_account: publicKey, to: "GOTHERCOUNTERPARTY", amount: "1", transaction_hash: "h3" }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.topCounterparties[0]?.publicKey).toBe(counterparty);
    expect(result.data.topCounterparties[0]?.count).toBe(2);
    expect(result.data.topCounterparties[0]?.amountIn).toBe("10");
  });

  it("respects a custom topCounterpartiesLimit", async () => {
    const cp2 = Keypair.random().publicKey();
    mockOperationsCall.mockResolvedValueOnce({
      records: [
        paymentOp({ to: publicKey, from: counterparty, amount: "5", transaction_hash: "h1" }),
        paymentOp({ to: publicKey, from: cp2, amount: "5", transaction_hash: "h2" }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      topCounterpartiesLimit: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.topCounterparties).toHaveLength(1);
  });

  it("caches a trailing period within the TTL even as the clock advances", async () => {
    vi.useFakeTimers();
    try {
      mockOperationsCall.mockResolvedValue({ records: [] });
      await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
      vi.advanceTimersByTime(100);
      await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
      expect(mockOperationsCall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses the cache when skipCache is set", async () => {
    mockOperationsCall.mockResolvedValue({ records: [] });

    await getAccountActivitySummary(HORIZON_URL, publicKey, "24h");
    await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", { skipCache: true });

    expect(mockOperationsCall).toHaveBeenCalledTimes(2);
  });

  it("expires the cache after the configured TTL", async () => {
    vi.useFakeTimers();
    mockOperationsCall.mockResolvedValue({ records: [] });

    await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", { cacheTtlMs: 1000 });
    vi.advanceTimersByTime(1500);
    await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", { cacheTtlMs: 1000 });

    expect(mockOperationsCall).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses the default 1-hour cache TTL constant", () => {
    expect(DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("treats an empty activity window correctly (zeroed metrics, not an error)", async () => {
    mockOperationsCall.mockResolvedValueOnce({ records: [] });
    const result = await getAccountActivitySummary(HORIZON_URL, publicKey, "24h", {
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-02T00:00:00Z",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactionCount).toBe(0);
    expect(result.data.totalAmountIn).toBe("0");
    expect(result.data.totalAmountOut).toBe("0");
    expect(result.data.topAssets).toEqual([]);
    expect(result.data.topCounterparties).toEqual([]);
  });
});
