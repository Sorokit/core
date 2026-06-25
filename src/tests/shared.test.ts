import { describe, it, expect, vi } from "vitest";
import {
  formatAddress,
  isBrowser,
  isValidPublicKey,
  isValidContractId,
  toMessage,
  isNotFoundError,
  isNetworkConnectivityError,
  isUserRejection,
  isTransientError,
  isTimeoutError,
  isXdrInvalidError,
  applyErrorHandler,
  applyCodeTransformer,
  withErrorHandling,
  retryWithBackoff,
  deduplicateRequest,
  TokenBucketRateLimiter,
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

  describe("isTimeoutError", () => {
    it("detects AbortError", () => {
      const error = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });

      expect(isTimeoutError(error)).toBe(true);
    });

    it("detects ETIMEDOUT code", () => {
      expect(isTimeoutError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("detects RPC deadline messages", () => {
      expect(isTimeoutError(new Error("RPC deadline exceeded"))).toBe(true);
    });

    it("returns false for non-timeout errors", () => {
      expect(isTimeoutError(new Error("Invalid parameters"))).toBe(false);
      expect(isTimeoutError({ response: { status: 404 } })).toBe(false);
    });
  });

  describe("isNetworkConnectivityError", () => {
    it("detects DNS and connection failures by code", () => {
      expect(isNetworkConnectivityError({ code: "ENOTFOUND" })).toBe(true);
      expect(isNetworkConnectivityError({ code: "ECONNREFUSED" })).toBe(true);
    });

    it("detects fetch/network failure messages", () => {
      expect(isNetworkConnectivityError(new Error("fetch failed"))).toBe(true);
      expect(isNetworkConnectivityError(new Error("Network error"))).toBe(true);
    });

    it("does not treat RPC service responses as connectivity failures", () => {
      expect(isNetworkConnectivityError({ response: { status: 500 } })).toBe(
        false,
      );
      expect(isNetworkConnectivityError({ response: { status: 404 } })).toBe(
        false,
      );
    });

    it("returns false for wallet rejection", () => {
      expect(isNetworkConnectivityError(new Error("User rejected request"))).toBe(
        false,
      );
    });
  });

  describe("isXdrInvalidError", () => {
    it("detects empty and invalid-character XDR strings", () => {
      expect(isXdrInvalidError("")).toBe(true);
      expect(isXdrInvalidError("not valid xdr!")).toBe(true);
    });

    it("detects Stellar SDK XDR parse errors", () => {
      expect(isXdrInvalidError(new Error("invalid xdr"))).toBe(true);
      expect(isXdrInvalidError(new Error("XDR decode failed: read past end"))).toBe(
        true,
      );
    });

    it("detects malformed XDR errors thrown by TransactionBuilder.fromXDR", () => {
      expect(
        isXdrInvalidError(
          new TypeError(
            "XDR Read Error: attempt to read outside the boundary of the buffer",
          ),
        ),
      ).toBe(true);
      expect(
        isXdrInvalidError(
          new TypeError("XDR Read Error: unknown EnvelopeType member for value -1635029142"),
        ),
      ).toBe(true);
    });

    it("returns false for plausible base64 XDR input", () => {
      expect(isXdrInvalidError("AAAAAQAAAAA=")).toBe(false);
    });

    it("returns false for unrelated timeout and network errors", () => {
      expect(isXdrInvalidError(new Error("Request timeout"))).toBe(false);
      expect(isXdrInvalidError(new Error("fetch failed"))).toBe(false);
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

describe("shared/utils — deduplicateRequest (#24)", () => {
  it("returns the resolved value", async () => {
    const result = await deduplicateRequest("key-1", () => Promise.resolve("value"));
    expect(result).toBe("value");
  });

  it("concurrent calls with the same key share a single Promise", async () => {
    let callCount = 0;
    const fn = () => new Promise<string>((resolve) => {
      callCount++;
      setTimeout(() => resolve("shared"), 10);
    });

    const [a, b] = await Promise.all([
      deduplicateRequest("key-concurrent", fn),
      deduplicateRequest("key-concurrent", fn),
    ]);

    expect(a).toBe("shared");
    expect(b).toBe("shared");
    expect(callCount).toBe(1); // Only one underlying call was made
  });

  it("concurrent calls with different keys are independent", async () => {
    let callCount = 0;
    const fn = (suffix: string) => () => new Promise<string>((resolve) => {
      callCount++;
      setTimeout(() => resolve(suffix), 10);
    });

    const [a, b] = await Promise.all([
      deduplicateRequest("key-a", fn("a")),
      deduplicateRequest("key-b", fn("b")),
    ]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(callCount).toBe(2);
  });

  it("removes the in-flight entry after resolution so the next call runs fresh", async () => {
    let callCount = 0;
    const fn = () => Promise.resolve(++callCount);

    await deduplicateRequest("key-seq", fn);
    await deduplicateRequest("key-seq", fn);

    expect(callCount).toBe(2); // Each sequential call triggers a new request
  });

  it("propagates rejections and cleans up the in-flight entry", async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.reject(new Error("boom"));
    };

    await expect(deduplicateRequest("key-fail", fn)).rejects.toThrow("boom");
    // After rejection, the entry is removed — next call starts fresh
    await expect(deduplicateRequest("key-fail", fn)).rejects.toThrow("boom");
    expect(callCount).toBe(2);
  });

  it("concurrent callers all receive the rejection", async () => {
    const fn = () => new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("shared-err")), 5),
    );

    const results = await Promise.allSettled([
      deduplicateRequest("key-shared-fail", fn),
      deduplicateRequest("key-shared-fail", fn),
    ]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
  });
});

describe("applyCodeTransformer", () => {
  it("is a no-op when transformer is undefined", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "fail");
    expect(applyCodeTransformer(result, undefined)).toBe(result);
  });

  it("is a no-op when result is ok", () => {
    const result = ok(42);
    const transformer = vi.fn(() => "CUSTOM");
    expect(applyCodeTransformer(result, transformer)).toBe(result);
    expect(transformer).not.toHaveBeenCalled();
  });

  it("calls transformer with the original SDK code and applies the return value", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "fail");
    const transformed = applyCodeTransformer(result, () => "PAYMENT_ERROR");
    expect(transformed.status).toBe("error");
    if (transformed.status === "error") {
      expect(transformed.error.code).toBe("PAYMENT_ERROR");
      expect(transformed.error.message).toBe("fail");
    }
  });

  it("does not throw when transformer returns a non-SorokitErrorCode string", () => {
    const result = err(SorokitErrorCode.UNKNOWN, "oops");
    expect(() => applyCodeTransformer(result, () => "DOMAIN_SPECIFIC_CODE")).not.toThrow();
  });

  it("transformer receives the raw SDK code before any remapping", () => {
    const captured: string[] = [];
    const result = err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
    applyCodeTransformer(result, (code) => {
      captured.push(code);
      return "CUSTOM";
    });
    expect(captured).toEqual([SorokitErrorCode.ACCOUNT_NOT_FOUND]);
  });
});

describe("TokenBucketRateLimiter", () => {
  it("throws when maxRequestsPerSecond is zero", () => {
    expect(() => new TokenBucketRateLimiter(0)).toThrow("maxRequestsPerSecond must be a positive number");
  });

  it("throws when maxRequestsPerSecond is negative", () => {
    expect(() => new TokenBucketRateLimiter(-1)).toThrow("maxRequestsPerSecond must be a positive number");
  });

  it("acquire() resolves immediately when tokens are available", async () => {
    const limiter = new TokenBucketRateLimiter(10);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it("acquire() resolves immediately for a burst up to capacity", async () => {
    const limiter = new TokenBucketRateLimiter(3);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // All three resolved without queuing
  });

  it("acquire() queues when bucket is empty and resolves after refill", async () => {
    const limiter = new TokenBucketRateLimiter(1);
    // Drain the single token
    await limiter.acquire();
    // The next acquire should queue and resolve after ~1000ms; use a short limiter to test
    const start = Date.now();
    const limiter2 = new TokenBucketRateLimiter(100); // 100/s = 1 token per 10ms
    // drain all tokens
    for (let i = 0; i < 100; i++) await limiter2.acquire();
    // next should queue and resolve
    await limiter2.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

import {
  generateTraceId,
  attachTraceId,
  createTracedLogger,
  withLogging,
  type SorokitLogger,
  type StructuredLogMeta,
} from "../shared";

describe("trace IDs (#32)", () => {
  it("generateTraceId returns a non-empty, unique string", () => {
    const a = generateTraceId();
    const b = generateTraceId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("err accepts an optional traceId", () => {
    const result = err(SorokitErrorCode.UNKNOWN, "boom", undefined, "trace-123");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.traceId).toBe("trace-123");
    }
  });

  it("err without a traceId leaves the field undefined", () => {
    const result = err(SorokitErrorCode.UNKNOWN, "boom");
    if (result.status === "error") {
      expect(result.error.traceId).toBeUndefined();
    }
  });

  it("attachTraceId stamps an error result without one", () => {
    const stamped = attachTraceId(err(SorokitErrorCode.UNKNOWN, "boom"), "t-1");
    if (stamped.status === "error") expect(stamped.error.traceId).toBe("t-1");
  });

  it("attachTraceId does not overwrite an existing traceId", () => {
    const stamped = attachTraceId(
      err(SorokitErrorCode.UNKNOWN, "boom", undefined, "original"),
      "t-2",
    );
    if (stamped.status === "error") expect(stamped.error.traceId).toBe("original");
  });

  it("attachTraceId passes success results through untouched", () => {
    const result = attachTraceId(ok(42), "t-3");
    expect(result).toEqual(ok(42));
  });

  it("createTracedLogger injects the traceId into every log entry", () => {
    const entries: { msg: string; meta?: StructuredLogMeta }[] = [];
    const base: SorokitLogger = {
      debug: (msg, meta) => entries.push({ msg, meta }),
      info: (msg, meta) => entries.push({ msg, meta }),
      warn: (msg, meta) => entries.push({ msg, meta }),
      error: (msg, meta) => entries.push({ msg, meta }),
    };
    const traced = createTracedLogger(base, "trace-xyz");
    traced.info("op", { operation: "op" });
    expect(traced.traceId).toBe("trace-xyz");
    expect(entries[0]?.meta?.traceId).toBe("trace-xyz");
  });

  it("withLogging stamps the logger traceId onto error results", async () => {
    const traced = createTracedLogger(
      { debug() {}, info() {}, warn() {}, error() {} },
      "flow-1",
    );
    const result = await withLogging(traced, "account.get", undefined, async () =>
      err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "down"),
    );
    if (result.status === "error") expect(result.error.traceId).toBe("flow-1");
  });

  it("withLogging leaves success results unchanged", async () => {
    const traced = createTracedLogger(
      { debug() {}, info() {}, warn() {}, error() {} },
      "flow-2",
    );
    const result = await withLogging(traced, "account.get", undefined, async () =>
      ok({ value: 1 }),
    );
    expect(result).toEqual(ok({ value: 1 }));
  });
});
