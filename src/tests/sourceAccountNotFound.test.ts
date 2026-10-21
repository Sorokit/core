import { describe, expect, it } from "vitest";
import {
  err,
  SorokitErrorCode,
  sourceAccountNotFoundError,
  SOURCE_ACCOUNT_RECOVERY_SUGGESTIONS,
  defaultRecoveryGuidance,
  classifyError,
  SorokitErrorCategory,
} from "../shared/response";

describe("SourceAccountNotFound & Recovery Guidance (#849)", () => {
  it("defines SOURCE_ACCOUNT_NOT_FOUND code in SorokitErrorCode", () => {
    expect(SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND).toBe("SOURCE_ACCOUNT_NOT_FOUND");
    expect(classifyError(SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND)).toBe(SorokitErrorCategory.INTERNAL);
  });

  it("includes all 4 key recovery suggestions (retry, wait, create account, use fallback)", () => {
    const suggestions = SOURCE_ACCOUNT_RECOVERY_SUGGESTIONS;
    expect(suggestions.length).toBeGreaterThanOrEqual(4);

    const joined = suggestions.join(" ").toLowerCase();
    expect(joined).toContain("retry");
    expect(joined).toContain("wait");
    expect(joined).toContain("create");
    expect(joined).toContain("fallback");
  });

  it("defaultRecoveryGuidance returns recovery suggestions for ACCOUNT_NOT_FOUND and SOURCE_ACCOUNT_NOT_FOUND", () => {
    const guidanceSource = defaultRecoveryGuidance(
      SorokitErrorCategory.INTERNAL,
      SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND,
    );
    expect(guidanceSource.retryable).toBe(true);
    expect(guidanceSource.suggestions).toBeDefined();
    expect(guidanceSource.suggestions?.length).toBeGreaterThanOrEqual(4);

    const guidanceAccount = defaultRecoveryGuidance(
      SorokitErrorCategory.INTERNAL,
      SorokitErrorCode.ACCOUNT_NOT_FOUND,
    );
    expect(guidanceAccount.retryable).toBe(true);
    expect(guidanceAccount.suggestions).toBeDefined();
    expect(guidanceAccount.suggestions?.length).toBeGreaterThanOrEqual(4);
  });

  it("sourceAccountNotFoundError constructs error result with rich context and recovery suggestions", () => {
    const publicKey = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPVUIV255KZG42CA7";
    const result = sourceAccountNotFoundError(publicKey, {
      operation: "buildPaymentTransaction",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND);
      expect(result.error.message).toContain(publicKey);
      expect(result.error.context?.operation).toBe("buildPaymentTransaction");
      expect(result.error.context?.parameters).toEqual({ accountId: publicKey });
      expect(result.error.recovery?.retryable).toBe(true);
      expect(result.error.recovery?.suggestions).toBeDefined();
      expect(result.error.suggestions).toBeDefined();
      expect(result.error.suggestions?.some((s) => s.includes("retry"))).toBe(true);
      expect(result.error.suggestions?.some((s) => s.includes("wait"))).toBe(true);
      expect(result.error.suggestions?.some((s) => s.includes("create"))).toBe(true);
      expect(result.error.suggestions?.some((s) => s.includes("fallback"))).toBe(true);
    }
  });

  it("err helper automatically attaches suggestions for ACCOUNT_NOT_FOUND", () => {
    const result = err(
      SorokitErrorCode.ACCOUNT_NOT_FOUND,
      "Account not found on network",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.recovery?.suggestions).toBeDefined();
      expect(result.error.suggestions).toBeDefined();
    }
  });
});
