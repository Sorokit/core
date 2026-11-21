import { describe, it, expect } from "vitest";
import { isSequenceError, mapHorizonError } from "./horizonErrorMapper";
import { SorokitErrorCode } from "./response";

describe("isSequenceError (#836)", () => {
  it("detects tx_bad_seq in the structured Horizon result_codes.transaction field", () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: "tx_bad_seq" },
          },
        },
      },
    };
    expect(isSequenceError(error)).toBe(true);
  });

  it("detects a bad_seq operation-level result code", () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: "tx_failed",
              operations: ["op_success", "op_bad_seq"],
            },
          },
        },
      },
    };
    expect(isSequenceError(error)).toBe(true);
  });

  it("falls back to matching bad_seq in the error message", () => {
    expect(isSequenceError(new Error("Horizon rejected: tx_bad_seq"))).toBe(true);
    expect(isSequenceError("tx_bad_seq")).toBe(true);
  });

  it("returns false for unrelated Horizon failures", () => {
    const error = {
      response: {
        data: {
          extras: { result_codes: { transaction: "tx_insufficient_fee" } },
        },
      },
    };
    expect(isSequenceError(error)).toBe(false);
    expect(isSequenceError(new Error("network timeout"))).toBe(false);
    expect(isSequenceError(undefined)).toBe(false);
  });
});

describe("mapHorizonError — tx_bad_seq", () => {
  it("still maps a tx_bad_seq failure to INVALID_TRANSACTION", () => {
    const error = {
      status: 400,
      message: "Horizon returned tx_bad_seq",
    };
    const mapped = mapHorizonError(error, { resource: "transaction" });
    expect(mapped.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });
});
