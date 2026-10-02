import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  addAmounts,
  divideAmount,
  multiplyAmount,
  stroopsToXlm,
  subtractAmounts,
  xlmToStroops,
} from "../shared/amounts";

describe("amount property tests", () => {
  it("round-trips every representable stroop amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000_000n, max: 10_000_000_000_000n }), (stroops) => {
        expect(xlmToStroops(stroopsToXlm(stroops))).toBe(stroops);
      }),
    );
  });

  it("preserves additive identity and inverse", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }), (stroops) => {
        const amount = stroopsToXlm(stroops);
        expect(addAmounts(amount, "0")).toBe(amount);
        expect(subtractAmounts(amount, amount)).toBe("0");
      }),
    );
  });

  it("multiplies and divides by one without floating point drift", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000n }), (stroops) => {
        const amount = stroopsToXlm(stroops);
        expect(multiplyAmount(amount, "1")).toBe(amount);
        expect(divideAmount(amount, "1")).toBe(amount);
      }),
    );
  });
});
