import { describe, expect, it } from "vitest";
import { evaluateBenchmarks } from "./benchmarkHarness";

describe("benchmark baselines", () => {
  it("keeps each benchmark within the documented 10% regression threshold", async () => {
    const report = await evaluateBenchmarks("src/tests/benchmarks/benchmark-report.json");

    for (const result of report.results) {
      expect(result.regressionPct).toBeLessThanOrEqual(10);
    }
  });
});
