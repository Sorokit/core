import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Hoisted spy refs ─────────────────────────────────────────────────────────

const {
  mockLoadAccount,
  mockAddOperation,
  mockSetTimeout,
  mockAddMemo,
} = vi.hoisted(() => ({
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

// ─── Subject under test ───────────────────────────────────────────────────────

import { buildManageOfferTransaction } from "../transaction/buildTransaction";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const TRADER = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";

const EURC_ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const mockAccount = {
  accountId: () => TRADER,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildManageOfferTransaction (#550)", () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    mockAddOperation.mockReset();
    mockSetTimeout.mockReset();
    mockAddMemo.mockReset();
  });

  // ── Create offer ────────────────────────────────────────────────────────────

  describe("create offer (offerId = 0)", () => {
    it("builds a new sell offer with XLM selling and token buying", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledOnce();
      const op = mockAddOperation.mock.calls[0][0];
      expect(op).toBeDefined();
    });

    it("defaults offerId to '0' when not provided (creates new offer)", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "50",
          price: "2",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("builds a new offer with both non-native assets", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "USDC",
          sellingAssetIssuer: USDC_ISSUER,
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "200",
          price: "0.9",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
    });

    it("accepts a rational price object { n, d }", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "75",
          price: { n: 3, d: 2 },
        },
      );

      expect(result.status).toBe("ok");
    });

    it("accepts an explicit offerId of '0' to create a new offer", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "10",
          price: "1",
          offerId: "0",
        },
      );

      expect(result.status).toBe("ok");
    });
  });

  // ── Update offer ────────────────────────────────────────────────────────────

  describe("update offer (offerId > 0, amount > 0)", () => {
    it("builds an update transaction for an existing offer", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "150",
          price: "1.8",
          offerId: "12345",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledOnce();
    });

    it("returns XDR when updating offer with a rational price", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "50",
          price: { n: 7, d: 4 },
          offerId: "99999",
        },
      );

      expect(result.status).toBe("ok");
    });
  });

  // ── Cancel offer ────────────────────────────────────────────────────────────

  describe("cancel offer (offerId > 0, amount = '0')", () => {
    it("builds a cancel transaction for an existing offer", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "0",
          price: "1",
          offerId: "12345",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledOnce();
    });

    it("returns error when cancelling without an offerId (offerId = 0)", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "0",
          price: "1",
          offerId: "0",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("non-zero offerId");
      }
    });

    it("returns error when cancelling without providing offerId at all", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "0",
          price: "1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("non-zero offerId");
      }
    });
  });

  // ── Asset validation ────────────────────────────────────────────────────────

  describe("asset validation", () => {
    it("returns error when a non-native buying asset is missing its issuer", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          // buyingAssetIssuer intentionally omitted
          amount: "100",
          price: "1.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("issuer is required");
        expect(result.error.message).toContain("EURC");
      }
    });

    it("returns error when a non-native selling asset is missing its issuer", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "USDC",
          // sellingAssetIssuer intentionally omitted
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("issuer is required");
        expect(result.error.message).toContain("USDC");
      }
    });

    it("returns error when selling and buying are the same asset", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "XLM",
          amount: "100",
          price: "1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("must be different");
      }
    });

    it("warns instead of erroring when selling and buying are the same asset and allowSameAsset is true", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "XLM",
          amount: "100",
          price: "1",
          allowSameAsset: true,
        },
      );

      expect(result.status).toBe("ok");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("can never fill");

      warnSpy.mockRestore();
    });

    it("still returns error for same-asset offers when allowSameAsset is false", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "XLM",
          amount: "100",
          price: "1",
          allowSameAsset: false,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("must be different");
      }
    });

    it("returns error when the selling issuer is not in the trusted list", async () => {
      const untrustedIssuer =
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "USDC",
          sellingAssetIssuer: untrustedIssuer,
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1",
        },
        [USDC_ISSUER], // only the official issuer is trusted
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });
  });

  // ── Price validation ────────────────────────────────────────────────────────

  describe("price validation", () => {
    it("returns error for a zero price", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "0",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for a negative price", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "-1.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for a price exceeding 7 decimal places", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.12345678", // 8 decimal places
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("precision");
      }
    });

    it("accepts a price with exactly 7 decimal places", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.1234567", // exactly 7 decimal places
        },
      );

      expect(result.status).toBe("ok");
    });

    it("returns error for a rational price with zero denominator", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: { n: 3, d: 0 },
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for a rational price with non-integer values", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: { n: 1.5, d: 2 },
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("integer");
      }
    });
  });

  // ── Amount validation ───────────────────────────────────────────────────────

  describe("amount validation", () => {
    it("returns error for a negative amount", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "-10",
          price: "1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("non-negative");
      }
    });

    it("returns error for an amount with more than 7 decimal places", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "1.12345678", // 8 decimal places
          price: "1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("precision");
      }
    });

    it("accepts an amount with exactly 7 decimal places", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "0.1234567",
          price: "1",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("accepts zero amount (cancel) with a non-zero offerId", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "0",
          price: "1",
          offerId: "42",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("returns error for a non-numeric amount", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "not-a-number",
          price: "1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });
  });

  // ── offerId validation ──────────────────────────────────────────────────────

  describe("offerId validation", () => {
    it("returns error for a non-integer offerId", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1",
          offerId: "12.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("non-negative integer");
      }
    });

    it("returns error for a negative offerId", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1",
          offerId: "-1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("non-negative integer");
      }
    });
  });

  // ── Memo support ────────────────────────────────────────────────────────────

  describe("memo support", () => {
    it("attaches a text memo when provided", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
          memo: "offer-ref-001",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });

    it("returns error when requireMemo is true but no memo is provided", async () => {
      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
          requireMemo: true,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Memo is required");
      }
    });
  });

  // ── Horizon error handling ──────────────────────────────────────────────────

  describe("Horizon error handling", () => {
    it("returns TX_BUILD_FAILED when Horizon loadAccount throws", async () => {
      mockLoadAccount.mockRejectedValue(new Error("Network unreachable"));

      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("manage offer");
      }
    });

    it("includes connectivity context in error message when Horizon is unreachable", async () => {
      const connError = new Error("ECONNREFUSED");
      (connError as any).code = "ECONNREFUSED";
      mockLoadAccount.mockRejectedValue(connError);

      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("connectivity");
      }
    });

    it("includes timeout context in error message when Horizon times out", async () => {
      const timeoutError = new Error("Request timed out");
      (timeoutError as any).code = "ETIMEDOUT";
      mockLoadAccount.mockRejectedValue(timeoutError);

      const result = await buildManageOfferTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        TRADER,
        {
          sellingAssetCode: "XLM",
          buyingAssetCode: "EURC",
          buyingAssetIssuer: EURC_ISSUER,
          amount: "100",
          price: "1.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("timed out");
      }
    });
  });
});
