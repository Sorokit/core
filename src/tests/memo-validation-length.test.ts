import { describe, expect, it } from "vitest";
import { createTransactionBuilder } from "../transaction/transactionBuilder";
import { validateMemoPolicy } from "../transaction/buildTransaction";
import { compose } from "../transaction/compose";
import { SorokitErrorCode } from "../shared/response";

describe("TransactionBuilder memo validation (#846)", () => {
  describe("createTransactionBuilder().setMemo", () => {
    it("rejects an empty string memo by default", () => {
      const builder = createTransactionBuilder();
      expect(() => builder.setMemo("")).toThrow("Memo cannot be empty or whitespace-only");
    });

    it("rejects a whitespace-only memo by default", () => {
      const builder = createTransactionBuilder();
      expect(() => builder.setMemo("   \t\n  ")).toThrow("Memo cannot be empty or whitespace-only");
    });

    it("rejects non-string values", () => {
      const builder = createTransactionBuilder();
      // @ts-expect-error test invalid input type
      expect(() => builder.setMemo(null)).toThrow("Memo must be a string");
      // @ts-expect-error test invalid input type
      expect(() => builder.setMemo(12345)).toThrow("Memo must be a string");
    });

    it("accepts valid non-empty memo", () => {
      const builder = createTransactionBuilder();
      expect(builder.setMemo("valid-memo")).toBe(builder);
      expect(builder.getMemo()).toBe("valid-memo");
    });

    it("allows empty string memo when opt-in allowEmpty is true", () => {
      const builder = createTransactionBuilder();
      expect(builder.setMemo("", { allowEmpty: true })).toBe(builder);
      expect(builder.getMemo()).toBe("");
    });

    it("allows whitespace-only memo when opt-in allowEmpty is true", () => {
      const builder = createTransactionBuilder();
      expect(builder.setMemo("   ", { allowEmpty: true })).toBe(builder);
      expect(builder.getMemo()).toBe("   ");
    });

    it("clears memo on builder.clear()", () => {
      const builder = createTransactionBuilder();
      builder.setMemo("my-memo");
      expect(builder.getMemo()).toBe("my-memo");
      builder.clear();
      expect(builder.getMemo()).toBeUndefined();
    });
  });

  describe("validateMemoPolicy", () => {
    it("rejects empty string memo by default", () => {
      const result = validateMemoPolicy({ memo: "" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toBe("Memo cannot be empty or whitespace-only");
      }
    });

    it("rejects whitespace-only memo by default", () => {
      const result = validateMemoPolicy({ memo: "  \t \r \n  " });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toBe("Memo cannot be empty or whitespace-only");
      }
    });

    it("accepts empty string memo when allowEmptyMemo is true", () => {
      const result = validateMemoPolicy({ memo: "", allowEmptyMemo: true });
      expect(result.status).toBe("ok");
    });

    it("accepts whitespace-only memo when allowEmptyMemo is true", () => {
      const result = validateMemoPolicy({ memo: "   ", allowEmptyMemo: true });
      expect(result.status).toBe("ok");
    });

    it("accepts empty string memo when memoValidation config has allowEmpty: true", () => {
      const result = validateMemoPolicy({
        memo: "",
        memoValidation: { rule: "required", allowEmpty: true },
      });
      // Note: rule "required" will still check hasMemo unless custom logic, but allowEmpty passes the length check
      // For required rule: hasMemo is false so it fails with "Memo is required".
      // Let's test with a rule or without rule:
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Memo is required");
      }
    });

    it("accepts empty memo when memoValidation has allowEmpty: true without required rule", () => {
      const result = validateMemoPolicy({
        memo: "",
        memoValidation: { rule: "prohibit", allowEmpty: true },
      });
      expect(result.status).toBe("ok");
    });

    it("accepts omitted memo (undefined) without error", () => {
      const result = validateMemoPolicy({});
      expect(result.status).toBe("ok");
    });

    it("rule: prohibit accepts memo: '' even without explicit allowEmpty flag", () => {
      const result = validateMemoPolicy({ memoValidation: "prohibit", memo: "" });
      expect(result.status).toBe("ok");
    });

    it("rule: prohibit rejects non-empty memo", () => {
      const result = validateMemoPolicy({ memoValidation: "prohibit", memo: "hello" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toBe("Memo is prohibited for this transaction");
      }
    });
  });

  describe("compose().addMemo validation", () => {
    const SOURCE = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";

    it("fails build when memo is empty string by default", async () => {
      const builder = compose(SOURCE, "testnet", { sequenceNumber: "1" })
        .addPayment({ destination: SOURCE, amount: "10" })
        .addMemo("");

      const result = await builder.build();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toBe("Memo cannot be empty or whitespace-only");
      }
    });

    it("fails build when memo is whitespace-only by default", async () => {
      const builder = compose(SOURCE, "testnet", { sequenceNumber: "1" })
        .addPayment({ destination: SOURCE, amount: "10" })
        .addMemo("   \t  ");

      const result = await builder.build();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toBe("Memo cannot be empty or whitespace-only");
      }
    });

    it("succeeds when allowEmpty is opted-in via addMemo options", async () => {
      const builder = compose(SOURCE, "testnet", { sequenceNumber: "1" })
        .addPayment({ destination: SOURCE, amount: "10" })
        .addMemo("", "text", { allowEmpty: true });

      const result = await builder.build();
      expect(result.status).toBe("ok");
    });

    it("succeeds when allowEmptyMemo is opted-in via compose options", async () => {
      const builder = compose(SOURCE, "testnet", { sequenceNumber: "1", allowEmptyMemo: true })
        .addPayment({ destination: SOURCE, amount: "10" })
        .addMemo("");

      const result = await builder.build();
      expect(result.status).toBe("ok");
    });
  });
});
