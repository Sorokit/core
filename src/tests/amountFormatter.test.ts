import { describe, expect, it } from "vitest";
import { formatAmount, DEFAULT_ASSET_DECIMALS } from "../shared/amountFormatter";
import { MAX_STROOPS } from "../shared/amountValidation";

describe("formatAmount", () => {
  it("converts stroops to XLM with 2 decimal places by default", () => {
    const result = formatAmount("1000000000");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100.00");
  });

  it("converts a smaller amount correctly (10 XLM)", () => {
    const result = formatAmount("100000000");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("10.00");
  });

  it("shows the symbol when showSymbol is true", () => {
    const result = formatAmount("1000000000", { showSymbol: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100.00 XLM");
  });

  it("uses the asset's code as the symbol when no explicit symbol is given", () => {
    const result = formatAmount("10000000", {
      showSymbol: true,
      asset: { code: "USDC", issuer: "GISSUER" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1.00 USDC");
  });

  it("an explicit symbol overrides the asset's code", () => {
    const result = formatAmount("10000000", {
      showSymbol: true,
      asset: { code: "USDC", issuer: "GISSUER" },
      symbol: "$",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1.00 $");
  });

  it("formats with en-US grouping for large amounts", () => {
    const result = formatAmount("10000000000000"); // 1,000,000 XLM
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1,000,000.00");
  });

  it("formats with de-DE locale separators (grouping '.', decimal ',')", () => {
    const result = formatAmount("10000000000000", { locale: "de-DE" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1.000.000,00");
  });

  it("formats zero correctly", () => {
    const result = formatAmount("0");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.00");
  });

  it("rejects a negative amount (stroops are never negative)", () => {
    const result = formatAmount("-100");
    expect(result.status).toBe("error");
  });

  it("rejects a non-integer stroop string", () => {
    const result = formatAmount("100.5");
    expect(result.status).toBe("error");
  });

  it("rejects an invalid locale", () => {
    const result = formatAmount("1000000000", { locale: "not-a-locale!!" });
    expect(result.status).toBe("error");
  });

  it("rejects decimals outside the supported range", () => {
    expect(formatAmount("100", { decimals: -1 }).status).toBe("error");
    expect(formatAmount("100", { decimals: 21 }).status).toBe("error");
  });

  it("honors a custom decimals value (e.g. a 6-decimal Soroban token)", () => {
    const result = formatAmount("1500000", { decimals: 6 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1.50");
  });

  it("shows more fraction digits when maximumFractionDigits is raised", () => {
    const result = formatAmount("1234567", { maximumFractionDigits: 7 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.1234567");
  });

  it("rounds when maximumFractionDigits is lower than the full precision", () => {
    // 0.1234567 XLM rounded to 2 decimal places -> 0.12
    const result = formatAmount("1234567", { maximumFractionDigits: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.12");
  });

  it("rounds half-up at the rounding boundary", () => {
    // 0.125 XLM rounded to 2 decimal places -> 0.13 (half-up)
    const result = formatAmount("1250000", { maximumFractionDigits: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.13");
  });

  it("carries a rounding overflow into the whole part", () => {
    // 0.999996 rounded to 2 decimals should carry into "1.00", not "0.100"
    const result = formatAmount("9999960", { maximumFractionDigits: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("1.00");
  });

  it("does not pad below minimumFractionDigits: 0 for a whole number", () => {
    const result = formatAmount("1000000000", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100");
  });

  it("trims trailing zeros down to minimumFractionDigits but no further", () => {
    const result = formatAmount("1500000", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 7,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.15");
  });

  it("handles the maximum representable Stellar amount without precision loss", () => {
    const result = formatAmount(MAX_STROOPS.toString(), { maximumFractionDigits: 7 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // 922337203685.4775807 XLM, exactly - would lose precision through a
      // plain `Number` conversion since it exceeds Number.MAX_SAFE_INTEGER.
      expect(result.data.replace(/,/g, "")).toBe("922337203685.4775807");
    }
  });

  it("formats maximumFractionDigits: 0 with no decimal point at all", () => {
    const result = formatAmount("1000000000", { maximumFractionDigits: 0, minimumFractionDigits: 0 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100");
  });

  it("accepts a bigint input directly", () => {
    const result = formatAmount(1000000000n);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100.00");
  });

  it("DEFAULT_ASSET_DECIMALS matches Stellar's stroop precision", () => {
    expect(DEFAULT_ASSET_DECIMALS).toBe(7);
  });
});
