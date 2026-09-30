/**
 * Network resilience and performance workflow runners.
 *
 * Failover reuses the SDK's own EndpointPool/createFailoverFetch (the same
 * primitives the client uses in production) so the test exercises real
 * failover behaviour rather than a re-implementation of it. The fetcher is
 * always injected, so these scenarios run fully offline in CI.
 */

import { EndpointPool, createFailoverFetch } from "../../../network/endpointFailover";
import type { WorkflowResult, WorkflowStepResult } from "./types";

export interface NetworkFailoverWorkflowOptions {
  /** Ordered endpoint pool — first entry is primary, rest are backups. */
  endpoints: string[];
  /** Injectable fetch implementation (tests simulate failures on specific endpoints). */
  fetcher: typeof fetch;
  /** Path/URL passed to the failover fetch; defaults to the primary endpoint. */
  requestUrl?: string;
}

export async function runNetworkFailoverWorkflow(
  options: NetworkFailoverWorkflowOptions,
): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const pool = new EndpointPool(options.endpoints);
  const failoverFetch = createFailoverFetch(pool, options.fetcher);

  const started = Date.now();
  try {
    const response = await failoverFetch(options.requestUrl ?? options.endpoints[0]!);
    steps.push({
      step: "request-with-failover",
      status: response.ok ? "ok" : "error",
      durationMs: Date.now() - started,
      detail: `status=${response.status}`,
    });
  } catch (cause) {
    steps.push({
      step: "request-with-failover",
      status: "error",
      durationMs: Date.now() - started,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const health = pool.getHealth();
  steps.push({
    step: "endpoint-health",
    status: "ok",
    durationMs: 0,
    detail: JSON.stringify(health.map((h) => ({ endpoint: h.endpoint, healthy: h.healthy }))),
  });

  return {
    workflow: "network-failover",
    ok: steps.every((s) => s.status !== "error"),
    steps,
  };
}

export interface PerformanceWorkflowOptions {
  /** Number of concurrent workers issuing requests. */
  concurrency: number;
  /** Requests each worker issues, sequentially. */
  iterations: number;
  operation: () => Promise<unknown>;
}

export interface PerformanceWorkflowResult extends WorkflowResult {
  totalRequests: number;
  failures: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

/** Run `concurrency` workers each issuing `iterations` requests and report latency stats. */
export async function runPerformanceWorkflow(
  options: PerformanceWorkflowOptions,
): Promise<PerformanceWorkflowResult> {
  const durations: number[] = [];
  let failures = 0;

  const runWorker = async (): Promise<void> => {
    for (let i = 0; i < options.iterations; i += 1) {
      const started = Date.now();
      try {
        await options.operation();
      } catch {
        failures += 1;
      }
      durations.push(Date.now() - started);
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => runWorker()));

  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.length;
  const average = total === 0 ? 0 : sorted.reduce((sum, d) => sum + d, 0) / total;
  const p95Index = total === 0 ? 0 : Math.min(total - 1, Math.floor(total * 0.95));
  const p95 = sorted[p95Index] ?? 0;
  const max = sorted[total - 1] ?? 0;

  const step: WorkflowStepResult = {
    step: "load-test",
    status: failures === 0 ? "ok" : "error",
    durationMs: sorted.reduce((sum, d) => sum + d, 0),
    detail: `${failures} failures / ${total} requests`,
  };

  return {
    workflow: "performance-load",
    ok: failures === 0,
    steps: [step],
    totalRequests: total,
    failures,
    averageMs: average,
    p95Ms: p95,
    maxMs: max,
  };
}
