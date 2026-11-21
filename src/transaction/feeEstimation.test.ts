import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { DEFAULT_BASE_RATE_STROOPS, estimateFeeByOperationCount } from "./feeEstimation";
import type { EstimatedFee } from "./feeEstimation";
import * as transaction from "./index";
import * as sorokit from "../index";

function expectOk(result: SorokitResult<EstimatedFee>): EstimatedFee {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

function expectError(result: SorokitResult<EstimatedFee>) {
  if (result.status !== "error") throw new Error("expected an error result");
  return result.error;
}

describe("estimateFeeByOperationCount", () => {
  it("defaults to the 100 stroop network base rate", () => {
    expect(DEFAULT_BASE_RATE_STROOPS).toBe(100);

    const fee = expectOk(estimateFeeByOperationCount(1));

    expect(fee).toEqual({ operationCount: 1, baseRate: 100, stroops: "100", xlm: "0.0000100" });
  });

  it.each([
    [1, "100", "0.0000100"],
    [2, "200", "0.0000200"],
    [3, "300", "0.0000300"],
    [10, "1000", "0.0001000"],
    [50, "5000", "0.0005000"],
    [100, "10000", "0.0010000"],
  ])("estimates %i operation(s) at the default rate as %s stroops (%s XLM)", (ops, stroops, xlm) => {
    const fee = expectOk(estimateFeeByOperationCount(ops));

    expect(fee.stroops).toBe(stroops);
    expect(fee.xlm).toBe(xlm);
    expect(fee.operationCount).toBe(ops);
  });

  it("is operationCount × baseRate for a custom base rate", () => {
    const fee = expectOk(estimateFeeByOperationCount(3, 250));

    expect(fee).toEqual({ operationCount: 3, baseRate: 250, stroops: "750", xlm: "0.0000750" });
  });

  it.each([
    [1, 1, "1", "0.0000001"],
    [5, 2_000_000, "10000000", "1.0000000"],
    [100, 12_345_678, "1234567800", "123.4567800"],
  ])("handles %i op(s) at %i stroops exactly", (ops, rate, stroops, xlm) => {
    const fee = expectOk(estimateFeeByOperationCount(ops, rate));

    expect(fee.stroops).toBe(stroops);
    expect(fee.xlm).toBe(xlm);
  });

  it("stays exact for totals above 2^53 (no float rounding)", () => {
    const fee = expectOk(estimateFeeByOperationCount(100, Number.MAX_SAFE_INTEGER));

    expect(fee.stroops).toBe((100n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
    expect(fee.xlm).toMatch(/^\d+\.\d{7}$/);
  });

  it("returns a plain result and never throws", () => {
    expect(() => estimateFeeByOperationCount(Number.NaN)).not.toThrow();
    expect(() => estimateFeeByOperationCount(1, Number.NaN)).not.toThrow();
  });

  describe("invalid operationCount", () => {
    it.each([
      ["zero", 0],
      ["negative", -1],
      ["above the 100 operation limit", 101],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("rejects %s", (_name, ops) => {
      const error = expectError(estimateFeeByOperationCount(ops));

      expect(error.code).toBe(SorokitErrorCode.VALIDATION);
      expect(error.message).toContain("operationCount");
    });

    it("rejects a non-number", () => {
      expect(expectError(estimateFeeByOperationCount("5" as unknown as number)).code).toBe(
        SorokitErrorCode.VALIDATION,
      );
    });
  });

  describe("invalid baseRate", () => {
    it.each([
      ["zero", 0],
      ["negative", -100],
      ["fractional", 99.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ])("rejects %s", (_name, rate) => {
      const error = expectError(estimateFeeByOperationCount(2, rate));

      expect(error.code).toBe(SorokitErrorCode.VALIDATION);
      expect(error.message).toContain("baseRate");
    });
  });

  it("is exported from src/transaction/index.ts and src/index.ts", () => {
    expect(transaction.estimateFeeByOperationCount).toBe(estimateFeeByOperationCount);
    expect(sorokit.estimateFeeByOperationCount).toBe(estimateFeeByOperationCount);
    expect(sorokit.DEFAULT_BASE_RATE_STROOPS).toBe(DEFAULT_BASE_RATE_STROOPS);
  });

  it("does not replace the network-based estimateFee", () => {
    expect(sorokit.estimateFee).not.toBe(estimateFeeByOperationCount);
  });
});
