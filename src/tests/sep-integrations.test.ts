import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  quoteDirectPayment,
  sendDirectPayment,
  trackDirectPayment,
  validateReceiver,
} from "../integration/sep31DirectPayment";
import {
  getAssetInfo,
  initiateDeposit,
  initiateWithdraw,
  trackTransaction,
  getTransactions,
} from "../integration/sep6Flow";
import {
  getKycFields,
  submitKycInfo,
  getKycStatus,
  deleteKycInfo,
  uploadKycDocument,
} from "../integration/sep12Kyc";
import {
  getInteractiveAssetInfo,
  initiateInteractiveDeposit,
  initiateInteractiveWithdraw,
  monitorTransaction,
  getInteractiveTransactions,
  openInteractivePopup,
  pollTransactionStatus,
} from "../integration/sep24Flow";
import { SorokitErrorCode } from "../shared/response";

// Mock fetch
global.fetch = vi.fn();

describe("SEP-31 Direct Payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("quoteDirectPayment", () => {
    it("should fetch a quote successfully", async () => {
      const mockResponse = {
        id: "quote-123",
        amountIn: "100.00",
        amountOut: "95.00",
        fee: { total: "5.00", sourceAsset: "USDC" },
        expiresAt: "2024-01-01T00:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await quoteDirectPayment("https://anchor.example.com", {
        sourceAsset: "USDC",
        destinationAsset: "EURC",
        amount: "100",
        receiver: "GABCD...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.id).toBe("quote-123");
        expect(result.data.amountIn).toBe("100.00");
      }
    });

    it("should validate required parameters", async () => {
      const result = await quoteDirectPayment("https://anchor.example.com", {
        sourceAsset: "",
        destinationAsset: "EURC",
        amount: "100",
        receiver: "GABCD...",
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });

    it("should handle network errors", async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

      const result = await quoteDirectPayment("https://anchor.example.com", {
        sourceAsset: "USDC",
        destinationAsset: "EURC",
        amount: "100",
        receiver: "GABCD...",
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.NETWORK_ERROR);
      }
    });
  });

  describe("sendDirectPayment", () => {
    it("should send a direct payment successfully", async () => {
      const mockResponse = {
        id: "payment-123",
        status: "pending",
        amountIn: "100.00",
        amountOut: "95.00",
        fee: "5.00",
        createdAt: "2024-01-01T00:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await sendDirectPayment("https://anchor.example.com", {
        quoteId: "quote-123",
        sender: "GABCD...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.id).toBe("payment-123");
        expect(result.data.status).toBe("pending");
      }
    });

    it("should validate required parameters", async () => {
      const result = await sendDirectPayment("https://anchor.example.com", {
        quoteId: "",
        sender: "GABCD...",
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });
  });

  describe("trackDirectPayment", () => {
    it("should track payment status successfully", async () => {
      const mockResponse = {
        id: "payment-123",
        status: "completed",
        amountIn: "100.00",
        amountOut: "95.00",
        fee: "5.00",
        createdAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T01:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await trackDirectPayment("https://anchor.example.com", "payment-123");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("completed");
      }
    });
  });

  describe("validateReceiver", () => {
    it("should validate receiver successfully", async () => {
      const mockResponse = {
        valid: true,
        account: "GABCD...",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await validateReceiver("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true);
      }
    });
  });
});

describe("SEP-6 Deposit and Withdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAssetInfo", () => {
    it("should fetch asset info successfully", async () => {
      const mockResponse = [
        {
          assetCode: "USDC",
          assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          depositEnabled: true,
          withdrawalEnabled: true,
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getAssetInfo("https://anchor.example.com");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.length).toBe(1);
        expect(result.data[0].assetCode).toBe("USDC");
      }
    });
  });

  describe("initiateDeposit", () => {
    it("should initiate deposit successfully", async () => {
      const mockResponse = {
        url: "https://anchor.example.com/deposit/123",
        id: "deposit-123",
        amountIn: "100.00",
        amountOut: "100.00",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await initiateDeposit("https://anchor.example.com", {
        assetCode: "USDC",
        stellarAccount: "GABCD...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toContain("deposit");
      }
    });
  });

  describe("initiateWithdraw", () => {
    it("should initiate withdrawal successfully", async () => {
      const mockResponse = {
        id: "withdraw-123",
        amountIn: "100.00",
        amountOut: "95.00",
        fee: "5.00",
        dest: "0x123...",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await initiateWithdraw("https://anchor.example.com", {
        assetCode: "USDC",
        stellarAccount: "GABCD...",
        amount: "100",
        dest: "0x123...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.id).toBe("withdraw-123");
      }
    });
  });

  describe("trackTransaction", () => {
    it("should track transaction status successfully", async () => {
      const mockResponse = {
        id: "tx-123",
        status: "completed",
        kind: "deposit",
        amountIn: "100.00",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T01:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await trackTransaction(
        "https://anchor.example.com",
        "tx-123",
        "GABCD...",
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("completed");
      }
    });
  });

  describe("getTransactions", () => {
    it("should get transactions successfully", async () => {
      const mockResponse = {
        transactions: [
          {
            id: "tx-123",
            status: "completed",
            kind: "deposit",
            startedAt: "2024-01-01T00:00:00Z",
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getTransactions("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.length).toBe(1);
      }
    });
  });
});

describe("SEP-12 KYC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getKycFields", () => {
    it("should fetch KYC fields successfully", async () => {
      const mockResponse = {
        fields: [
          {
            name: "email",
            type: "string",
            required: true,
            description: "Customer email address",
          },
        ],
        countries: ["US", "GB"],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getKycFields("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.fields.length).toBe(1);
        expect(result.data.fields[0].name).toBe("email");
      }
    });
  });

  describe("submitKycInfo", () => {
    it("should submit KYC info successfully", async () => {
      const mockResponse = {
        id: "kyc-123",
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await submitKycInfo("https://anchor.example.com", "GABCD...", {
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.id).toBe("kyc-123");
      }
    });
  });

  describe("getKycStatus", () => {
    it("should fetch KYC status successfully", async () => {
      const mockResponse = {
        account: "GABCD...",
        status: "approved",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getKycStatus("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("approved");
      }
    });
  });

  describe("deleteKycInfo", () => {
    it("should delete KYC info successfully", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
      });

      const result = await deleteKycInfo("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.success).toBe(true);
      }
    });
  });

  describe("uploadKycDocument", () => {
    it("should upload KYC document successfully", async () => {
      const mockResponse = {
        id: "doc-123",
        status: "pending",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await uploadKycDocument(
        "https://anchor.example.com",
        "GABCD...",
        "passport",
        "base64data...",
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.id).toBe("doc-123");
      }
    });
  });
});

describe("SEP-24 Interactive Flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInteractiveAssetInfo", () => {
    it("should fetch interactive asset info successfully", async () => {
      const mockResponse = [
        {
          assetCode: "USDC",
          assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          depositEnabled: true,
          withdrawalEnabled: true,
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getInteractiveAssetInfo("https://anchor.example.com");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.length).toBe(1);
      }
    });
  });

  describe("initiateInteractiveDeposit", () => {
    it("should initiate interactive deposit successfully", async () => {
      const mockResponse = {
        url: "https://anchor.example.com/sep24/deposit/123",
        id: "deposit-123",
        amountIn: "100.00",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await initiateInteractiveDeposit("https://anchor.example.com", {
        assetCode: "USDC",
        stellarAccount: "GABCD...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toContain("sep24");
      }
    });
  });

  describe("initiateInteractiveWithdraw", () => {
    it("should initiate interactive withdrawal successfully", async () => {
      const mockResponse = {
        url: "https://anchor.example.com/sep24/withdraw/123",
        id: "withdraw-123",
        amountIn: "100.00",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await initiateInteractiveWithdraw("https://anchor.example.com", {
        assetCode: "USDC",
        stellarAccount: "GABCD...",
        amount: "100",
        dest: "0x123...",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toContain("sep24");
      }
    });
  });

  describe("monitorTransaction", () => {
    it("should monitor transaction status successfully", async () => {
      const mockResponse = {
        id: "tx-123",
        status: "completed",
        kind: "deposit",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T01:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await monitorTransaction(
        "https://anchor.example.com",
        "tx-123",
        "GABCD...",
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("completed");
      }
    });
  });

  describe("getInteractiveTransactions", () => {
    it("should get interactive transactions successfully", async () => {
      const mockResponse = {
        transactions: [
          {
            id: "tx-123",
            status: "completed",
            kind: "deposit",
            startedAt: "2024-01-01T00:00:00Z",
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await getInteractiveTransactions("https://anchor.example.com", "GABCD...");

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.length).toBe(1);
      }
    });
  });

  describe("openInteractivePopup", () => {
    it("should return null in non-browser environment", () => {
      const originalWindow = global.window;
      delete (global as any).window;
      
      const result = openInteractivePopup("https://example.com");
      expect(result).toBeNull();
      
      global.window = originalWindow;
    });
  });

  describe("pollTransactionStatus", () => {
    it("should poll transaction status until completion", async () => {
      const mockResponse = {
        id: "tx-123",
        status: "completed",
        kind: "deposit",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T01:00:00Z",
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await pollTransactionStatus(
        "https://anchor.example.com",
        "tx-123",
        "GABCD...",
        { maxAttempts: 1, intervalMs: 1 },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("completed");
      }
    });

    it("should timeout after max attempts", async () => {
      const mockResponse = {
        id: "tx-123",
        status: "pending",
        kind: "deposit",
        startedAt: "2024-01-01T00:00:00Z",
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await pollTransactionStatus(
        "https://anchor.example.com",
        "tx-123",
        "GABCD...",
        { maxAttempts: 2, intervalMs: 1 },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
      }
    });
  });
});
