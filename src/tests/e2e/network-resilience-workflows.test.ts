/**
 * E2E framework: network resilience, failover, and performance-under-load
 * scenarios. All fetch calls are injected fakes, so these run fully offline.
 */
import { describe, expect, it } from "vitest";
import { runNetworkFailoverWorkflow, runPerformanceWorkflow } from "./framework";

const PRIMARY = "https://primary.example.org";
const BACKUP = "https://backup.example.org";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("E2E framework: network resilience workflows", () => {
  it("fails over to a healthy backup when the primary endpoint is down", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(PRIMARY)) throw new Error("connection refused");
      return jsonResponse({ ok: true, endpoint: url });
    }) as typeof fetch;

    const result = await runNetworkFailoverWorkflow({
      endpoints: [PRIMARY, BACKUP],
      fetcher,
    });

    expect(result.ok).toBe(true);
    const requestStep = result.steps.find((s) => s.step === "request-with-failover");
    expect(requestStep?.status).toBe("ok");
  });

  it("reports failure when every endpoint in the pool is unreachable", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await runNetworkFailoverWorkflow({
      endpoints: [PRIMARY, BACKUP],
      fetcher,
    });

    expect(result.ok).toBe(false);
    const requestStep = result.steps.find((s) => s.step === "request-with-failover");
    expect(requestStep?.status).toBe("error");
  });

  it("measures latency under concurrent load and reports success when every request succeeds", async () => {
    const result = await runPerformanceWorkflow({
      concurrency: 5,
      iterations: 4,
      operation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    expect(result.ok).toBe(true);
    expect(result.totalRequests).toBe(20);
    expect(result.failures).toBe(0);
    expect(result.averageMs).toBeGreaterThanOrEqual(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(0);
    expect(result.maxMs).toBeGreaterThanOrEqual(result.p95Ms);
  });

  it("surfaces failures from individual requests under load without aborting other workers", async () => {
    let call = 0;
    const result = await runPerformanceWorkflow({
      concurrency: 1,
      iterations: 5,
      operation: async () => {
        call += 1;
        if (call === 3) throw new Error("flaky endpoint");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.totalRequests).toBe(5);
    expect(result.failures).toBe(1);
  });
});
