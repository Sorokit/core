/**
 * Connection Pooling and Adaptive Rate Limiting (#930)
 *
 * Provides a bounded-concurrency request queue with per-endpoint Horizon
 * rate limit tracking and adaptive exponential backoff on HTTP 429 responses.
 * All public execution methods return SorokitResult<T> and never throw.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { parseRetryAfter } from "./adaptiveRateLimiter";

/** Configuration options for the pooled Horizon rate limiter (#930). */
export interface HorizonRateLimiterConfig {
  /** Maximum concurrent in-flight requests across the pool. Default: 6. */
  maxConcurrency?: number;
  /** Maximum queued requests before rejecting new submissions. Default: 250. */
  maxQueueSize?: number;
  /** Maximum retry attempts when HTTP 429 is encountered. Default: 3. */
  maxRetries?: number;
  /** Base exponential backoff delay in milliseconds on 429. Default: 250. */
  baseBackoffMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 10000. */
  maxBackoffMs?: number;
  /** Custom sleep implementation (useful for deterministic unit tests). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Custom clock function. Default: Date.now. */
  nowFn?: () => number;
}

/** Per-endpoint rate limit tracking state (#930). */
export interface EndpointRateLimitMetrics {
  endpoint: string;
  activeRequests: number;
  totalRequests: number;
  rateLimitedCount: number;
  retryCount: number;
  remainingQuota: number | null;
  quotaLimit: number | null;
  resetAtMs: number | null;
  cooldownUntilMs: number;
  currentBackoffMs: number;
}

/** Overall connection pool and queue statistics (#930). */
export interface RateLimiterQueueStats {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
  maxQueueSize: number;
  completedCount: number;
  failedCount: number;
}

/** Optional response metadata extractor for custom operations. */
export interface RateLimitResponseMeta {
  status?: number;
  headers?: Headers | Record<string, string | undefined> | { get?(name: string): string | null };
}

interface QueuedTask {
  run: () => void;
}

function getHeader(
  headers: RateLimitResponseMeta["headers"],
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: (n: string) => string | null }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower && typeof v === "string") {
      return v;
    }
  }
  return null;
}

function extractStatusAndHeaders(value: unknown): RateLimitResponseMeta {
  if (!value || typeof value !== "object") return {};
  const candidate = value as Record<string, unknown>;
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const headers =
    candidate.headers && typeof candidate.headers === "object"
      ? (candidate.headers as RateLimitResponseMeta["headers"])
      : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

function normalizeEndpointKey(endpointOrUrl: string): string {
  try {
    const url = new URL(endpointOrUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return endpointOrUrl.split("?")[0] || endpointOrUrl;
  }
}

/**
 * Pooled adaptive rate limiter that prevents Horizon 429 overload by combining
 * a bounded concurrency pool, per-endpoint quota tracking, and exponential backoff (#930).
 */
export class HorizonRateLimiter {
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;

  private activeCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private readonly queue: QueuedTask[] = [];
  private readonly endpoints = new Map<string, EndpointRateLimitMetrics>();

  constructor(config: HorizonRateLimiterConfig = {}) {
    this.maxConcurrency = Math.max(1, config.maxConcurrency ?? 6);
    this.maxQueueSize = Math.max(1, config.maxQueueSize ?? 250);
    this.maxRetries = Math.max(0, config.maxRetries ?? 3);
    this.baseBackoffMs = Math.max(1, config.baseBackoffMs ?? 250);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, config.maxBackoffMs ?? 10000);
    this.sleepFn =
      config.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowFn = config.nowFn ?? (() => Date.now());
  }

  private getOrCreateEndpoint(endpointKey: string): EndpointRateLimitMetrics {
    let state = this.endpoints.get(endpointKey);
    if (!state) {
      state = {
        endpoint: endpointKey,
        activeRequests: 0,
        totalRequests: 0,
        rateLimitedCount: 0,
        retryCount: 0,
        remainingQuota: null,
        quotaLimit: null,
        resetAtMs: null,
        cooldownUntilMs: 0,
        currentBackoffMs: 0,
      };
      this.endpoints.set(endpointKey, state);
    }
    return state;
  }

  private acquireSlot(): Promise<boolean> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return Promise.resolve(true);
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.queue.push({
        run: () => {
          this.activeCount += 1;
          resolve(true);
        },
      });
    });
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.queue.shift();
    if (next) {
      next.run();
    }
  }

  private updateFromHeaders(
    metrics: EndpointRateLimitMetrics,
    headers?: RateLimitResponseMeta["headers"],
  ): void {
    const remainingRaw = getHeader(headers, "X-RateLimit-Remaining");
    const limitRaw = getHeader(headers, "X-RateLimit-Limit");
    const resetRaw = getHeader(headers, "X-RateLimit-Reset");

    if (remainingRaw !== null) {
      const parsed = Number(remainingRaw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        metrics.remainingQuota = parsed;
      }
    }
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        metrics.quotaLimit = parsed;
      }
    }
    if (resetRaw !== null) {
      const parsed = Number(resetRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        metrics.resetAtMs = parsed > 1e12 ? parsed : this.nowFn() + parsed * 1000;
      }
    }
  }

  /**
   * Execute an asynchronous Horizon request through the concurrency pool with
   * per-endpoint rate limit tracking and automatic exponential backoff on HTTP 429.
   */
  async execute<T>(
    endpointOrUrl: string,
    operation: () => Promise<T>,
  ): Promise<SorokitResult<T>> {
    const endpointKey = normalizeEndpointKey(endpointOrUrl);
    const metrics = this.getOrCreateEndpoint(endpointKey);

    const acquired = await this.acquireSlot();
    if (!acquired) {
      this.failedCount += 1;
      return err(
        SorokitErrorCode.RATE_LIMITED,
        `Request queue is full (${this.maxQueueSize} pending requests) for endpoint "${endpointKey}".`,
      );
    }

    metrics.activeRequests += 1;

    try {
      let attempt = 0;

      while (true) {
        const now = this.nowFn();
        if (metrics.cooldownUntilMs > now) {
          await this.sleepFn(metrics.cooldownUntilMs - now);
        }

        metrics.totalRequests += 1;

        let result: T;
        try {
          result = await operation();
        } catch (cause) {
          const meta = extractStatusAndHeaders(cause);
          if (meta.status === 429) {
            metrics.rateLimitedCount += 1;
            this.updateFromHeaders(metrics, meta.headers);

            if (attempt >= this.maxRetries) {
              this.failedCount += 1;
              return err(
                SorokitErrorCode.RATE_LIMITED,
                `Horizon rate limit (HTTP 429) exceeded for "${endpointKey}" after ${attempt} retries.`,
                cause,
              );
            }

            const retryAfterMs = parseRetryAfter(getHeader(meta.headers, "Retry-After"));
            const computedBackoff = Math.min(
              this.maxBackoffMs,
              this.baseBackoffMs * 2 ** attempt,
            );
            const delayMs = retryAfterMs ?? computedBackoff;

            metrics.currentBackoffMs = delayMs;
            metrics.cooldownUntilMs = this.nowFn() + delayMs;
            metrics.retryCount += 1;
            attempt += 1;

            await this.sleepFn(delayMs);
            continue;
          }

          this.failedCount += 1;
          return err(
            SorokitErrorCode.NETWORK_ERROR,
            cause instanceof Error ? cause.message : String(cause),
            cause,
          );
        }

        const meta = extractStatusAndHeaders(result);
        this.updateFromHeaders(metrics, meta.headers);

        if (meta.status === 429) {
          metrics.rateLimitedCount += 1;

          if (attempt >= this.maxRetries) {
            this.failedCount += 1;
            return err(
              SorokitErrorCode.RATE_LIMITED,
              `Horizon rate limit (HTTP 429) exceeded for "${endpointKey}" after ${attempt} retries.`,
            );
          }

          const retryAfterMs = parseRetryAfter(getHeader(meta.headers, "Retry-After"));
          const computedBackoff = Math.min(
            this.maxBackoffMs,
            this.baseBackoffMs * 2 ** attempt,
          );
          const delayMs = retryAfterMs ?? computedBackoff;

          metrics.currentBackoffMs = delayMs;
          metrics.cooldownUntilMs = this.nowFn() + delayMs;
          metrics.retryCount += 1;
          attempt += 1;

          await this.sleepFn(delayMs);
          continue;
        }

        // Successful non-429 response resets backoff
        metrics.currentBackoffMs = 0;
        metrics.cooldownUntilMs = 0;
        this.completedCount += 1;
        return ok(result);
      }
    } finally {
      metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
      this.releaseSlot();
    }
  }

  /**
   * Perform a rate-limited, connection-pooled fetch request returning SorokitResult<Response>.
   */
  async fetch(
    url: string,
    init?: RequestInit,
    fetchFn: typeof fetch = fetch,
  ): Promise<SorokitResult<Response>> {
    return this.execute(url, () => fetchFn(url, init));
  }

  /**
   * Inspect rate limit and concurrency metrics for a specific endpoint.
   */
  getEndpointMetrics(endpointOrUrl: string): EndpointRateLimitMetrics {
    const key = normalizeEndpointKey(endpointOrUrl);
    return { ...this.getOrCreateEndpoint(key) };
  }

  /**
   * Return rate limit metrics for all tracked endpoints.
   */
  getAllEndpointMetrics(): EndpointRateLimitMetrics[] {
    return Array.from(this.endpoints.values()).map((entry) => ({ ...entry }));
  }

  /**
   * Return connection pool and queue statistics.
   */
  getQueueStats(): RateLimiterQueueStats {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueueSize: this.maxQueueSize,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
  }

  /**
   * Reset all tracked per-endpoint rate limit metrics and counters.
   */
  reset(): void {
    this.endpoints.clear();
    this.completedCount = 0;
    this.failedCount = 0;
  }
}

/**
 * Factory helper to create a pooled HorizonRateLimiter instance (#930).
 */
export function createHorizonRateLimiter(
  config?: HorizonRateLimiterConfig,
): HorizonRateLimiter {
  return new HorizonRateLimiter(config);
}
