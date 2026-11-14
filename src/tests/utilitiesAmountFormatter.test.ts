import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import { MAX_STROOPS } from "../shared/amountValidation";
import {
  stroopsToAmount,
  amountToStroops,
  amountToStroopsString,
  STROOPS_DECIMALS,
  MAX_SUPPORTED_DECIMALS,
} from "../utilities";
import {
  stroopsToAmount as rootStroopsToAmount,
  amountToStroops as rootAmountToStroops,
  amountToStroopsString as rootAmountToStroopsString,
} from "../index";
import {
  stroopsToAmount as utilityStroopsToAmount,
  amountToStroops as utilityAmountToStroops,
} from "../utility";

describe("utilities/amountFormatter (#962)", () => {
  describe("public barrel exports", () => {
    it("re-exports identical functions from src/utilities, src/utility, and src/index", () => {
      expect(rootStroopsToAmount).toBe(stroopsToAmount);
      expect(rootAmountToStroops).toBe(amountToStroops);
      expect(rootAmountToStroopsString).toBe(amountToStroopsString);
      expect(utilityStroopsToAmount).toBe(stroopsToAmount);
      expect(utilityAmountToStroops).toBe(amountToStroops);
      expect(STROOPS_DECIMALS).toBe(7);
      expect(MAX_SUPPORTED_DECIMALS).toBe(38);
    });
  });

  describe("stroopsToAmount", () => {
    it("converts standard XLM stroop amounts using 7 default decimals", () => {
      expect(stroopsToAmount(0)).toEqual({ status: "ok", data: "0", error: null });
      expect(stroopsToAmount(10_000_000)).toEqual({ status: "ok", data: "1", error: null });
      expect(stroopsToAmount("15000000")).toEqual({ status: "ok", data: "1.5", error: null });
      expect(stroopsToAmount(123_456_789n)).toEqual({
        status: "ok",
        data: "12.3456789",
        error: null,
      });
    });

    it("handles very small amounts down to 1 stroop and sub-wei custom scales", () => {
      expect(stroopsToAmount(1)).toEqual({
        status: "ok",
        data: "0.0000001",
        error: null,
      });
      expect(stroopsToAmount("10")).toEqual({
        status: "ok",
        data: "0.000001",
        error: null,
      });
      expect(stroopsToAmount(1n, 18)).toEqual({
        status: "ok",
        data: "0.000000000000000001",
        error: null,
      });
    });

    it("handles very large amounts including Stellar MAX_INT64 and u128 Soroban balances without precision loss", () => {
      const stellarMax = stroopsToAmount(MAX_STROOPS);
      expect(stellarMax).toEqual({
        status: "ok",
        data: "922337203685.4775807",
        error: null,
      });

      const stellarMaxFromStr = stroopsToAmount("9223372036854775807");
      expect(stellarMaxFromStr).toEqual({
        status: "ok",
        data: "922337203685.4775807",
        error: null,
      });

      const u128Max = (1n << 128n) - 1n; // 340282366920938463463374607431768211455
      const sorobanLarge = stroopsToAmount(u128Max, 18);
      expect(sorobanLarge).toEqual({
        status: "ok",
        data: "340282366920938463463.374607431768211455",
        error: null,
      });
    });

    it("supports custom decimals passed directly or via options object, plus trimTrailingZeros: false", () => {
      expect(stroopsToAmount("1500000", 6)).toEqual({
        status: "ok",
        data: "1.5",
        error: null,
      });
      expect(stroopsToAmount("1500000", { decimals: 6, trimTrailingZeros: false })).toEqual({
        status: "ok",
        data: "1.500000",
        error: null,
      });
      expect(stroopsToAmount(10_000_000, { trimTrailingZeros: false })).toEqual({
        status: "ok",
        data: "1.0000000",
        error: null,
      });
      expect(stroopsToAmount("42", 0)).toEqual({
        status: "ok",
        data: "42",
        error: null,
      });
      expect(stroopsToAmount("  +00025000000  ")).toEqual({
        status: "ok",
        data: "2.5",
        error: null,
      });
    });

    it("returns structured VALIDATION errors for invalid stroop inputs and unsafe numbers", () => {
      for (const bad of [
        -1,
        -1n,
        "-100",
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "",
        "   ",
        "10.5",
        "1e7",
        "abc",
        null as unknown as string,
      ]) {
        const res = stroopsToAmount(bad);
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        }
      }
    });

    it("rejects invalid custom decimal configurations", () => {
      for (const badDecimals of [-1, 1.5, 39, Number.NaN, Number.POSITIVE_INFINITY]) {
        const res = stroopsToAmount(100, badDecimals);
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        }
      }
    });
  });

  describe("amountToStroops & amountToStroopsString", () => {
    it("converts whole and fractional amounts accurately without IEEE-754 drift", () => {
      expect(amountToStroops("0")).toEqual({ status: "ok", data: 0, error: null });
      expect(amountToStroops(0)).toEqual({ status: "ok", data: 0, error: null });
      expect(amountToStroops("1")).toEqual({
        status: "ok",
        data: 10_000_000,
        error: null,
      });
      // Classic float trap: 19.99 * 1e7 === 199899999.99999997 in IEEE-754
      expect(amountToStroops("19.99")).toEqual({
        status: "ok",
        data: 199_900_000,
        error: null,
      });
      expect(amountToStroops(19.99)).toEqual({
        status: "ok",
        data: 199_900_000,
        error: null,
      });
      expect(amountToStroops(".25")).toEqual({
        status: "ok",
        data: 2_500_000,
        error: null,
      });
      expect(amountToStroops("  +007.1234567 ")).toEqual({
        status: "ok",
        data: 71_234_567,
        error: null,
      });
    });

    it("handles very small amounts and custom decimals", () => {
      expect(amountToStroops("0.0000001")).toEqual({
        status: "ok",
        data: 1,
        error: null,
      });
      expect(amountToStroops("1.5", 6)).toEqual({
        status: "ok",
        data: 1_500_000,
        error: null,
      });
      expect(amountToStroops("42", 0)).toEqual({
        status: "ok",
        data: 42,
        error: null,
      });
      expect(amountToStroops("0.000000001", { decimals: 9 })).toEqual({
        status: "ok",
        data: 1,
        error: null,
      });
    });

    it("enforces Number.MAX_SAFE_INTEGER boundary in amountToStroops while supporting full int64/u128 in amountToStroopsString", () => {
      // Exact Number.MAX_SAFE_INTEGER (9007199254740991 stroops = 900719925.4740991 XLM)
      expect(amountToStroops("900719925.4740991")).toEqual({
        status: "ok",
        data: Number.MAX_SAFE_INTEGER,
        error: null,
      });

      // One stroop above Number.MAX_SAFE_INTEGER is rejected by numeric amountToStroops
      const unsafeRes = amountToStroops("900719925.4740992");
      expect(unsafeRes.status).toBe("error");
      if (unsafeRes.status === "error") {
        expect(unsafeRes.error.code).toBe(SorokitErrorCode.VALIDATION);
      }

      // Stellar MAX_INT64 (922337203685.4775807 XLM) converts losslessly via amountToStroopsString
      expect(amountToStroopsString("922337203685.4775807")).toEqual({
        status: "ok",
        data: MAX_STROOPS.toString(),
        error: null,
      });
    });

    it("preserves exact values across roundtrip conversions", () => {
      const samples: Array<{ amount: string; decimals?: number }> = [
        { amount: "0" },
        { amount: "0.0000001" },
        { amount: "1" },
        { amount: "19.99" },
        { amount: "123456.7890123" },
        { amount: "900719925.4740991" },
        { amount: "0.000001", decimals: 6 },
        { amount: "999999", decimals: 0 },
      ];

      for (const { amount, decimals } of samples) {
        const toStroops = amountToStroops(amount, decimals);
        expect(toStroops.status).toBe("ok");
        if (toStroops.status === "ok") {
          const back = stroopsToAmount(toStroops.data, decimals);
          expect(back).toEqual({ status: "ok", data: amount, error: null });
        }
      }

      // Large roundtrip beyond Number.MAX_SAFE_INTEGER
      const huge = "340282366920938463463.374607431768211455";
      const hugeStroops = amountToStroopsString(huge, 18);
      expect(hugeStroops.status).toBe("ok");
      if (hugeStroops.status === "ok") {
        expect(stroopsToAmount(hugeStroops.data, 18)).toEqual({
          status: "ok",
          data: huge,
          error: null,
        });
      }
    });

    it("rejects negative, malformed, exponent, or over-precise decimal inputs", () => {
      for (const bad of [
        "-1",
        -0.5,
        "",
        "   ",
        ".",
        "1.2.3",
        "1e5",
        1e-8, // JS stringifies 1e-8 as "1e-8"
        "0.00000001", // 8 decimal places > default 7
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null as unknown as string,
      ]) {
        const res = amountToStroops(bad);
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
        }
      }

      expect(amountToStroopsString("-1").status).toBe("error");
      expect(amountToStroopsString("1", -1).status).toBe("error");

      const zeroDecimalFraction = amountToStroops("1.5", 0);
      expect(zeroDecimalFraction.status).toBe("error");
    });
  });
});
