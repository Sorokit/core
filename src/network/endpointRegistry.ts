/**
 * Custom Endpoint Registry and Load Balancing (#672)
 *
 * Manages custom Horizon/RPC endpoints with weighted load balancing,
 * round-robin rotation, latency tracking, and automatic failover.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EndpointType = "horizon" | "rpc";

export interface Endpoint {
  /** Endpoint URL */
  url: string;
  /** Endpoint type: horizon or rpc */
  type: EndpointType;
  /** Selection weight (higher = more likely to be chosen). Default: 1 */
  weight: number;
  /** Priority order (lower = higher priority). Default: 0 */
  priority: number;
  /** Rolling average latency in milliseconds */
  latencyMs: number;
  /** Consecutive failure count */
  failureCount: number;
  /** Timestamp of last health check */
  lastChecked: number;
  /** Whether the endpoint is considered healthy */
  healthy: boolean;
}

export interface EndpointHealthResult {
  /** Measured latency in milliseconds */
  latencyMs: number;
  /** Whether the endpoint responded successfully */
  healthy: boolean;
  /** HTTP status code if available */
  httpStatus?: number;
}

export interface EndpointRegistryConfig {
  /** Maximum consecutive failures before marking endpoint unhealthy. Default: 3 */
  maxFailures?: number;
  /** Health check timeout in milliseconds. Default: 5000 */
  healthCheckTimeoutMs?: number;
  /** Override fetch implementation for testing */
  fetchFn?: typeof fetch | undefined;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * In-memory endpoint registry with weighted load balancing and health tracking.
 */
export class EndpointRegistry {
  private readonly endpoints: Map<string, Endpoint> = new Map();
  private readonly rotationIndex: Map<EndpointType, number> = new Map();
  private readonly maxFailures: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly fetchFn?: typeof fetch | undefined;

  constructor(config?: EndpointRegistryConfig) {
    this.maxFailures = config?.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.healthCheckTimeoutMs =
      config?.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    this.fetchFn = config?.fetchFn;
  }

  private key(type: EndpointType, url: string): string {
    return `${type}::${url}`;
  }

  /**
   * Register a custom endpoint. If the endpoint already exists, its
   * weight and priority are updated.
   */
  registerEndpoint(
    type: EndpointType,
    url: string,
    weight = 1,
    priority = 0,
  ): SorokitResult<Endpoint> {
    if (!url || typeof url !== "string") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Endpoint URL must be a non-empty string",
      );
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          `Endpoint URL must use http or https protocol: ${url}`,
        );
      }
    } catch {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid endpoint URL: ${url}`,
      );
    }

    if (weight < 0) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Endpoint weight must be non-negative",
      );
    }

    const k = this.key(type, url);
    const existing = this.endpoints.get(k);

    const endpoint: Endpoint = {
      url,
      type,
      weight,
      priority,
      latencyMs: existing?.latencyMs ?? 0,
      failureCount: existing?.failureCount ?? 0,
      lastChecked: existing?.lastChecked ?? 0,
      healthy: existing?.healthy ?? true,
    };

    this.endpoints.set(k, endpoint);
    return ok(endpoint);
  }

  /**
   * Remove a registered endpoint.
   */
  removeEndpoint(
    type: EndpointType,
    url: string,
  ): SorokitResult<void> {
    const k = this.key(type, url);
    if (!this.endpoints.has(k)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Endpoint not found: ${type}/${url}`,
      );
    }
    this.endpoints.delete(k);
    return ok(undefined);
  }

  /**
   * Select the optimal endpoint using weighted scoring.
   *
   * Score = weight × (1 / (1 + latencyMs/1000)) × priorityBoost
   * Only healthy endpoints are considered. Falls back to any endpoint
   * if all are unhealthy.
   */
  getOptimalEndpoint(type: EndpointType): SorokitResult<Endpoint> {
    const candidates = this.getEndpoints(type);
    if (candidates.length === 0) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `No endpoints registered for type: ${type}`,
      );
    }

    const healthy = candidates.filter((e) => e.healthy);
    const pool = healthy.length > 0 ? healthy : candidates;

    // Sort by priority (lower first), then by weighted score (higher first)
    const scored = pool
      .map((ep) => {
        const latencyFactor = 1 / (1 + ep.latencyMs / 1000);
        const score = ep.weight * latencyFactor;
        return { ep, score };
      })
      .sort((a, b) => {
        if (a.ep.priority !== b.ep.priority) return a.ep.priority - b.ep.priority;
        return b.score - a.score;
      });

    const best = scored[0];
    if (!best) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `No endpoints available for type: ${type}`,
      );
    }
    return ok(best.ep);
  }

  /**
   * Round-robin rotation across endpoints of a given type.
   */
  rotateEndpoints(type: EndpointType): SorokitResult<Endpoint> {
    const candidates = this.getEndpoints(type);
    if (candidates.length === 0) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `No endpoints registered for type: ${type}`,
      );
    }

    const healthy = candidates.filter((e) => e.healthy);
    const pool = healthy.length > 0 ? healthy : candidates;

    const currentIndex = this.rotationIndex.get(type) ?? 0;
    const nextIndex = currentIndex % pool.length;
    this.rotationIndex.set(type, nextIndex + 1);

    const selected = pool[nextIndex];
    if (!selected) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `No endpoints available for type: ${type}`,
      );
    }
    return ok(selected);
  }

  /**
   * Test an endpoint's health by sending a lightweight HTTP request.
   */
  async testEndpoint(url: string): Promise<SorokitResult<EndpointHealthResult>> {
    const fetchFn =
      this.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);

    if (!fetchFn) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        "No fetch implementation available for health check",
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.healthCheckTimeoutMs,
    );

    const start = Date.now();
    try {
      const res = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      // Update all matching endpoints
      for (const ep of this.endpoints.values()) {
        if (ep.url === url) {
          ep.latencyMs = latencyMs;
          ep.lastChecked = Date.now();
          ep.healthy = res.ok;
          if (res.ok) {
            ep.failureCount = 0;
          } else {
            ep.failureCount += 1;
            if (ep.failureCount >= this.maxFailures) {
              ep.healthy = false;
            }
          }
        }
      }

      return ok({ latencyMs, healthy: res.ok, httpStatus: res.status });
    } catch (cause) {
      const latencyMs = Date.now() - start;

      // Mark all matching endpoints as failed
      for (const ep of this.endpoints.values()) {
        if (ep.url === url) {
          ep.failureCount += 1;
          ep.lastChecked = Date.now();
          ep.latencyMs = latencyMs;
          if (ep.failureCount >= this.maxFailures) {
            ep.healthy = false;
          }
        }
      }

      return ok({ latencyMs, healthy: false });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Record a latency measurement for an endpoint.
   */
  recordLatency(type: EndpointType, url: string, latencyMs: number): void {
    const k = this.key(type, url);
    const ep = this.endpoints.get(k);
    if (ep) {
      // Exponential moving average (α = 0.3)
      ep.latencyMs = ep.latencyMs === 0
        ? latencyMs
        : ep.latencyMs * 0.7 + latencyMs * 0.3;
      ep.lastChecked = Date.now();
    }
  }

  /**
   * Record a failure for an endpoint. Marks unhealthy after maxFailures.
   */
  recordFailure(type: EndpointType, url: string): void {
    const k = this.key(type, url);
    const ep = this.endpoints.get(k);
    if (ep) {
      ep.failureCount += 1;
      ep.lastChecked = Date.now();
      if (ep.failureCount >= this.maxFailures) {
        ep.healthy = false;
      }
    }
  }

  /**
   * Record a successful request for an endpoint (resets failure count).
   */
  recordSuccess(type: EndpointType, url: string): void {
    const k = this.key(type, url);
    const ep = this.endpoints.get(k);
    if (ep) {
      ep.failureCount = 0;
      ep.healthy = true;
      ep.lastChecked = Date.now();
    }
  }

  /**
   * List all endpoints, optionally filtered by type.
   */
  getEndpoints(type?: EndpointType): Endpoint[] {
    const all = Array.from(this.endpoints.values());
    if (!type) return all;
    return all.filter((ep) => ep.type === type);
  }

  /**
   * Remove all registered endpoints.
   */
  clear(): void {
    this.endpoints.clear();
    this.rotationIndex.clear();
  }
}

// ─── Standalone factory ───────────────────────────────────────────────────────

/**
 * Create a new EndpointRegistry instance.
 */
export function createEndpointRegistry(
  config?: EndpointRegistryConfig,
): EndpointRegistry {
  return new EndpointRegistry(config);
}
