/**
 * Health Check Endpoint — Monitor SDK Availability (#1001)
 *
 * Checks connectivity and responsiveness of Horizon endpoints and Soroban RPC servers.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface EndpointHealth {
  url: string;
  status: "up" | "down" | "degraded";
  latencyMs: number;
  statusCode?: number | undefined;
  error?: string | undefined;
  checkedAt: number;
}

export interface HealthStatus {
  healthy: boolean;
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  totalLatencyMs: number;
  endpoints: {
    horizon?: EndpointHealth | undefined;
    sorobanRpc?: EndpointHealth | undefined;
    [key: string]: EndpointHealth | undefined;
  };
}

export interface HealthCheckOptions {
  horizonUrl?: string | undefined;
  sorobanRpcUrl?: string | undefined;
  timeoutMs?: number | undefined;
  customEndpoints?: Record<string, string> | undefined;
  fetchFn?: typeof fetch | undefined;
}

export const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";
export const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

async function checkSingleEndpoint(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  isRpc = false,
): Promise<EndpointHealth> {
  const start = Date.now();
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const options: RequestInit = {
      method: isRpc ? "POST" : "GET",
      signal: controller.signal,
      headers: isRpc ? { "Content-Type": "application/json" } : {},
      ...(isRpc
        ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }
        : {}),
    };

    const response = await fetchFn(url, options);
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    const isOk = response.ok || (isRpc && response.status === 200);
    return {
      url,
      status: isOk ? "up" : "degraded",
      latencyMs,
      statusCode: response.status,
      checkedAt,
    };
  } catch (cause) {
    clearTimeout(timeoutId);
    return {
      url,
      status: "down",
      latencyMs: Date.now() - start,
      error: cause instanceof Error ? cause.message : String(cause),
      checkedAt,
    };
  }
}

/**
 * Perform comprehensive health check for SDK network endpoints.
 */
export async function performHealthCheck(
  options?: HealthCheckOptions,
): Promise<SorokitResult<HealthStatus>> {
  try {
    const horizonUrl = options?.horizonUrl ?? DEFAULT_HORIZON_URL;
    const sorobanRpcUrl = options?.sorobanRpcUrl ?? DEFAULT_SOROBAN_RPC_URL;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const fetchFn = options?.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);

    if (!fetchFn) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "Fetch API is not available in the current runtime environment",
      );
    }

    const startTotal = Date.now();
    const endpointChecks: Record<string, EndpointHealth> = {};

    const [horizonHealth, rpcHealth] = await Promise.all([
      checkSingleEndpoint(horizonUrl, timeoutMs, fetchFn, false),
      checkSingleEndpoint(sorobanRpcUrl, timeoutMs, fetchFn, true),
    ]);

    endpointChecks.horizon = horizonHealth;
    endpointChecks.sorobanRpc = rpcHealth;

    if (options?.customEndpoints) {
      const customKeys = Object.keys(options.customEndpoints);
      const customResults = await Promise.all(
        customKeys.map((k) =>
          checkSingleEndpoint(options.customEndpoints![k]!, timeoutMs, fetchFn),
        ),
      );
      customKeys.forEach((key, idx) => {
        endpointChecks[key] = customResults[idx]!;
      });
    }

    const allEndpoints = Object.values(endpointChecks);
    const hasDown = allEndpoints.some((e) => e.status === "down");
    const hasDegraded = allEndpoints.some((e) => e.status === "degraded");

    let overallStatus: HealthStatus["status"] = "healthy";
    if (hasDown) {
      overallStatus = allEndpoints.every((e) => e.status === "down") ? "unhealthy" : "degraded";
    } else if (hasDegraded) {
      overallStatus = "degraded";
    }

    const healthStatus: HealthStatus = {
      healthy: overallStatus === "healthy",
      status: overallStatus,
      timestamp: Date.now(),
      totalLatencyMs: Date.now() - startTotal,
      endpoints: endpointChecks,
    };

    return ok(healthStatus);
  } catch (cause) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      cause instanceof Error ? cause.message : "Health check execution failed",
      cause,
    );
  }
}
