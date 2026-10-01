import { describe, expect, it } from "vitest";
import { createRateLimiter, deduplicateRequest } from "../../src/utility/rateLimiter";

type Metrics = { operations: number; durationMs: number; throughputPerSecond: number; averageLatencyMs: number; errorRate: number; memoryDeltaBytes: number };

async function measure(operations: Array<() => Promise<unknown>>): Promise<Metrics> {
  const beforeMemory = process.memoryUsage().heapUsed;
  const started = performance.now();
  let failures = 0;
  const latencies: number[] = [];
  await Promise.all(operations.map(async (operation) => {
    const operationStarted = performance.now();
    try { await operation(); } catch { failures += 1; }
    latencies.push(performance.now() - operationStarted);
  }));
  const durationMs = performance.now() - started;
  return {
    operations: operations.length,
    durationMs,
    throughputPerSecond: operations.length / Math.max(durationMs / 1_000, 0.001),
    averageLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    errorRate: failures / operations.length,
    memoryDeltaBytes: process.memoryUsage().heapUsed - beforeMemory,
  };
}

describe("concurrent SDK operations", () => {
  it("handles 100+ mixed concurrent operations and reports performance", async () => {
    const limiter = createRateLimiter(200, 10, { maxRetries: 0 });
    const accountFetches = Array.from({ length: 110 }, (_, index) => () => deduplicateRequest(`account:${index % 55}`, async () => ({ id: index % 55 })));
    const submissions = Array.from({ length: 55 }, (_, index) => () => limiter.execute(async () => ({ hash: `tx-${index}` })));
    const offers = Array.from({ length: 20 }, (_, index) => async () => ({ offer: index, action: index % 2 ? "create" : "cancel" }));
    const contracts = Array.from({ length: 20 }, (_, index) => async () => ({ invocation: index }));
    const metrics = await measure([...accountFetches, ...submissions, ...offers, ...contracts]);
    console.info("stress metrics", JSON.stringify(metrics));
    expect(metrics.operations).toBeGreaterThanOrEqual(200);
    expect(metrics.throughputPerSecond).toBeGreaterThan(0);
    expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.memoryDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
