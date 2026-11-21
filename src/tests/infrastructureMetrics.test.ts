import { describe, it, expect, beforeEach } from "vitest";
import {
  recordOperationDuration,
  recordError,
  getMetrics,
  resetMetrics,
} from "../infrastructure/metrics";

describe("Infrastructure Operation Metrics (#922)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("tracks operation durations, percentiles, and error rates", () => {
    recordOperationDuration("horizon.getAccount", 45);
    recordOperationDuration("horizon.getAccount", 55);
    recordOperationDuration("horizon.getAccount", 110);
    recordError("horizon.getAccount", new Error("HTTP 503 Service Unavailable"));

    recordOperationDuration("soroban.simulateTransaction", 120);

    const snapshot = getMetrics();
    expect(snapshot.durations).toHaveLength(4);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.totalOperations).toBe(5);
    expect(snapshot.totalErrors).toBe(1);
    expect(snapshot.overallErrorRate).toBeCloseTo(0.2, 5);

    const accountStats = snapshot.operations["horizon.getAccount"];
    expect(accountStats).toBeDefined();
    expect(accountStats!.callCount).toBe(4);
    expect(accountStats!.errorCount).toBe(1);
    expect(accountStats!.errorRate).toBeCloseTo(0.25, 5);
    expect(accountStats!.minDurationMs).toBe(45);
    expect(accountStats!.maxDurationMs).toBe(110);
    expect(accountStats!.avgDurationMs).toBeCloseTo(70, 5);
  });

  it("ignores invalid negative or NaN durations and supports resetMetrics", () => {
    recordOperationDuration("", 50);
    recordOperationDuration("tx.submit", -10);
    recordOperationDuration("tx.submit", NaN);

    expect(getMetrics().durations).toHaveLength(0);

    recordOperationDuration("tx.submit", 85);
    expect(getMetrics().durations).toHaveLength(1);

    resetMetrics();
    expect(getMetrics().durations).toHaveLength(0);
    expect(getMetrics().totalOperations).toBe(0);
  });
});
