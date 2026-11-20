import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import {
  LiquidityPoolWithdrawBuilder,
  createLiquidityPoolWithdrawBuilder,
} from "../transaction/liquidityPoolWithdrawBuilder";

// ─── Hoisted spy refs ─────────────────────────────────────────────────────────

const { mockLoadAccount, mockAddOperation, mockSetTimeout, mockAddMemo } =
  vi.hoisted(() => ({
    mockLoadAccount: vi.fn(),
    mockAddOperation: vi.fn(),
    mockSetTimeout: vi.fn(),
    mockAddMemo: vi.fn(),
  }));

const MOCK_XDR = "AAAAAQAAAAA=";

// ─── Stellar SDK mock ─────────────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    static fromXDR = vi.fn();
    constructor(_sourceAccount: unknown, _options: unknown) {}
    addOperation(...args: any[]) {
      mockAddOperation(...args);
      return this;
    }
    setTimeout(...args: any[]) {
      mockSetTimeout(...args);
      return this;
    }
    addMemo(...args: any[]) {
      mockAddMemo(...args);
      return this;
    }
    build() {
      return { toXDR: () => MOCK_XDR };
    }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCE = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Valid 64-character hex pool ID */
const POOL_ID =
  "a516b3f68c836cfd9cbc86c0a64e5e927893dcb95c66fffdbbf62d68bc1badf1";

const mockAccount = {
  accountId: () => SOURCE,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LiquidityPoolWithdrawBuilder", () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    mockAddOperation.mockReset();
    mockSetTimeout.mockReset();
    mockAddMemo.mockReset();
  });

  // ── Builder creation ────────────────────────────────────────────────────────

  describe("factory function", () => {
    it("creates a new builder instance", () => {
      const builder = createLiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      expect(builder).toBeInstanceOf(LiquidityPoolWithdrawBuilder);
    });
  });

  // ── Fluent interface ────────────────────────────────────────────────────────

  describe("fluent interface", () => {
    it("allows chaining method calls", () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200");

      expect(result).toBe(builder);
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  describe("valid withdrawal", () => {
    it("builds XDR successfully with all required parameters", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledOnce();
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("accepts shares with various decimal places", async () => {
      const testCases = ["1", "100.1", "50.12345", "999.9999999"];

      for (const shares of testCases) {
        mockAddOperation.mockReset();
        mockSetTimeout.mockReset();

        const builder = new LiquidityPoolWithdrawBuilder(
          SOURCE,
          HORIZON_URL,
          NETWORK_PASSPHRASE,
        );

        const result = await builder
          .poolId(POOL_ID)
          .shares(shares)
          .minAmountA("400")
          .minAmountB("200")
          .build();

        expect(result.status).toBe("ok");
      }
    });

    it("accepts min amounts with various decimal places", async () => {
      const testCases = [
        { minA: "1", minB: "1" },
        { minA: "100.5", minB: "50.25" },
        { minA: "999.1234567", minB: "888.7654321" },
      ];

      for (const { minA, minB } of testCases) {
        mockAddOperation.mockReset();
        mockSetTimeout.mockReset();

        const builder = new LiquidityPoolWithdrawBuilder(
          SOURCE,
          HORIZON_URL,
          NETWORK_PASSPHRASE,
        );

        const result = await builder
          .poolId(POOL_ID)
          .shares("100")
          .minAmountA(minA)
          .minAmountB(minB)
          .build();

        expect(result.status).toBe("ok");
      }
    });

    it("attaches memo when provided", async () => {
      const { Memo } = await import("@stellar/stellar-sdk");
      const memo = Memo.text("lp-withdraw");

      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .memo(memo)
        .build();

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });

    it("does not attach memo when not provided", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("ok");
      expect(mockAddMemo).not.toHaveBeenCalled();
    });
  });

  // ── Pool ID validation ──────────────────────────────────────────────────────

  describe("pool ID validation", () => {
    it("returns error when pool ID is not set", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Pool ID");
      }
    });

    it("returns error for empty pool ID", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId("")
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("liquidityPoolId");
      }
    });

    it("returns error for pool ID that is not 64 hex characters", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId("abc123")
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("64-character hex string");
      }
    });

    it("returns error for pool ID with non-hex characters", async () => {
      const badId = "z".repeat(64);
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(badId)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("64-character hex string");
      }
    });
  });

  // ── Shares amount validation ────────────────────────────────────────────────

  describe("shares amount validation", () => {
    it("returns error when shares are not set", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Share amount");
      }
    });

    it("returns error for empty shares", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("required");
      }
    });

    it("returns error for negative shares", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("-100")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("positive number");
      }
    });

    it("returns error for shares exceeding 7 decimal places", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100.12345678")
        .minAmountA("400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("7 decimal places");
      }
    });
  });

  // ── Min amount validation ──────────────────────────────────────────────────

  describe("min amount A validation", () => {
    it("returns error when minAmountA is not set", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Minimum amount A");
      }
    });

    it("returns error for empty minAmountA", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
    });

    it("returns error for negative minAmountA", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("-400")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("positive number");
      }
    });

    it("returns error for minAmountA exceeding 7 decimal places", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400.12345678")
        .minAmountB("200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("7 decimal places");
      }
    });
  });

  describe("min amount B validation", () => {
    it("returns error when minAmountB is not set", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Minimum amount B");
      }
    });

    it("returns error for empty minAmountB", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("")
        .build();

      expect(result.status).toBe("error");
    });

    it("returns error for negative minAmountB", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("-200")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("positive number");
      }
    });

    it("returns error for minAmountB exceeding 7 decimal places", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200.12345678")
        .build();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("7 decimal places");
      }
    });
  });

  // ── Sequence number caching ────────────────────────────────────────────────

  describe("sequence number caching", () => {
    it("uses cached sequence when autoFetchSequence is true", async () => {
      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .autoFetchSequence(true)
        .build();

      expect(mockLoadAccount).toHaveBeenCalled();
    });

    it("allows disabling sequence caching", async () => {
      mockLoadAccount.mockResolvedValue(mockAccount);

      const builder = new LiquidityPoolWithdrawBuilder(
        SOURCE,
        HORIZON_URL,
        NETWORK_PASSPHRASE,
      );

      const result = await builder
        .poolId(POOL_ID)
        .shares("100")
        .minAmountA("400")
        .minAmountB("200")
        .autoFetchSequence(false)
        .build();

      expect(result.status).toBe("ok");
    });
  });
});
