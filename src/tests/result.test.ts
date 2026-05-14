import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, SorokitErrorCode } from "../shared/response";

describe("shared/response", () => {
  describe("ok()", () => {
    it("returns status ok with data", () => {
      const result = ok({ value: 42 });
      expect(result.status).toBe("ok");
      expect(result.data).toEqual({ value: 42 });
      expect(result.error).toBeNull();
    });
  });

  describe("err()", () => {
    it("returns status error with error object", () => {
      const result = err(
        SorokitErrorCode.NETWORK_ERROR,
        "Something went wrong",
      );
      expect(result.status).toBe("error");
      expect(result.data).toBeNull();
      expect(result.error.code).toBe(SorokitErrorCode.NETWORK_ERROR);
      expect(result.error.message).toBe("Something went wrong");
    });

    it("includes cause when provided", () => {
      const cause = new Error("original");
      const result = err(SorokitErrorCode.UNKNOWN, "wrapped", cause);
      expect(result.status).toBe("error");
      expect(result.error.cause).toBe(cause);
    });

    it("cause is undefined when not provided", () => {
      const result = err(SorokitErrorCode.UNKNOWN, "no cause");
      expect(result.status).toBe("error");
      expect(result.error.cause).toBeUndefined();
    });

    it("CONTRACT_SIMULATE_FAILED error code exists", () => {
      const result = err(
        SorokitErrorCode.CONTRACT_SIMULATE_FAILED,
        "sim failed",
      );
      expect(result.status).toBe("error");
      expect(result.error.code).toBe("CONTRACT_SIMULATE_FAILED");
    });
  });

  describe("isOk() / isErr() type guards", () => {
    it("isOk() returns true for ok result", () => {
      expect(isOk(ok(42))).toBe(true);
    });

    it("isOk() returns false for err result", () => {
      expect(isOk(err(SorokitErrorCode.UNKNOWN, "x"))).toBe(false);
    });

    it("isErr() returns true for err result", () => {
      expect(isErr(err(SorokitErrorCode.UNKNOWN, "x"))).toBe(true);
    });

    it("isErr() returns false for ok result", () => {
      expect(isErr(ok(42))).toBe(false);
    });
  });
});
