import { describe, it, expect } from "vitest";
import { createHorizonRateLimiter } from "../network/rateLimiter";
import { SorokitErrorCode } from "../shared/response";

describe("HorizonRateLimiter — connection pooling & adaptive rate limiting (#930)", () => {
  it("enforces maxConcurrency across queued requests", async () => {
    const limiter = createHorizonRateLimiter({ maxConcurrency: 2 });
    let currentInFlight = 0;
    let peakInFlight = 0;

    const createTask = (id: number) =>
      limiter.execute(`https://horizon.stellar.org/accounts/G${id}`, async () => {
        currentInFlight += 1;
        peakInFlight = Math.max(peakInFlight, currentInFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        currentInFlight -= 1;
        return `done-${id}`;
      });

    const results = await Promise.all([
      createTask(1),
      createTask(2),
      createTask(3),
      createTask(4),
      createTask(5),
    ]);

    expect(peakInFlight).toBe(2);
    for (const [idx, res] of results.entries()) {
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data).toBe(`done-${idx + 1}`);
      }
    }
    expect(limiter.getQueueStats().completedCount).toBe(5);
  });

  it("retries with exponential backoff on HTTP 429 and tracks per-endpoint metrics", async () => {
    const sleepDelays: number[] = [];
    let now = 1000;
    const limiter = createHorizonRateLimiter({
      maxConcurrency: 4,
      maxRetries: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 2000,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
        now += ms;
      },
    });

    let calls = 0;
    const endpoint = "https://horizon-testnet.stellar.org/accounts/GABC/transactions?limit=10";

    const result = await limiter.execute(endpoint, async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          status: 429,
          headers: {
            "X-RateLimit-Limit": "3600",
            "X-RateLimit-Remaining": "0",
          },
        };
      }
      return {
        status: 200,
        headers: {
          "X-RateLimit-Limit": "3600",
          "X-RateLimit-Remaining": "3599",
        },
        records: ["tx-1"],
      };
    });

    expect(result.status).toBe("ok");
    expect(calls).toBe(3);
    expect(sleepDelays).toEqual([100, 200]);

    const metrics = limiter.getEndpointMetrics(endpoint);
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.rateLimitedCount).toBe(2);
    expect(metrics.retryCount).toBe(2);
    expect(metrics.remainingQuota).toBe(3599);
    expect(metrics.quotaLimit).toBe(3600);
    expect(metrics.currentBackoffMs).toBe(0);
  });

  it("returns RATE_LIMITED error when 429 persists past maxRetries", async () => {
    const limiter = createHorizonRateLimiter({
      maxRetries: 2,
      baseBackoffMs: 50,
      sleepFn: async () => {},
    });

    const result = await limiter.execute("https://horizon.stellar.org/ledgers", async () => ({
      status: 429,
      headers: { "Retry-After": "1" },
    }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.RATE_LIMITED);
      expect(result.error.message).toContain("HTTP 429");
    }
  });

  it("rejects overflow requests when maxQueueSize is exceeded", async () => {
    let releaseFirst!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const limiter = createHorizonRateLimiter({
      maxConcurrency: 1,
      maxQueueSize: 1,
    });

    const p1 = limiter.execute("https://horizon.stellar.org/op1", async () => {
      await blocker;
      return "first";
    });
    const p2 = limiter.execute("https://horizon.stellar.org/op2", async () => "second");
    const p3 = limiter.execute("https://horizon.stellar.org/op3", async () => "third");

    const r3 = await p3;
    expect(r3.status).toBe("error");
    if (r3.status === "error") {
      expect(r3.error.code).toBe(SorokitErrorCode.RATE_LIMITED);
    }

    releaseFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
  });
});
