import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createInMemoryCache } from "../shared/cache";

const mockCall = vi.fn();
const mockCursor = vi.fn().mockReturnThis();
const mockOperationsBuilder = {
  forAccount: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  cursor: mockCursor,
  call: mockCall,
};

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    operations: () => mockOperationsBuilder,
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

const HORIZON_URL = "https://example.invalid";
const PUBLIC_KEY = Keypair.random().publicKey();
const COUNTERPARTY_A = Keypair.random().publicKey();
const COUNTERPARTY_B = Keypair.random().publicKey();

function paymentOp(opts: {
  createdAt: string;
  successful?: boolean;
  hash: string;
  amount: string;
  to?: string;
  from?: string;
  assetCode?: string;
  assetIssuer?: string;
  pagingToken?: string;
}) {
  return {
    created_at: opts.createdAt,
    transaction_successful: opts.successful ?? true,
    transaction_hash: opts.hash,
    type: "payment",
    amount: opts.amount,
    asset_type: opts.assetCode ? "credit_alphanum4" : "native",
    asset_code: opts.assetCode,
    asset_issuer: opts.assetIssuer,
    to: opts.to,
    from: opts.from,
    source_account: opts.from,
    paging_token: opts.pagingToken,
  };
}

describe("getAccountActivitySummary — custom aggregation windows (#399)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCall.mockResolvedValue({ records: [] });
  });

  it("supports an explicit startDate/endDate range", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    mockCall.mockResolvedValueOnce({
      records: [
        paymentOp({
          createdAt: "2026-08-10T00:00:00.000Z",
          hash: "h1",
          amount: "50",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_A,
        }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-08-31T23:59:59Z",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.period).toBe("custom");
      expect(result.data.range.startDate).toBe("2026-08-01T00:00:00.000Z");
      expect(result.data.range.endDate).toBe("2026-08-31T23:59:59.000Z");
      expect(result.data.totalAmountIn).toBe("50");
    }
  });

  it("preserves existing predefined periods (24h/7d/30d) as a bare string", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, "7d");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.period).toBe("7d");
    }
  });

  it("preserves predefined periods via the options object form", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      period: "30d",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.period).toBe("30d");
    }
  });

  it("validates date ordering: rejects startDate after endDate", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-31T00:00:00Z",
      endDate: "2026-08-01T00:00:00Z",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("must not be after");
    }
  });

  it("rejects an invalid date string", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "not-a-date",
      endDate: "2026-08-31T00:00:00Z",
    });

    expect(result.status).toBe("error");
  });

  it("rejects a range with only one boundary provided", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
    });

    expect(result.status).toBe("error");
  });

  it("returns inbound/outbound totals, transaction count, and average transaction size", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    mockCall.mockResolvedValueOnce({
      records: [
        paymentOp({
          createdAt: "2026-08-10T00:00:00.000Z",
          hash: "h1",
          amount: "50",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_A,
        }),
        paymentOp({
          createdAt: "2026-08-11T00:00:00.000Z",
          hash: "h2",
          amount: "30",
          from: PUBLIC_KEY,
          to: COUNTERPARTY_B,
        }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-08-31T23:59:59Z",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.totalAmountIn).toBe("50");
      expect(result.data.totalAmountOut).toBe("30");
      expect(result.data.transactionCount).toBe(2);
      // average = (50 + 30) / 2 payment ops = 40
      expect(result.data.averageTransactionSize).toBe("40");
    }
  });

  it("identifies configurable top counterparties, most frequent first", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    mockCall.mockResolvedValueOnce({
      records: [
        paymentOp({
          createdAt: "2026-08-10T00:00:00.000Z",
          hash: "h1",
          amount: "10",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_A,
        }),
        paymentOp({
          createdAt: "2026-08-11T00:00:00.000Z",
          hash: "h2",
          amount: "10",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_A,
        }),
        paymentOp({
          createdAt: "2026-08-12T00:00:00.000Z",
          hash: "h3",
          amount: "10",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_B,
        }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-08-31T23:59:59Z",
      topCounterpartyLimit: 1,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.topCounterparties).toHaveLength(1);
      expect(result.data.topCounterparties[0]?.publicKey).toBe(COUNTERPARTY_A);
      expect(result.data.topCounterparties[0]?.count).toBe(2);
    }
  });

  it("handles empty activity periods correctly", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    mockCall.mockResolvedValueOnce({ records: [] });

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-08-31T23:59:59Z",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transactionCount).toBe(0);
      expect(result.data.totalAmountIn).toBe("0");
      expect(result.data.totalAmountOut).toBe("0");
      expect(result.data.averageTransactionSize).toBe("0");
      expect(result.data.topCounterparties).toEqual([]);
      expect(result.data.topAssets).toEqual([]);
    }
  });

  it("excludes operations outside the requested boundaries even when returned by Horizon", async () => {
    const { getAccountActivitySummary } = await import(
      "../account/getAccountActivitySummary"
    );

    mockCall.mockResolvedValueOnce({
      records: [
        // Well before the requested window.
        paymentOp({
          createdAt: "2026-01-01T00:00:00.000Z",
          hash: "old",
          amount: "999",
          to: PUBLIC_KEY,
          from: COUNTERPARTY_A,
        }),
      ],
    });

    const result = await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-08-31T23:59:59Z",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transactionCount).toBe(0);
      expect(result.data.totalAmountIn).toBe("0");
    }
  });

  describe("caching (#399)", () => {
    it("caches completed summaries by account and requested range", async () => {
      const { getAccountActivitySummary } = await import(
        "../account/getAccountActivitySummary"
      );
      const cache = createInMemoryCache();

      mockCall.mockResolvedValue({
        records: [
          paymentOp({
            createdAt: "2026-08-10T00:00:00.000Z",
            hash: "h1",
            amount: "50",
            to: PUBLIC_KEY,
            from: COUNTERPARTY_A,
          }),
        ],
      });

      const range = {
        startDate: "2026-08-01T00:00:00Z",
        endDate: "2026-08-31T23:59:59Z",
        cache,
      };

      await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, range);
      expect(mockCall).toHaveBeenCalledTimes(1);

      await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, range);
      // Second call served from cache: no additional Horizon query.
      expect(mockCall).toHaveBeenCalledTimes(1);
    });

    it("uses a default cache TTL of one hour", async () => {
      const { DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS } = await import(
        "../account/getAccountActivitySummary"
      );
      expect(DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS).toBe(60 * 60 * 1000);
    });

    it("does not mix cached results across different accounts or ranges", async () => {
      const { getAccountActivitySummary } = await import(
        "../account/getAccountActivitySummary"
      );
      const cache = createInMemoryCache();
      const otherAccount = Keypair.random().publicKey();

      mockCall.mockResolvedValue({ records: [] });

      await getAccountActivitySummary(HORIZON_URL, PUBLIC_KEY, {
        startDate: "2026-08-01T00:00:00Z",
        endDate: "2026-08-31T23:59:59Z",
        cache,
      });
      expect(mockCall).toHaveBeenCalledTimes(1);

      await getAccountActivitySummary(HORIZON_URL, otherAccount, {
        startDate: "2026-08-01T00:00:00Z",
        endDate: "2026-08-31T23:59:59Z",
        cache,
      });
      // Different account key -> cache miss -> a second Horizon query.
      expect(mockCall).toHaveBeenCalledTimes(2);
    });
  });
});
