import { describe, it, expect, vi } from "vitest";
import {
  formatAddress,
  isBrowser,
  isValidPublicKey,
  isValidContractId,
  toMessage,
  isNotFoundError,
  isUserRejection,
  isTransientError,
  applyErrorHandler,
  withErrorHandling,
  retryWithBackoff,
  type RetryConfig,
  type ErrorHandler,
  type ErrorContext,
  err,
  ok,
  SorokitErrorCode,
} from "../shared";

describe("shared/utils", () => {
  describe("formatAddress", () => {
    const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    it("shortens a full public key", () => {
      const formatted = formatAddress(key);
      expect(formatted).toContain("...");
      expect(formatted.length).toBeLessThan(key.length);
    });

    it("returns the key unchanged if already short", () => {
      expect(formatAddress("GABCD")).toBe("GABCD");
    });

    it("respects custom char count", () => {
      const formatted = formatAddress(key, 6);
      const [prefix, suffix] = formatted.split("...");
      expect(prefix?.length).toBe(7);
      expect(suffix?.length).toBe(6);
    });
  });

  describe("isBrowser", () => {
    it("returns false in Node environment", () => {
      expect(isBrowser()).toBe(false);
    });
  });

  describe("isValidPublicKey", () => {
    it("accepts a valid 56-char Stellar public key", () => {
      expect(
        isValidPublicKey(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("rejects a key not starting with G", () => {
      expect(
        isValidPublicKey(
          "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    it("rejects a key that is too short", () => {
      expect(isValidPublicKey("GABCD")).toBe(false);
    });
  });

  describe("isValidContractId", () => {
    it("accepts a valid 56-char contract ID", () => {
      expect(
        isValidContractId(
          "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("rejects an ID not starting with C", () => {
      expect(
        isValidContractId(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });
  });
});

describe("shared/errors", () => {
  describe("toMessage", () => {
    it("extracts message from Error", () => {
      expect(toMessage(new Error("boom"))).toBe("boom");
    });

    it("returns string as-is", () => {
      expect(toMessage("raw string")).toBe("raw string");
    });

    it("stringifies objects", () => {
      expect(toMessage({ code: 42 })).toBe('{"code":42}');
    });
  });

  describe("isNotFoundError", () => {
    it("detects 404 in error message", () => {
      expect(isNotFoundError(new Error("Request failed with status 404"))).toBe(
        true,
      );
    });

    it('detects "not found" in error message', () => {
      expect(isNotFoundError(new Error("account not found"))).toBe(true);
    });

    it("returns false for non-404 errors", () => {
      expect(isNotFoundError(new Error("network timeout"))).toBe(false);
    });

    it("detects 404 via response.status object", () => {
      expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    });
  });

  describe("isUserRejection", () => {
    it('detects "reject"', () => {
      expect(isUserRejection(new Error("User rejected the request"))).toBe(
        true,
      );
    });

    it('detects "cancel"', () => {
      expect(isUserRejection(new Error("Transaction cancelled"))).toBe(true);
    });

    it('detects "denied"', () => {
      expect(isUserRejection(new Error("Access denied"))).toBe(true);
    });

    it("returns false for non-rejection errors", () => {
      expect(isUserRejection(new Error("Network error"))).toBe(false);
    });
  });

  describe("isTransientError", () => {
    it("detects timeout errors", () => {
      expect(isTransientError(new Error("Request timeout"))).toBe(true);
    });

    it("detects network errors", () => {
      expect(isTransientError(new Error("Network error"))).toBe(true);
    });

    it("detects ECONNRESET", () => {
      expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    });

    it("detects 5xx server errors via response.status", () => {
      expect(isTransientError({ response: { status: 500 } })).toBe(true);
      expect(isTransientError({ response: { status: 503 } })).toBe(true);
    });

    it("returns false for 4xx errors", () => {
      expect(isTransientError({ response: { status: 404 } })).toBe(false);
      expect(isTransientError({ response: { status: 400 } })).toBe(false);
    });

    it("returns false for permanent errors", () => {
      expect(isTransientError(new Error("Invalid parameters"))).toBe(false);
    });
  });

  describe("error handler", () => {
    it("applies fallback value when handler returns fallback action", () => {
      const errorHandler: ErrorHandler = {
        handle: () => ({ type: "fallback", fallbackValue: "fallback" }),
      };
      const context: ErrorContext = { functionName: "test" };
      const errorResult = err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");

      const result = applyErrorHandler(errorResult, errorHandler, context);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("fallback");
      }
    });

    it("throws when handler returns rethrow action", () => {
      const errorHandler: ErrorHandler = {
        handle: () => ({ type: "rethrow" }),
      };
      const context: ErrorContext = { functionName: "test" };
      const errorResult = err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");

      expect(() => applyErrorHandler(errorResult, errorHandler, context)).toThrow(
        "Test error",
      );
    });

    it("returns error when handler returns retry action", () => {
      const errorHandler: ErrorHandler = {
        handle: () => ({ type: "retry" }),
      };
      const context: ErrorContext = { functionName: "test" };
      const errorResult = err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");

      const result = applyErrorHandler(errorResult, errorHandler, context);

      expect(result.status).toBe("error");
    });

    it("returns error when handler returns undefined", () => {
      const errorHandler: ErrorHandler = {
        handle: () => undefined,
      };
      const context: ErrorContext = { functionName: "test" };
      const errorResult = err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");

      const result = applyErrorHandler(errorResult, errorHandler, context);

      expect(result.status).toBe("error");
    });

    it("returns success result unchanged when no error", () => {
      const errorHandler: ErrorHandler = {
        handle: vi.fn(),
      };
      const context: ErrorContext = { functionName: "test" };
      const successResult = ok("success");

      const result = applyErrorHandler(successResult, errorHandler, context);

      expect(result.status).toBe("ok");
      expect(errorHandler.handle).not.toHaveBeenCalled();
    });

    it("returns error unchanged when no handler provided", () => {
      const context: ErrorContext = { functionName: "test" };
      const errorResult = err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");

      const result = applyErrorHandler(errorResult, undefined, context);

      expect(result.status).toBe("error");
    });

    it("withErrorHandling wraps async function with error handling", async () => {
      const errorHandler: ErrorHandler = {
        handle: () => ({ type: "fallback", fallbackValue: "fallback" }),
      };
      const context: ErrorContext = { functionName: "test" };

      const fn = async () => err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");
      const result = await withErrorHandling(errorHandler, context, fn);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("fallback");
      }
    });

    it("withErrorHandling passes context to handler", async () => {
      const errorHandler: ErrorHandler = {
        handle: vi.fn(),
      };
      const context: ErrorContext = { functionName: "test", params: { key: "value" } };

      const fn = async () => err(SorokitErrorCode.TX_BUILD_FAILED, "Test error");
      await withErrorHandling(errorHandler, context, fn);

      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ code: SorokitErrorCode.TX_BUILD_FAILED }),
        context,
      );
    });
  });
});

describe("retryWithBackoff", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await retryWithBackoff(fn);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Request timeout"))
      .mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Request timeout"));

    await expect(
      retryWithBackoff(fn, { maxAttempts: 2, initialDelayMs: 10 }),
    ).rejects.toThrow("Request timeout");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("404 Not Found"));

    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toThrow("404 Not Found");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404 errors", async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 404 } });

    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toEqual({ response: { status: 404 } });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses default config when not provided", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await retryWithBackoff(fn);

    expect(result).toBe("success");
  });

  it("applies exponential backoff delay", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("success");

    const startTime = Date.now();
    await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 50, jitter: false });
    const elapsed = Date.now() - startTime;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});
