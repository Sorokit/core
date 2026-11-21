import { describe, expect, it } from "vitest";
import { estimateResources } from "./resourceCalculator";

describe("estimateResources", () => {
  it("returns deterministic resource and fee estimates", () => {
    const result = estimateResources("CABC", "transfer", ["a", "b"]);
    expect(result.status).toBe("ok");
    expect(result.data?.cpuUnits).toBeGreaterThan(10_000);
    expect(result.data?.estimatedFee).toMatch(/^\d+$/);
  });
});
