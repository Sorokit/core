import { describe, it, expect, expectTypeOf } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  isErrorCode,
  isAccountNotFound,
  isTxFailed,
  isContractError,
  assertOk,
  SorokitErrorCode,
} from "../shared/response";
import type {
  AccountNotFoundErrorCode,
  ContractErrorCode,
  SorokitErrorResult,
  TxFailedErrorCode,
} from "../shared/response";

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

describe("isErrorCode()", () => {
  it("returns true when result is error with the matching code", () => {
    const result = err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(true);
  });

  it("returns false when result is ok", () => {
    const result = ok(42);
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(false);
  });

  it("returns false when result is error with a different code", () => {
    const result = err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "fetch failed");
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(false);
  });
});

describe("assertOk()", () => {
  it("does not throw when result is ok", () => {
    const result = ok({ value: 1 });
    expect(() => assertOk(result)).not.toThrow();
  });

  it("throws when result is error", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "submission failed");
    expect(() => assertOk(result)).toThrow();
  });

  it("thrown message includes the error code and message", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "submission failed");
    expect(() => assertOk(result)).toThrow(
      "[TX_SUBMIT_FAILED] submission failed",
    );
  });
});

describe("error-specific result type guards", () => {
  describe("isAccountNotFound()", () => {
    it("returns true for ACCOUNT_NOT_FOUND", () => {
      const result = err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
      expect(isAccountNotFound(result)).toBe(true);
    });

    it("returns false for ok results and other error codes", () => {
      expect(isAccountNotFound(ok(42))).toBe(false);
      expect(
        isAccountNotFound(err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "fetch failed")),
      ).toBe(false);
      expect(isAccountNotFound(err(SorokitErrorCode.TX_SUBMIT_FAILED, "tx failed"))).toBe(
        false,
      );
    });

    it("narrows to the error branch with ACCOUNT_NOT_FOUND code", () => {
      const result = err<number>(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");

      if (isAccountNotFound(result)) {
        expectTypeOf(result).toEqualTypeOf<SorokitErrorResult<AccountNotFoundErrorCode>>();
        expectTypeOf(result.error.code).toEqualTypeOf<SorokitErrorCode.ACCOUNT_NOT_FOUND>();
        expect(result.data).toBeNull();
      }
    });
  });

  describe("isTxFailed()", () => {
    it.each([
      SorokitErrorCode.TX_BUILD_FAILED,
      SorokitErrorCode.TX_SIMULATE_FAILED,
      SorokitErrorCode.TX_SUBMIT_FAILED,
    ])("returns true for %s", (code) => {
      expect(isTxFailed(err(code, "transaction failed"))).toBe(true);
    });

    it("returns false for ok results and non-transaction error codes", () => {
      expect(isTxFailed(ok(42))).toBe(false);
      expect(isTxFailed(err(SorokitErrorCode.TX_NOT_FOUND, "tx not found"))).toBe(false);
      expect(isTxFailed(err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found"))).toBe(false);
      expect(isTxFailed(err(SorokitErrorCode.CONTRACT_INVOKE_FAILED, "contract"))).toBe(
        false,
      );
    });

    it("narrows to the error branch with transaction failure codes", () => {
      const result = err<string>(SorokitErrorCode.TX_BUILD_FAILED, "build failed");

      if (isTxFailed(result)) {
        expectTypeOf(result).toEqualTypeOf<SorokitErrorResult<TxFailedErrorCode>>();
        expectTypeOf(result.error.code).toEqualTypeOf<TxFailedErrorCode>();
        expect(result.data).toBeNull();
      }
    });
  });

  describe("isContractError()", () => {
    it.each([
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      SorokitErrorCode.CONTRACT_READ_FAILED,
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      SorokitErrorCode.CONTRACT_SIMULATE_FAILED,
    ])("returns true for %s", (code) => {
      expect(isContractError(err(code, "contract failed"))).toBe(true);
    });

    it("returns false for ok results and non-contract error codes", () => {
      expect(isContractError(ok(42))).toBe(false);
      expect(isContractError(err(SorokitErrorCode.TX_SUBMIT_FAILED, "tx failed"))).toBe(
        false,
      );
      expect(isContractError(err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found"))).toBe(
        false,
      );
      expect(isContractError(err(SorokitErrorCode.NETWORK_ERROR, "network"))).toBe(false);
    });

    it("narrows to the error branch with contract error codes", () => {
      const result = err<boolean>(
        SorokitErrorCode.CONTRACT_SIMULATE_FAILED,
        "simulate failed",
      );

      if (isContractError(result)) {
        expectTypeOf(result).toEqualTypeOf<SorokitErrorResult<ContractErrorCode>>();
        expectTypeOf(result.error.code).toEqualTypeOf<ContractErrorCode>();
        expect(result.data).toBeNull();
      }
    });
  });
});

