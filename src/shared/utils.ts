/**
 * Shared utility functions used across sorokit-core modules.
 * Nothing here should import from any module — only from types and constants.
 */

import { DEFAULT_ADDRESS_DISPLAY_CHARS } from "./constants";
import { isTransientError } from "./errors";
import { isBrowser as isBrowserEnv } from "./environment";

/**
 * Detect whether we are running in a browser environment.
 * Wallet extensions are browser-only — this guard prevents crashes in Node.
 */
export function isBrowser(): boolean {
  return isBrowserEnv();
}

/**
 * Shorten a Stellar public key for display.
 * e.g. GABCDEFG...WXYZ
 */
export function formatAddress(
  publicKey: string,
  chars = DEFAULT_ADDRESS_DISPLAY_CHARS,
): string {
  if (publicKey.length <= chars * 2 + 3) return publicKey;
  return `${publicKey.slice(0, chars + 1)}...${publicKey.slice(-chars)}`;
}

/**
 * Sleep for a given number of milliseconds.
 * Used in polling loops — avoids importing timers in multiple places.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate that a string looks like a Stellar public key (G...).
 * This is a lightweight format check, not a cryptographic validation.
 */
export function isValidPublicKey(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Validate that a string looks like a Stellar contract ID (C...).
 */
export function isValidContractId(id: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(id);
}

/**
 * Generate a short, URL-safe trace ID for correlating an operation chain.
 *
 * Prefers the platform crypto (`randomUUID`/`getRandomValues`) when available
 * and falls back to `Math.random` so the SDK stays dependency-free and works
 * in every runtime. The value is for correlation only, not security.
 */
export function generateTraceId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Retry configuration for exponential backoff.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts?: number;
  /** Initial delay in milliseconds before first retry */
  initialDelayMs?: number;
  /** Whether to add random jitter to delay (recommended) */
  jitter?: boolean;
}

/**
 * Default retry configuration.
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  jitter: true,
};

/**
 * Retry an async function with exponential backoff and optional jitter.
 * Only retries on transient errors (timeouts, network issues, 5xx).
 * Does not retry on permanent errors (404, invalid params).
 *
 * @param fn - Async function to retry
 * @param config - Retry configuration
 * @returns Result of the function or last error after exhausting retries
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const { maxAttempts, initialDelayMs, jitter } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error)) {
        throw error;
      }

      if (attempt < maxAttempts - 1) {
        const baseDelay = initialDelayMs * Math.pow(2, attempt);
        const jitterMs = jitter ? Math.random() * baseDelay * 0.1 : 0;
        const delay = baseDelay + jitterMs;

        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Per-endpoint rate limiter configuration options.
 */
export interface EndpointRateLimitConfig {
  /** Default rate limit (requests per second) for unspecified endpoints. Default: 10 */
  defaultLimit?: number;
  /** Per-endpoint rate limits (requests per second) keyed by endpoint name */
  endpoints?: Record<string, number>;
  /**
   * Optional callback invoked on every rate-limit event (acquire, queue, drain).
   * Use this for structured logging, Prometheus counters, or custom dashboards.
   */
  onMetricEvent?: (event: RateLimiterMetricEvent) => void;
}

/**
 * Reasonable default per-endpoint rate limits (requests per second).
 */
export const DEFAULT_ENDPOINT_RATE_LIMITS: Record<string, number> = {
  "contract.simulate": 5,
  "contract.invoke": 5,
  "account.get": 20,
  "account.balances": 20,
  "transaction.submit": 10,
};

interface BucketState {
  capacity: number;
  tokens: number;
  lastRefill: number;
  refillRate: number; // tokens per ms
  queue: Array<() => void>;
  drainTimer: ReturnType<typeof setTimeout> | null;
  // metrics
  totalRequests: number;
  rejectedRequests: number;
  totalWaitMs: number;
}

/** Snapshot of metrics for a single rate-limit bucket. */
export interface RateLimiterBucketMetrics {
  /** Current token count (may be fractional between refills). */
  currentTokens: number;
  /** Total requests that called acquire() on this endpoint. */
  totalRequests: number;
  /** Requests that had to wait because the bucket was empty. */
  queuedRequests: number;
  /** Current queue depth (waiting requests). */
  currentQueueDepth: number;
  /** Cumulative wait time across all queued requests in ms. */
  totalWaitMs: number;
  /** Average wait time per queued request in ms (0 when none queued). */
  averageWaitMs: number;
}

/** Aggregated metrics across all endpoints. */
export interface RateLimiterMetrics {
  /** Per-endpoint snapshots, keyed by endpoint name. */
  endpoints: Record<string, RateLimiterBucketMetrics>;
  /** Sum of totalRequests across all endpoints. */
  totalRequests: number;
  /** Sum of queuedRequests across all endpoints. */
  totalQueuedRequests: number;
}

/** Event types emitted by the rate limiter metrics callback. */
export type RateLimiterEventType = "acquired" | "queued" | "drained";

/** Payload passed to the optional metrics callback. */
export interface RateLimiterMetricEvent {
  type: RateLimiterEventType;
  endpoint: string;
  /** Current token count after the event. */
  tokens: number;
  /** Current queue depth after the event. */
  queueDepth: number;
  /** Wait time in ms — only set for "drained" events. */
  waitMs?: number;
}

/**
 * Token bucket rate limiter supporting per-endpoint quotas, runtime overrides,
 * rate-limit header parsing (X-Rate-Limit-*), and metrics observability.
 */
export class TokenBucketRateLimiter {
  private defaultLimit: number;
  private endpointLimits: Map<string, number>;
  private buckets: Map<string, BucketState>;
  private onMetricEvent?: (event: RateLimiterMetricEvent) => void;

  constructor(limitOrConfig: number | EndpointRateLimitConfig = 10) {
    this.endpointLimits = new Map<string, number>();
    this.buckets = new Map<string, BucketState>();

    if (typeof limitOrConfig === "number") {
      if (limitOrConfig <= 0) {
        throw new Error("maxRequestsPerSecond must be a positive number");
      }
      this.defaultLimit = limitOrConfig;
    } else {
      const defaultLimit = limitOrConfig.defaultLimit ?? 10;
      if (defaultLimit <= 0) {
        throw new Error("defaultLimit must be a positive number");
      }
      this.defaultLimit = defaultLimit;
      if (limitOrConfig.onMetricEvent !== undefined) {
        this.onMetricEvent = limitOrConfig.onMetricEvent;
      }

      if (limitOrConfig.endpoints) {
        for (const [ep, limit] of Object.entries(limitOrConfig.endpoints)) {
          if (limit > 0) {
            this.endpointLimits.set(ep, limit);
          }
        }
      }
    }

    // Populate standard defaults if not already overridden
    for (const [ep, limit] of Object.entries(DEFAULT_ENDPOINT_RATE_LIMITS)) {
      if (!this.endpointLimits.has(ep)) {
        this.endpointLimits.set(ep, limit);
      }
    }
  }

  private getBucket(endpoint: string = "default"): BucketState {
    let bucket = this.buckets.get(endpoint);
    if (!bucket) {
      const limit = this.endpointLimits.get(endpoint) ?? this.defaultLimit;
      bucket = {
        capacity: limit,
        tokens: limit,
        lastRefill: Date.now(),
        refillRate: limit / 1000,
        queue: [],
        drainTimer: null,
        totalRequests: 0,
        rejectedRequests: 0,
        totalWaitMs: 0,
      };
      this.buckets.set(endpoint, bucket);
    }
    return bucket;
  }

  private refill(bucket: BucketState): void {
    const now = Date.now();
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + (now - bucket.lastRefill) * bucket.refillRate,
    );
    bucket.lastRefill = now;
  }

  private scheduleDrain(bucket: BucketState): void {
    if (bucket.drainTimer !== null) return;
    const msUntilToken = Math.ceil((1 - bucket.tokens) / bucket.refillRate);
    bucket.drainTimer = setTimeout(() => {
      bucket.drainTimer = null;
      this.drain(bucket);
    }, Math.max(0, msUntilToken));
  }

  private drain(bucket: BucketState, endpoint: string = "default"): void {
    this.refill(bucket);
    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      const resolve = bucket.queue.shift();
      if (resolve === undefined) break;
      bucket.tokens -= 1;
      // Approximate wait from queue entry time stored in rejectedRequests tracking
      resolve();
      this.onMetricEvent?.({
        type: "drained",
        endpoint,
        tokens: bucket.tokens,
        queueDepth: bucket.queue.length,
      });
    }
    if (bucket.queue.length > 0) this.scheduleDrain(bucket);
  }

  /**
   * Acquire a token for an optional endpoint, waiting if the bucket is empty.
   * Increments totalRequests and, when queued, rejectedRequests + wait tracking.
   */
  async acquire(endpoint: string = "default"): Promise<void> {
    const bucket = this.getBucket(endpoint);
    this.refill(bucket);
    bucket.totalRequests += 1;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.onMetricEvent?.({
        type: "acquired",
        endpoint,
        tokens: bucket.tokens,
        queueDepth: bucket.queue.length,
      });
      return;
    }

    bucket.rejectedRequests += 1;
    const queuedAt = Date.now();

    return new Promise<void>((resolve) => {
      bucket.queue.push(() => {
        const waitMs = Date.now() - queuedAt;
        bucket.totalWaitMs += waitMs;
        this.onMetricEvent?.({
          type: "queued",
          endpoint,
          tokens: bucket.tokens,
          queueDepth: bucket.queue.length,
          waitMs,
        });
        resolve();
      });
      this.scheduleDrain(bucket);
    });
  }

  /**
   * Snapshot metrics for a single endpoint (or "default").
   * Returns undefined when the endpoint bucket has never been accessed.
   */
  getMetrics(endpoint: string = "default"): RateLimiterBucketMetrics | undefined {
    const bucket = this.buckets.get(endpoint);
    if (!bucket) return undefined;
    this.refill(bucket);
    return {
      currentTokens: bucket.tokens,
      totalRequests: bucket.totalRequests,
      queuedRequests: bucket.rejectedRequests,
      currentQueueDepth: bucket.queue.length,
      totalWaitMs: bucket.totalWaitMs,
      averageWaitMs:
        bucket.rejectedRequests > 0
          ? bucket.totalWaitMs / bucket.rejectedRequests
          : 0,
    };
  }

  /**
   * Aggregated metrics snapshot across all tracked endpoints.
   */
  getAllMetrics(): RateLimiterMetrics {
    const endpointMap: Record<string, RateLimiterBucketMetrics> = {};
    let totalRequests = 0;
    let totalQueuedRequests = 0;

    for (const [ep, bucket] of this.buckets.entries()) {
      this.refill(bucket);
      const snapshot: RateLimiterBucketMetrics = {
        currentTokens: bucket.tokens,
        totalRequests: bucket.totalRequests,
        queuedRequests: bucket.rejectedRequests,
        currentQueueDepth: bucket.queue.length,
        totalWaitMs: bucket.totalWaitMs,
        averageWaitMs:
          bucket.rejectedRequests > 0
            ? bucket.totalWaitMs / bucket.rejectedRequests
            : 0,
      };
      endpointMap[ep] = snapshot;
      totalRequests += bucket.totalRequests;
      totalQueuedRequests += bucket.rejectedRequests;
    }

    return { endpoints: endpointMap, totalRequests, totalQueuedRequests };
  }

  /**
   * Reset metrics counters for a single endpoint (or all when omitted).
   * Does not affect token state or queue.
   */
  resetMetrics(endpoint?: string): void {
    const reset = (bucket: BucketState): void => {
      bucket.totalRequests = 0;
      bucket.rejectedRequests = 0;
      bucket.totalWaitMs = 0;
    };
    if (endpoint !== undefined) {
      const bucket = this.buckets.get(endpoint);
      if (bucket) reset(bucket);
    } else {
      for (const bucket of this.buckets.values()) reset(bucket);
    }
  }

  /**
   * Get the current configured rate limit for an endpoint or default limit.
   */
  getEndpointLimit(endpoint: string = "default"): number {
    return this.endpointLimits.get(endpoint) ?? this.defaultLimit;
  }

  /**
   * Override or dynamically set the rate limit for a specific endpoint at runtime.
   */
  setEndpointLimit(endpoint: string, limitPerSecond: number): void {
    if (limitPerSecond <= 0) return;
    this.endpointLimits.set(endpoint, limitPerSecond);
    const bucket = this.buckets.get(endpoint);
    if (bucket) {
      bucket.capacity = limitPerSecond;
      bucket.refillRate = limitPerSecond / 1000;
      bucket.tokens = Math.min(bucket.tokens, limitPerSecond);
    }
  }

  /**
   * Process rate limit headers (X-Rate-Limit-*) from RPC or Horizon HTTP responses
   * and update the endpoint rate bucket dynamically.
   */
  handleResponseHeaders(
    endpoint: string,
    headers: Headers | Record<string, string>,
  ): void {
    const getHeader = (name: string): string | null => {
      if (typeof (headers as Headers).get === "function") {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string>;
      const key = Object.keys(record).find(
        (k) => k.toLowerCase() === name.toLowerCase(),
      );
      return key && record[key] !== undefined ? record[key]! : null;
    };

    const limitHeader =
      getHeader("x-rate-limit-limit") || getHeader("x-ratelimit-limit");
    if (limitHeader) {
      const parsedLimit = parseInt(limitHeader, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        this.setEndpointLimit(endpoint, parsedLimit);
      }
    }

    const remainingHeader =
      getHeader("x-rate-limit-remaining") || getHeader("x-ratelimit-remaining");
    if (remainingHeader) {
      const parsedRemaining = parseInt(remainingHeader, 10);
      if (!isNaN(parsedRemaining) && parsedRemaining >= 0) {
        const bucket = this.getBucket(endpoint);
        bucket.tokens = Math.min(bucket.tokens, parsedRemaining);
      }
    }

    const resetHeader =
      getHeader("x-rate-limit-reset") || getHeader("x-ratelimit-reset");
    if (resetHeader) {
      const parsedReset = parseInt(resetHeader, 10);
      if (!isNaN(parsedReset) && parsedReset > 0) {
        const bucket = this.getBucket(endpoint);
        // If reset is given in relative seconds or unix timestamp
        const nowSec = Math.floor(Date.now() / 1000);
        const diffSec = parsedReset > nowSec ? parsedReset - nowSec : parsedReset;
        if (diffSec > 0 && bucket.tokens < 1) {
          bucket.lastRefill = Date.now();
        }
      }
    }
  }
}

/** Module-level map of in-flight requests keyed by a caller-supplied key. */
const _inflightRequests = new Map<string, Promise<unknown>>();

/**
 * Deduplicate concurrent identical API calls.
 *
 * Multiple concurrent callers with the same `key` share a single Promise.
 * Once the Promise settles (resolve or reject), it is removed from the map
 * so the next call with the same key starts a fresh request.
 *
 * The caller is responsible for computing a stable, unique `key` from the
 * function identity and its parameters (e.g. `getAccount:${publicKey}`).
 *
 * @example
 * function getAccount(url: string, key: string) {
 *   return deduplicateRequest(`getAccount:${key}`, () => fetchAccount(url, key));
 * }
 */
export function deduplicateRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflightRequests.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fn().finally(() => {
    _inflightRequests.delete(key);
  });

  _inflightRequests.set(key, promise);
  return promise;
}

/**
 * Return the number of in-flight deduplicated requests currently active.
 * Useful for diagnostics, testing, and observability dashboards.
 *
 * @example
 * console.log("in-flight:", getInflightRequestCount());
 */
export function getInflightRequestCount(): number {
  return _inflightRequests.size;
}

/**
 * Clear all in-flight request records. Useful for test isolation.
 */
export function clearInflightRequests(): void {
  _inflightRequests.clear();
}

/**
 * Configuration for streaming poll retry behavior.
 */
export interface StreamingRetryConfig {
  /** Enable automatic retry with exponential backoff. Default: true. */
  enabled?: boolean;
  /** Maximum consecutive failures before emitting error and entering cooldown. Default: 5. */
  maxConsecutiveFailures?: number;
  /** Cooldown period in milliseconds after max consecutive failures. Default: 60000 (60s). */
  cooldownMs?: number;
  /** Initial backoff delay in milliseconds. Default: 1000 (1s). */
  initialBackoffMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 30000 (30s). */
  maxBackoffMs?: number;
  /** Whether to add random jitter to backoff delays. Default: true. */
  jitter?: boolean;
}

/**
 * Default streaming retry configuration.
 */
const DEFAULT_STREAMING_RETRY_CONFIG: Required<StreamingRetryConfig> = {
  enabled: true,
  maxConsecutiveFailures: 5,
  cooldownMs: 60_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  jitter: true,
};

/**
 * State for tracking retry attempts across stream polls.
 */
export interface StreamingRetryState {
  consecutiveFailures: number;
  inCooldown: boolean;
}

/**
 * Calculate exponential backoff delay with jitter.
 * Progression: 1s, 2s, 4s, 8s, 16s, then capped at 30s.
 */
function calculateBackoff(
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  jitter: boolean,
): number {
  const baseDelay = initialBackoffMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(baseDelay, maxBackoffMs);
  const jitterMs = jitter ? Math.random() * cappedDelay * 0.1 : 0;
  return cappedDelay + jitterMs;
}

/**
 * Handle retry logic for streaming polls with exponential backoff.
 *
 * This function is designed to be called within stream generators to handle
 * transient errors automatically. It implements:
 * - Exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s)
 * - Circuit breaker after 5 consecutive failures (60s cooldown)
 * - Automatic state reset on success
 *
 * @param success - Whether the poll succeeded
 * @param state - Current retry state (consecutive failures, cooldown status)
 * @param config - Retry configuration
 * @returns Object indicating whether to retry, delay in ms, and updated state
 */
export function retryStreamingPoll(
  success: boolean,
  state: StreamingRetryState,
  config: StreamingRetryConfig = {},
): {
  shouldRetry: boolean;
  delayMs: number;
  updatedState: StreamingRetryState;
} {
  const {
    enabled,
    maxConsecutiveFailures,
    cooldownMs,
    initialBackoffMs,
    maxBackoffMs,
    jitter,
  } = { ...DEFAULT_STREAMING_RETRY_CONFIG, ...config };

  // Reset state on success
  if (success) {
    return {
      shouldRetry: false,
      delayMs: 0,
      updatedState: { consecutiveFailures: 0, inCooldown: false },
    };
  }

  // If auto-retry is disabled, don't retry
  if (!enabled) {
    return {
      shouldRetry: false,
      delayMs: 0,
      updatedState: state,
    };
  }

  // If we're in cooldown, continue cooldown and don't retry
  if (state.inCooldown) {
    return {
      shouldRetry: false,
      delayMs: cooldownMs,
      updatedState: state,
    };
  }

  // Increment failure counter
  const updatedState: StreamingRetryState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    inCooldown: false,
  };

  // Check if we've hit the failure threshold
  if (updatedState.consecutiveFailures >= maxConsecutiveFailures) {
    // Enter cooldown mode
    updatedState.inCooldown = true;
    return {
      shouldRetry: false,
      delayMs: cooldownMs,
      updatedState,
    };
  }

  // Calculate backoff delay and retry
  const delayMs = calculateBackoff(
    updatedState.consecutiveFailures - 1,
    initialBackoffMs,
    maxBackoffMs,
    jitter,
  );

  return {
    shouldRetry: true,
    delayMs,
    updatedState,
  };
}
