// src/network/failover.ts

import {
  SorokitResult,
  ok,
  err,
  SorokitErrorCode,
  createSorokitError,
} from '../types/result';

/**
 * Represents a single network endpoint that can be used to talk to Horizon.
 */
export interface FailoverEndpoint {
  /** Human readable identifier (also used as the pool key). */
  id: string;
  /** Base URL of the endpoint, e.g. `https://horizon.stellar.org`. */
  url: string;
  /** Whether this endpoint is the primary endpoint. */
  primary?: boolean;
  /** Optional weight used for round-robin ordering. */
  weight?: number;
}

/**
 * Health status for a single endpoint.
 */
export interface EndpointHealth {
  id: string;
  url: string;
  healthy: boolean;
  /** Number of consecutive failures observed. */
  consecutiveFailures: number;
  /** Timestamp (ms) of the last successful health check / request. */
  lastSuccessAt: number | null;
  /** Timestamp (ms) of the last failure. */
  lastFailureAt: number | null;
  /** Last measured latency in ms (health check or request). */
  latencyMs: number | null;
}

/**
 * Aggregate health snapshot returned by {@link FailoverManager.getHealth}.
 */
export interface FailoverHealth {
  endpoints: EndpointHealth[];
  /** The endpoint currently considered active. */
  activeEndpointId: string | null;
  /** Whether at least one endpoint is healthy. */
  healthy: boolean;
  /** Whether the manager is currently running health checks. */
  running: boolean;
}

/**
 * Options accepted by {@link FailoverManager}.
 */
export interface FailoverManagerOptions {
  /** Endpoints to register. The first `primary: true` endpoint is preferred. */
  endpoints: FailoverEndpoint[];
  /** Interval (ms) between periodic health checks. Defaults to 30_000. */
  healthCheckIntervalMs?: number;
  /** Timeout (ms) for a single health check request. Defaults to 5_000. */
  healthCheckTimeoutMs?: number;
  /** Number of consecutive failures before an endpoint is marked unhealthy. */
  failureThreshold?: number;
  /** Number of consecutive successes before an endpoint is marked healthy again. */
  recoveryThreshold?: number;
  /** Maximum number of endpoints to keep in the connection pool. */
  poolSize?: number;
  /** Custom fetch implementation (useful for testing). */
  fetchImpl?: typeof fetch;
  /** Optional path appended to endpoint URLs for health checks. Defaults to `/`. */
  healthCheckPath?: string;
}

/**
 * Request options accepted by {@link FailoverManager.fetch}.
 */
export interface FailoverFetchOptions extends RequestInit {
  /** Optional explicit endpoint id to use (bypasses failover selection). */
  endpointId?: string;
  /** Number of retry attempts across endpoints. Defaults to number of endpoints. */
  maxAttempts?: number;
}

/**
 * Internal representation of a pooled endpoint.
 */
interface PooledEndpoint {
  endpoint: FailoverEndpoint;
  health: EndpointHealth;
  successes: number;
}

/**
 * Minimal round-robin connection pool used by the failover manager.
 *
 * The pool keeps an ordered list of endpoints and rotates through them on
 * every {@link ConnectionPool.next} call. Unhealthy endpoints are skipped.
 */
export class ConnectionPool {
  private readonly endpoints: PooledEndpoint[] = [];
  private cursor = 0;
  private readonly maxSize: number;

  constructor(maxSize = 16) {
    this.maxSize = maxSize;
  }

  /** Register an endpoint with the pool. */
  add(endpoint: FailoverEndpoint): void {
    if (this.endpoints.length >= this.maxSize) {
      return;
    }
    if (this.endpoints.some((e) => e.endpoint.id === endpoint.id)) {
      return;
    }
    this.endpoints.push({
      endpoint,
      health: {
        id: endpoint.id,
        url: endpoint.url,
        healthy: true,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        latencyMs: null,
      },
      successes: 0,
    });
  }

  /** Remove an endpoint from the pool. */
  remove(id: string): void {
    const idx = this.endpoints.findIndex((e) => e.endpoint.id === id);
    if (idx >= 0) {
      this.endpoints.splice(idx, 1);
      if (this.cursor >= this.endpoints.length) {
        this.cursor = 0;
      }
    }
  }

  /** Get all pooled endpoints. */
  all(): PooledEndpoint[] {
    return this.endpoints.slice();
  }

  /** Get a pooled endpoint by id. */
  get(id: string): PooledEndpoint | undefined {
    return this.endpoints.find((e) => e.endpoint.id === id);
  }

  /** Whether the pool has any healthy endpoints. */
  hasHealthy(): boolean {
    return this.endpoints.some((e) => e.health.healthy);
  }

  /**
   * Return the next healthy endpoint using round-robin ordering.
   * Returns `null` if no healthy endpoint is available.
   */
  next(): PooledEndpoint | null {
    if (this.endpoints.length === 0) {
      return null;
    }
    const total = this.endpoints.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      const candidate = this.endpoints[idx];
      if (candidate.health.healthy) {
        this.cursor = (idx + 1) % total;
        return candidate;
      }
    }
    return null;
  }

  /** Mark an endpoint as healthy or unhealthy. */
  setHealthy(id: string, healthy: boolean): void {
    const entry = this.get(id);
    if (entry) {
      entry.health.healthy = healthy;
    }
  }

  /** Record a successful request against an endpoint. */
  recordSuccess(id: string, latencyMs: number): void {
    const entry = this.get(id);
    if (!entry) {
      return;
    }
    entry.successes += 1;
    entry.health.consecutiveFailures = 0;
    entry.health.lastSuccessAt = Date.now();
    entry.health.latencyMs = latencyMs;
  }

  /** Record a failed request against an endpoint. */
  recordFailure(id: string): void {
    const entry = this.get(id);
    if (!entry) {
      return;
    }
    entry.successes = 0;
    entry.health.consecutiveFailures += 1;
    entry.health.lastFailureAt = Date.now();
  }
}

/**
 * Registry that tracks endpoint health and decides when an endpoint should be
 * marked healthy or unhealthy based on configurable thresholds.
 */
export class EndpointRegistry {
  private readonly failureThreshold: number;
  private readonly recoveryThreshold: number;
  private readonly recoveryCounters = new Map<string, number>();

  constructor(failureThreshold = 1, recoveryThreshold = 1) {
    this.failureThreshold = Math.max(1, failureThreshold);
    this.recoveryThreshold = Math.max(1, recoveryThreshold);
  }

  /** Record a failure and return whether the endpoint should be marked unhealthy. */
  onFailure(entry: PooledEndpoint): boolean {
    this.recoveryCounters.set(entry.endpoint.id, 0);
    return entry.health.consecutiveFailures >= this.failureThreshold;
  }

  /** Record a success and return whether the endpoint should be marked healthy. */
  onSuccess(entry: PooledEndpoint): boolean {
    const current = (this.recoveryCounters.get(entry.endpoint.id) ?? 0) + 1;
    this.recoveryCounters.set(entry.endpoint.id, current);
    return current >= this.recoveryThreshold;
  }

  /** Reset recovery tracking for an endpoint. */
  reset(id: string): void {
    this.recoveryCounters.delete(id);
  }
}

/**
 * HTTP status codes that should trigger a failover to another endpoint.
 */
const RETRYABLE_STATUS_CODES = new Set<number>([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * FailoverManager coordinates multiple Horizon endpoints, performs periodic
 * health checks, and automatically fails over to a healthy backup endpoint
 * when the active endpoint fails.
 */
export class FailoverManager {
  private readonly pool: ConnectionPool;
  private readonly registry: EndpointRegistry;
  private readonly options: Required<
    Pick<
      FailoverManagerOptions,
      | 'healthCheckIntervalMs'
      | 'healthCheckTimeoutMs'
      | 'failureThreshold'
      | 'recoveryThreshold'
      | 'healthCheckPath'
    >
  >;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeEndpointId: string | null = null;
  private running = false;

  constructor(options: FailoverManagerOptions) {
    if (!options || !Array.isArray(options.endpoints) || options.endpoints.length === 0) {
      throw new Error('FailoverManager requires at least one endpoint');
    }

    this.options = {
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 30_000,
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? 5_000,
      failureThreshold: options.failureThreshold ?? 1,
      recoveryThreshold: options.recoveryThreshold ?? 1,
      healthCheckPath: options.healthCheckPath ?? '/',
    };

    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('FailoverManager requires a fetch implementation');
    }

    this.pool = new ConnectionPool(options.poolSize ?? 16);
    this.registry = new EndpointRegistry(
      this.options.failureThreshold,
      this.options.recoveryThreshold,
    );

    // Register primary first so it is preferred by the round-robin pool.
    const ordered = [...options.endpoints].sort((a, b) => {
      const ap = a.primary ? 0 : 1;
      const bp = b.primary ? 0 : 1;
      return ap - bp;
    });

    for (const endpoint of ordered) {
      this.pool.add(endpoint);
    }

    const first = this.pool.next();
    this.activeEndpointId = first ? first.endpoint.id : null;
  }

  /** Register an additional backup endpoint at runtime. */
  registerEndpoint(endpoint: FailoverEndpoint): SorokitResult<EndpointHealth> {
    if (!endpoint || !endpoint.id || !endpoint.url) {
      return err(
        createSorokitError(
          SorokitErrorCode.INVALID_ARGUMENT,
          'Endpoint must include id and url',
        ),
      );
    }
    if (this.pool.get(endpoint.id)) {
      return err(
        createSorokitError(
          SorokitErrorCode.INVALID_ARGUMENT,
          `Endpoint "${endpoint.id}" is already registered`,
        ),
      );
    }
    this.pool.add(endpoint);
    const entry = this.pool.get(endpoint.id);
    if (!entry) {
      return err(
        createSorokitError(
          SorokitErrorCode.SERVICE_UNAVAILABLE,
          'Connection pool is full',
        ),
      );
    }
    if (!this.activeEndpointId) {
      this.activeEndpointId = entry.endpoint.id;
    }
    return ok({ ...entry.health });
  }

  /** Remove an endpoint from the manager. */
  unregisterEndpoint(id: string): SorokitResult<boolean> {
    if (!this.pool.get(id)) {
      return err(
        createSorokitError(
          SorokitErrorCode.INVALID_ARGUMENT,
          `Endpoint "${id}" is not registered`,
        ),
      );
    }
    this.pool.remove(id);
    this.registry.reset(id);
    if (this.activeEndpointId === id) {
      const next = this.pool.next();
      this.activeEndpointId = next ? next.endpoint.id : null;
    }
    return ok(true);
  }

  /** Start periodic health checks. */
  start(): SorokitResult<boolean> {
    if (this.running) {
      return ok(true);
    }
    this.running = true;
    this.timer = setInterval(() => {
      // Fire and forget; errors are captured per-endpoint.
      void this.runHealthChecks();
    }, this.options.healthCheckIntervalMs);
    // Do not keep the Node.js event loop alive solely for health checks.
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
    return ok(true);
  }

  /** Stop periodic health checks. */
  stop(): SorokitResult<boolean> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    return ok(true);
  }

  /** Whether the manager is currently running health checks. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the current aggregate health snapshot. */
  getHealth(): FailoverHealth {
    const endpoints = this.pool.all().map((e) => ({ ...e.health }));
    return {
      endpoints,
      activeEndpointId: this.activeEndpointId,
      healthy: endpoints.some((e) => e.healthy),
      running: this.running,
    };
  }

  /** Get the id of the currently active endpoint. */
  getActiveEndpointId(): string | null {
    return this.activeEndpointId;
  }

  /**
   * Run a single round of health checks against all endpoints.
   * Returns the updated health snapshot.
   */
  async runHealthChecks(): Promise<SorokitResult<FailoverHealth>> {
    const entries = this.pool.all();
    await Promise.all(entries.map((entry) => this.checkEndpoint(entry)));
    return ok(this.getHealth());
  }

  private async checkEndpoint(entry: PooledEndpoint): Promise<void> {
    const url = this.buildHealthCheckUrl(entry.endpoint.url);
    const started = Date.now();
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => {
      if (controller) {
        controller.abort();
      }
    }, this.options.healthCheckTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller ? controller.signal : undefined,
      });
      const latency = Date.now() - started;
      if (response.ok || (response.status >= 200 && response.status < 400)) {
        this.pool.recordSuccess(entry.endpoint.id, latency);
        if (this.registry.onSuccess(entry)) {
          this.pool.setHealthy(entry.endpoint.id, true);
        }
      } else {
        this.pool.recordFailure(entry.endpoint.id);
        if (this.registry.onFailure(entry)) {
          this.pool.setHealthy(entry.endpoint.id, false);
        }
      }
    } catch {
      this.pool.recordFailure(entry.endpoint.id);
      if (this.registry.onFailure(entry)) {
        this.pool.setHealthy(entry.endpoint.id, false);
      }
    } finally {
      clearTimeout(timeout);
    }

    // Ensure the active endpoint is healthy; otherwise fail over.
    if (this.activeEndpointId) {
      const active = this.pool.get(this.activeEndpointId);
      if (!active || !active.health.healthy) {
        const next = this.pool.next();
        this.activeEndpointId = next ? next.endpoint.id : null;
      }
    } else {
      const next = this.pool.next();
      this.activeEndpointId = next ? next.endpoint.id : null;
    }
  }

  private buildHealthCheckUrl(base: string): string {
    const trimmed = base.replace(/\/+$/, '');
    const path = this.options.healthCheckPath;
    if (!path || path === '/') {
      return `${trimmed}/`;
    }
    return `${trimmed}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * Perform an HTTP request with automatic failover across registered
   * endpoints. Returns a {@link SorokitResult} wrapping the response.
   */
  async fetch(
    path: string,
    options: FailoverFetchOptions = {},
  ): Promise<SorokitResult<Response>> {
    const { endpointId, maxAttempts, ...init } = options;
    const entries = this.pool.all();
    if (entries.length === 0) {
      return err(
        createSorokitError(
          SorokitErrorCode.SERVICE_UNAVAILABLE,
          'No endpoints registered',
        ),
      );
    }

    const attempts = Math.max(
      1,
      maxAttempts ?? entries.length,
    );

    const tried = new Set<string>();
    let lastError: unknown = null;
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let entry: PooledEndpoint | null;
      if (endpointId && attempt === 0) {
        entry = this.pool.get(endpointId) ?? null;
      } else {
        entry = this.pickNext(tried);
      }

      if (!entry) {
        break;
      }

      tried.add(entry.endpoint.id);
      const url = this.joinUrl(entry.endpoint.url, path);
      const started = Date.now();

      try {
        const response = await this.fetchImpl(url, init);
        const latency = Date.now() - started;

        if (isRetryableStatus(response.status)) {
          lastStatus = response.status;
          this.pool.recordFailure(entry.endpoint.id);
          if (this.registry.onFailure(entry)) {
            this.pool.setHealthy(entry.endpoint.id, false);
          }
          this.failoverFrom(entry.endpoint.id);
          continue;
        }

        this.pool.recordSuccess(entry.endpoint.id, latency);
        if (this.registry.onSuccess(entry)) {
          this.pool.setHealthy(entry.endpoint.id, true);
        }
        this.activeEndpointId = entry.endpoint.id;
        return ok(response);
      } catch (error) {
        lastError = error;
        this.pool.recordFailure(entry.endpoint.id);
        if (this.registry.onFailure(entry)) {
          this.pool.setHealthy(entry.endpoint.id, false);
        }
        this.failoverFrom(entry.endpoint.id);
      }
    }

    if (lastStatus !== null) {
      return err(
        createSorokitError(
          SorokitErrorCode.SERVICE_UNAVAILABLE,
          `All endpoints failed; last status ${lastStatus}`,
        ),
      );
    }

    const message =
      lastError instanceof Error
        ? lastError.message
        : 'All endpoints failed';
    return err(createSorokitError(SorokitErrorCode.NETWORK_ERROR, message));
  }

  private pickNext(tried: Set<string>): PooledEndpoint | null {
    const total = this.pool.all().length;
    if (total === 0) {
      return null;
    }
    // Try up to `total` times to find an untried healthy endpoint.
    for (let i = 0; i < total; i++) {
      const candidate = this.pool.next();
      if (!candidate) {
        return null;
      }
      if (!tried.has(candidate.endpoint.id)) {
        return candidate;
      }
    }
    // Fall back to any healthy endpoint even if already tried.
    return this.pool.next();
  }

  private failoverFrom(failedId: string): void {
    if (this.activeEndpointId !== failedId) {
      return;
    }
    const next = this.pool.next();
    this.activeEndpointId = next ? next.endpoint.id : null;
  }

  private joinUrl(base: string, path: string): string {
    const trimmedBase = base.replace(/\/+$/, '');
    if (!path) {
      return trimmedBase;
    }
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    return `${trimmedBase}/${path.replace(/^\/+/, '')}`;
  }
}

/**
 * Convenience factory for creating a {@link FailoverManager}.
 */
export function createFailoverManager(
  options: FailoverManagerOptions,
): FailoverManager {
  return new FailoverManager(options);
}