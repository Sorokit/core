import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface EndpointHealth {
  endpoint: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt?: number;
  lastFailureAt?: number;
  latencyMs?: number;
}

export interface EndpointFailoverOptions {
  /** Number of failed requests before an endpoint is temporarily deprioritised. */
  failureThreshold?: number;
  /** How long an unhealthy endpoint remains deprioritised. */
  recoveryIntervalMs?: number;
  /** Health probe interval used by startHealthMonitoring. */
  healthCheckIntervalMs?: number;
}

export interface EndpointHealthCheckResult {
  endpoint: string;
  healthy: boolean;
  latencyMs: number;
  error?: unknown;
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Ordered endpoint pool. The first configured endpoint is the primary; healthy
 * backups are selected in order and unhealthy endpoints are periodically
 * retried so recovery is automatic.
 */
export class EndpointPool {
  readonly endpoints: readonly string[];
  private readonly states = new Map<string, EndpointHealth>();
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private cursor = 0;

  constructor(endpoints: string[], options: EndpointFailoverOptions = {}) {
    const unique = [...new Set(endpoints.map(normalizeEndpoint).filter(Boolean))];
    if (unique.length === 0) throw new Error("At least one endpoint is required");
    this.endpoints = Object.freeze(unique);
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.recoveryIntervalMs = Math.max(0, options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS);
    for (const endpoint of this.endpoints) {
      this.states.set(endpoint, { endpoint, healthy: true, consecutiveFailures: 0 });
    }
  }

  get primary(): string { return this.endpoints[0]!; }

  get current(): string {
    const now = Date.now();
    for (let offset = 0; offset < this.endpoints.length; offset += 1) {
      const endpoint = this.endpoints[(this.cursor + offset) % this.endpoints.length]!;
      const state = this.states.get(endpoint)!;
      if (state.healthy || !state.lastFailureAt || now - state.lastFailureAt >= this.recoveryIntervalMs) {
        this.cursor = (this.endpoints.indexOf(endpoint) + 1) % this.endpoints.length;
        return endpoint;
      }
    }
    return this.endpoints[this.cursor % this.endpoints.length]!;
  }

  markSuccess(endpoint: string, latencyMs?: number): void {
    const normalized = normalizeEndpoint(endpoint);
    const current = this.states.get(normalized);
    if (!current) return;
    this.states.set(normalized, {
      ...current,
      healthy: true,
      consecutiveFailures: 0,
      lastCheckedAt: Date.now(),
      ...(latencyMs === undefined ? {} : { latencyMs }),
    });
  }

  markFailure(endpoint: string): void {
    const normalized = normalizeEndpoint(endpoint);
    const current = this.states.get(normalized);
    if (!current) return;
    const failures = current.consecutiveFailures + 1;
    this.states.set(normalized, {
      ...current,
      healthy: failures < this.failureThreshold,
      consecutiveFailures: failures,
      lastFailureAt: Date.now(),
      lastCheckedAt: Date.now(),
    });
  }

  getHealth(): EndpointHealth[] {
    return this.endpoints.map((endpoint) => ({ ...this.states.get(endpoint)! }));
  }

  async check(fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): Promise<EndpointHealthCheckResult[]> {
    const results: EndpointHealthCheckResult[] = [];
    for (const endpoint of this.endpoints) {
      const started = Date.now();
      try {
        const response = await fetcher(endpoint, { method: "GET" });
        const latencyMs = Date.now() - started;
        if (response.ok) this.markSuccess(endpoint, latencyMs);
        else this.markFailure(endpoint);
        results.push({ endpoint, healthy: response.ok, latencyMs, ...(response.ok ? {} : { error: response.status }) });
      } catch (error) {
        const latencyMs = Date.now() - started;
        this.markFailure(endpoint);
        results.push({ endpoint, healthy: false, latencyMs, error });
      }
    }
    return results;
  }

  startHealthMonitoring(fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis), intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS): () => void {
    this.stopHealthMonitoring();
    void this.check(fetcher);
    this.monitor = setInterval(() => void this.check(fetcher), Math.max(1, intervalMs));
    return () => this.stopHealthMonitoring();
  }

  stopHealthMonitoring(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
  }
}

const pools = new Map<string, EndpointPool>();

export function configureEndpointFailover(primary: string, backups: string[] = [], options?: EndpointFailoverOptions): EndpointPool {
  const pool = new EndpointPool([primary, ...backups], options);
  pools.set(normalizeEndpoint(primary), pool);
  return pool;
}

export function getEndpointPool(primary: string): EndpointPool | undefined {
  return pools.get(normalizeEndpoint(primary));
}

function rewriteEndpoint(input: RequestInfo | URL, endpoint: string, original: string): RequestInfo | URL {
  const source = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const sourceUrl = new URL(source);
  const originalUrl = new URL(original);
  const replacement = new URL(endpoint);
  replacement.pathname = sourceUrl.pathname;
  replacement.search = sourceUrl.search;
  replacement.hash = sourceUrl.hash;
  if (sourceUrl.origin === originalUrl.origin) return replacement.toString();
  return input;
}

/** Fetch wrapper used by Stellar SDK servers. It retries transient endpoint failures on a healthy backup. */
export function createFailoverFetch(pool: EndpointPool, fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): typeof globalThis.fetch {
  return async (input, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < pool.endpoints.length; attempt += 1) {
      const endpoint = pool.current;
      const started = Date.now();
      try {
        const response = await fetcher(rewriteEndpoint(input, endpoint, pool.primary), init);
        if (response.ok || !isRetryableStatus(response.status) || attempt === pool.endpoints.length - 1) {
          if (response.ok) pool.markSuccess(endpoint, Date.now() - started);
          else pool.markFailure(endpoint);
          return response;
        }
        pool.markFailure(endpoint);
        lastError = new Error(`Endpoint returned HTTP ${response.status}`);
      } catch (error) {
        pool.markFailure(endpoint);
        lastError = error;
        if (attempt === pool.endpoints.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All endpoints failed");
  };
}

export function validateEndpointList(endpoints: string[] | undefined): SorokitResult<void> {
  if (endpoints === undefined) return ok(undefined);
  if (!Array.isArray(endpoints) || endpoints.length === 0 || endpoints.some((endpoint) => {
    try { const url = new URL(endpoint); return url.protocol !== "http:" && url.protocol !== "https:"; } catch { return true; }
  })) return err(SorokitErrorCode.INVALID_CONFIG, "Endpoint lists must contain at least one valid HTTP(S) URL.");
  return ok(undefined);
}
