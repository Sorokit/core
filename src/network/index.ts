export { resolveNetwork } from "./resolveNetwork";
export type { NetworkOverrides } from "./resolveNetwork";
export type { NetworkType, NetworkConfig } from "./types";
export { NETWORK_DEFAULTS } from "./types";

// Keep getNetwork and setNetwork as thin wrappers for backward compat
// within the codebase — they delegate to resolveNetwork
export { getNetwork } from "./getNetwork";
export { setNetwork } from "./setNetwork";

import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type NetworkHealthStatus = "healthy" | "degraded" | "down";

export interface NetworkEndpointHealth {
  reachable: boolean;
  latencyMs: number | null;
  httpStatus?: number;
  error?: string;
}

export interface NetworkHealthReport {
  status: NetworkHealthStatus;
  horizon: NetworkEndpointHealth;
  rpc: NetworkEndpointHealth;
  issues: string[];
  recommendations: string[];
}

export interface CheckNetworkHealthOptions {
  /** Per-endpoint timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
  /** Override fetch implementation — useful for tests. */
  fetchFn?: typeof fetch;
  /** Latency threshold in ms above which an endpoint is considered slow. Default: 1500. */
  slowLatencyMs?: number;
}

async function pingEndpoint(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<NetworkEndpointHealth> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: "GET", signal: controller.signal });
    const latencyMs = Date.now() - start;
    return {
      reachable: res.ok,
      latencyMs,
      httpStatus: res.status,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (cause) {
    const latencyMs = Date.now() - start;
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      reachable: false,
      latencyMs,
      error: message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Diagnose Horizon + Soroban RPC connectivity and report latency, status,
 * and recommendations. Never throws — always returns a SorokitResult.
 */
export async function checkNetworkHealth(
  horizonUrl: string,
  rpcUrl: string,
  options?: CheckNetworkHealthOptions,
): Promise<SorokitResult<NetworkHealthReport>> {
  const fetchFn =
    options?.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const timeoutMs = options?.timeoutMs ?? 5000;
  const slowLatencyMs = options?.slowLatencyMs ?? 1500;

  if (!fetchFn) {
    return ok({
      status: "down" as NetworkHealthStatus,
      horizon: { reachable: false, latencyMs: null, error: "no fetch implementation" },
      rpc: { reachable: false, latencyMs: null, error: "no fetch implementation" },
      issues: ["No fetch implementation available."],
      recommendations: ["Provide options.fetchFn when running outside a browser."],
    });
  }

  const horizonPingUrl = `${horizonUrl.replace(/\/$/, "")}/ledgers?limit=1`;
  const [horizon, rpc] = await Promise.all([
    pingEndpoint(horizonPingUrl, fetchFn, timeoutMs),
    pingEndpoint(rpcUrl, fetchFn, timeoutMs),
  ]);

  const issues: string[] = [];
  const recommendations: string[] = [];

  if (!horizon.reachable) {
    issues.push(`Horizon endpoint unreachable: ${horizon.error ?? "unknown"}`);
    recommendations.push("Check Horizon URL and internet connectivity.");
  } else if (horizon.latencyMs !== null && horizon.latencyMs > slowLatencyMs) {
    issues.push(`Horizon latency is high (${horizon.latencyMs}ms).`);
    recommendations.push("Consider using a geographically closer Horizon node.");
  }

  if (!rpc.reachable) {
    issues.push(`Soroban RPC unreachable: ${rpc.error ?? "unknown"}`);
    recommendations.push("Check RPC URL and node health.");
  } else if (rpc.latencyMs !== null && rpc.latencyMs > slowLatencyMs) {
    issues.push(`Soroban RPC latency is high (${rpc.latencyMs}ms).`);
    recommendations.push("Consider switching to a faster RPC provider.");
  }

  let status: NetworkHealthStatus;
  if (!horizon.reachable && !rpc.reachable) {
    status = "down";
  } else if (!horizon.reachable || !rpc.reachable || issues.length > 0) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return ok({ status, horizon, rpc, issues, recommendations });
}
