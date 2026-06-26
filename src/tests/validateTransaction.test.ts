import { describe, it, expect, vi } from "vitest";
import { validateTransaction } from "../transaction/validateTransaction";
import type { ValidationRules, TransactionValidationContext } from "../transaction/validateTransaction";
import { SorokitErrorCode } from "../shared/response";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  fromXDR: vi.fn(),
  isValidEd25519PublicKey: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: mocks.fromXDR,
    },
    StrKey: {
      ...actual.StrKey,
      isValidEd25519PublicKey: mocks.isValidEd25519PublicKey,
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const MOCK_XDR = "AAAAAQAAAAA=";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function makePaymentTx(overrides?: {
  fee?: number;
  destination?: string;
  amount?: string;
}): ReturnType<typeof mocks.fromXDR> {
  return {
    fee: overrides?.fee ?? 100,
    networkPassphrase: TESTNET_PASSPHRASE,
    operations: [
      {
        type: "payment",
        destination: overrides?.destination ?? VALID_PUBLIC_KEY,
        amount: overrides?.amount ?? "10",
        asset: { code: "XLM", issuer: null },
      },
    ],
  };
}

function makeCreateAccountTx(overrides?: {
  fee?: number;
  destination?: string;
  startingBalance?: string;
}): ReturnType<typeof mocks.fromXDR> {
  return {
    fee: overrides?.fee ?? 100,
    networkPassphrase: TESTNET_PASSPHRASE,
    operations: [
      {
        type: "createAccount",
        destination: overrides?.destination ?? VALID_PUBLIC_KEY,
        startingBalance: overrides?.startingBalance ?? "2",
      },
    ],
  };
}

function makeTxWithNoOps(fee = 100): ReturnType<typeof mocks.fromXDR> {
  return {
    fee,
    networkPassphrase: TESTNET_PASSPHRASE,
    operations: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateTransaction", () => {
  describe("XDR parsing", () => {
    it("returns error when XDR is invalid", () => {
      mocks.fromXDR.mockImplementation(() => {
        throw new Error("invalid XDR");
      });

      const result = validateTransaction("not-valid-xdr");

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Invalid transaction XDR");
      }
    });

    it("returns ok for a valid XDR", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
    });

    it("handles FeeBumpTransaction by validating the inner transaction", () => {
      const innerTx = makePaymentTx();
      mocks.fromXDR.mockReturnValue({ innerTransaction: innerTx });
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operationCount).toBe(1);
      }
    });
  });

  describe("fee sanity", () => {
    it("flags fee below minimum as error", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 50 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, { minFee: 100 });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        expect(result.data.issues).toHaveLength(1);
        expect(result.data.issues[0]?.field).toBe("fee");
        expect(result.data.issues[0]?.severity).toBe("error");
        expect(result.data.issues[0]?.message).toContain("below the minimum");
      }
    });

    it("flags fee above sanity limit as warning", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 200_000 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, { maxFee: 100_000 });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true); // warnings don't invalidate
        const feeIssue = result.data.issues.find((i) => i.field === "fee");
        expect(feeIssue).toBeDefined();
        expect(feeIssue?.severity).toBe("warning");
      }
    });

    it("accepts fee exactly at minimum", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 100 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, { minFee: 100 });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const feeIssues = result.data.issues.filter((i) => i.field === "fee");
        expect(feeIssues).toHaveLength(0);
      }
    });

    it("uses custom minFee from rules", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 500 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, { minFee: 1000 });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const feeIssue = result.data.issues.find((i) => i.field === "fee");
        expect(feeIssue?.severity).toBe("error");
      }
    });
  });

  describe("receiver validation", () => {
    it("flags invalid destination public key as error", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ destination: "INVALID_KEY" }));
      mocks.isValidEd25519PublicKey.mockReturnValue(false);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const destIssue = result.data.issues.find((i) =>
          i.field.includes("destination"),
        );
        expect(destIssue?.severity).toBe("error");
        expect(destIssue?.message).toContain("Invalid receiver public key");
      }
    });

    it("passes when destination is a valid public key", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ destination: VALID_PUBLIC_KEY }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const destIssues = result.data.issues.filter((i) =>
          i.field.includes("destination"),
        );
        expect(destIssues).toHaveLength(0);
      }
    });
  });

  describe("amount validation", () => {
    it("flags zero amount as error", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "0" }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const amtIssue = result.data.issues.find((i) =>
          i.field.includes("amount"),
        );
        expect(amtIssue?.severity).toBe("error");
        expect(amtIssue?.message).toContain("must be positive");
      }
    });

    it("flags negative amount as error", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "-5" }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const amtIssue = result.data.issues.find((i) =>
          i.field.includes("amount"),
        );
        expect(amtIssue).toBeDefined();
      }
    });

    it("passes with a positive amount", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ amount: "10.5" }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const amtIssues = result.data.issues.filter((i) =>
          i.field.includes("amount"),
        );
        expect(amtIssues).toHaveLength(0);
      }
    });

    it("validates startingBalance for createAccount operations", () => {
      mocks.fromXDR.mockReturnValue(makeCreateAccountTx({ startingBalance: "0" }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const balIssue = result.data.issues.find((i) =>
          i.field.includes("startingBalance"),
        );
        expect(balIssue?.severity).toBe("error");
      }
    });
  });

  describe("network match", () => {
    it("passes for a known network passphrase (testnet)", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, {
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const netIssues = result.data.issues.filter((i) => i.field === "network");
        expect(netIssues).toHaveLength(0);
      }
    });

    it("passes for a known network passphrase (mainnet)", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, {
        networkPassphrase: MAINNET_PASSPHRASE,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const netIssues = result.data.issues.filter((i) => i.field === "network");
        expect(netIssues).toHaveLength(0);
      }
    });

    it("warns for an unrecognized network passphrase", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, {
        networkPassphrase: "Unknown Network ; 2099",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true); // warning only, not an error
        const netIssue = result.data.issues.find((i) => i.field === "network");
        expect(netIssue?.severity).toBe("warning");
        expect(netIssue?.message).toContain("Unrecognized network passphrase");
      }
    });

    it("does not add a network issue when no networkPassphrase is provided", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const netIssues = result.data.issues.filter((i) => i.field === "network");
        expect(netIssues).toHaveLength(0);
      }
    });
  });

  describe("custom validation rules", () => {
    it("runs custom rule and includes its issue", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const customRule = vi.fn().mockReturnValue({
        field: "custom",
        message: "Custom check failed",
        severity: "error" as const,
      });

      const result = validateTransaction(MOCK_XDR, { custom: [customRule] });

      expect(customRule).toHaveBeenCalledOnce();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
        const customIssue = result.data.issues.find((i) => i.field === "custom");
        expect(customIssue?.message).toBe("Custom check failed");
      }
    });

    it("custom rule returning null produces no issue", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const customRule = vi.fn().mockReturnValue(null);

      const result = validateTransaction(MOCK_XDR, { custom: [customRule] });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.issues).toHaveLength(0);
        expect(result.data.valid).toBe(true);
      }
    });

    it("custom rule receives correct context", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 500, destination: VALID_PUBLIC_KEY }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      let capturedContext: TransactionValidationContext | undefined;
      const customRule = vi.fn().mockImplementation((ctx: TransactionValidationContext) => {
        capturedContext = ctx;
        return null;
      });

      validateTransaction(MOCK_XDR, {
        networkPassphrase: TESTNET_PASSPHRASE,
        custom: [customRule],
      });

      expect(capturedContext).toBeDefined();
      expect(capturedContext?.fee).toBe(500);
      expect(capturedContext?.operationCount).toBe(1);
      expect(capturedContext?.networkPassphrase).toBe(TESTNET_PASSPHRASE);
      expect(capturedContext?.operations[0]?.destination).toBe(VALID_PUBLIC_KEY);
    });

    it("runs multiple custom rules", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx());
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const rule1 = vi.fn().mockReturnValue(null);
      const rule2 = vi.fn().mockReturnValue({
        field: "custom2",
        message: "Rule 2 fired",
        severity: "warning" as const,
      });

      const result = validateTransaction(MOCK_XDR, { custom: [rule1, rule2] });

      expect(rule1).toHaveBeenCalledOnce();
      expect(rule2).toHaveBeenCalledOnce();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true); // warning only
        expect(result.data.issues).toHaveLength(1);
        expect(result.data.issues[0]?.field).toBe("custom2");
      }
    });
  });

  describe("validation report shape", () => {
    it("includes operationCount, fee, and networkPassphrase in the report", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 200 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR, {
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operationCount).toBe(1);
        expect(result.data.fee).toBe("200");
        expect(result.data.networkPassphrase).toBe(TESTNET_PASSPHRASE);
      }
    });

    it("valid is false when any error-severity issue exists", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 50 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(false);
      }
    });

    it("valid is true when only warning-severity issues exist", () => {
      mocks.fromXDR.mockReturnValue(makePaymentTx({ fee: 200_000 }));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true);
      }
    });

    it("valid is true when no issues found", () => {
      mocks.fromXDR.mockReturnValue(makeTxWithNoOps(200));
      mocks.isValidEd25519PublicKey.mockReturnValue(true);

      const result = validateTransaction(MOCK_XDR);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.valid).toBe(true);
        expect(result.data.issues).toHaveLength(0);
      }
    });
  });
});
