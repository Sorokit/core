import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RateLimiterOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  /**
   * Maximum number of requests waiting to start. Requests beyond this limit
   * fail with `RATE_LIMITED`; active operations are not counted. Omitted means
   * the queue remains unbounded for backwards compatibility.
   */
  maxQueueSize?: number;
}

export interface RateLimiter {
  execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>>;
  readonly pending: number;
}

const inFlightRequests = new Map<string, Promise<SorokitResult<unknown>>>();

export function deduplicateRequest<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<SorokitResult<T>> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<SorokitResult<T>>;

  const pending = Promise.resolve()
    .then(operation)
    .then(ok)
    .catch((cause: unknown) =>
      err<T>(
        SorokitErrorCode.NETWORK_ERROR,
        cause instanceof Error ? cause.message : "Request failed",
        cause,
      ),
    )
    .finally(() => inFlightRequests.delete(key));
  inFlightRequests.set(key, pending);
  return pending;
}

export function createRateLimiter(
  limit: number,
  windowMs: number,
  options: RateLimiterOptions = {},
): RateLimiter {
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError("limit and windowMs must be positive numbers");
  }
  if (options.maxQueueSize !== undefined &&
    (!Number.isInteger(options.maxQueueSize) || options.maxQueueSize < 0)) {
    throw new RangeError("maxQueueSize must be a non-negative integer");
  }

  const queue: Array<() => void> = [];
  const starts: number[] = [];
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  const maxQueueSize = options.maxQueueSize;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    while (starts.length > 0 && now - starts[0]! >= windowMs) starts.shift();
    while (queue.length > 0 && starts.length < limit) {
      starts.push(Date.now());
      queue.shift()!();
    }
    if (queue.length > 0 && starts.length > 0) {
      timer = setTimeout(drain, Math.max(1, windowMs - (Date.now() - starts[0]!)));
    }
  };

  const acquire = (): Promise<void> => {
    drain();
    if (
      maxQueueSize !== undefined &&
      queue.length >= maxQueueSize &&
      starts.length >= limit
    ) {
      return Promise.reject(new Error("Rate limiter queue is full."));
    }
    return new Promise((resolve) => {
      queue.push(resolve);
      drain();
    });
  };

  return {
    get pending() { return queue.length; },
    async execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>> {
      try {
        await acquire();
      } catch (cause) {
        return err(
          SorokitErrorCode.RATE_LIMITED,
          "Rate limiter queue is full.",
          cause,
        );
      }
      let lastCause: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return ok(await operation());
        } catch (cause) {
          lastCause = cause;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, initialBackoffMs * 2 ** attempt));
          }
        }
      }
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        lastCause instanceof Error ? lastCause.message : "Rate-limited request failed",
        lastCause,
      );
    },
  };
}

/** A bare async method, as found on an SDK client object. */
export type AsyncMethod = (...args: never[]) => Promise<unknown>;

export interface MethodRateLimitConfig {
  limit: number;
  windowMs: number;
  options?: RateLimiterOptions;
}

export interface RateLimitDecoratorConfig {
  /**
   * Applied to every method that does not have its own entry in `perMethod`.
   * Omit to leave unlisted methods completely unlimited.
   */
  default?: MethodRateLimitConfig;
  /** Overrides `default` for specific method names. */
  perMethod?: Record<string, MethodRateLimitConfig>;
}

/**
 * Wraps an object of async SDK methods so each one (per `config`) is routed
 * through a `RateLimiter` before running (#864). Each configured method gets
 * its own independent limiter and queue, so one method being saturated
 * cannot starve another's budget.
 *
 * A method whose call exceeds `maxQueueSize` (when one is configured)
 * rejects with a `SorokitError` carrying `SorokitErrorCode.RATE_LIMITED`,
 * via the same path `createRateLimiter`'s own `execute` already uses, so
 * callers that already handle a `RATE_LIMITED` result from using
 * `createRateLimiter` directly see identical error shapes here.
 *
 * Methods with no applicable config (no `perMethod` entry and no `default`)
 * are returned unwrapped and uncounted.
 *
 * There is no built-in default limit for any SDK method; rate limiting is
 * opt-in per `#864`'s own scope ("Add optional rate limiting"), applied by
 * the caller to whichever client methods they choose, not baked into
 * `createSorokitClient` itself.
 *
 * @example
 * const limitedClient = withRateLimit(
 *   { simulate: client.simulateTransaction, submit: client.submitTransaction },
 *   {
 *     // Applies to any wrapped method without its own perMethod entry.
 *     default: { limit: 20, windowMs: 1_000 },
 *     // submit is more expensive against the network, give it its own,
 *     // tighter budget instead of sharing the default.
 *     perMethod: {
 *       submit: { limit: 2, windowMs: 1_000, options: { maxQueueSize: 5 } },
 *     },
 *   },
 * );
 *
 * try {
 *   await limitedClient.submit(tx);
 * } catch (error) {
 *   if (error instanceof SorokitRateLimitError) {
 *     // error.result.error.code === SorokitErrorCode.RATE_LIMITED
 *   }
 * }
 */
export function withRateLimit<T extends Record<string, AsyncMethod>>(
  methods: T,
  config: RateLimitDecoratorConfig,
): T {
  const limiters = new Map<string, RateLimiter>();

  const limiterFor = (methodName: string): RateLimiter | undefined => {
    const existing = limiters.get(methodName);
    if (existing) return existing;

    const methodConfig = config.perMethod?.[methodName] ?? config.default;
    if (!methodConfig) return undefined;

    const limiter = createRateLimiter(methodConfig.limit, methodConfig.windowMs, methodConfig.options);
    limiters.set(methodName, limiter);
    return limiter;
  };

  const wrapped = {} as T;
  for (const key of Object.keys(methods) as Array<keyof T & string>) {
    // Non-null: key comes directly from Object.keys(methods), so the
    // property is always present; noUncheckedIndexedAccess cannot know that
    // statically for a generic Record index.
    const original: AsyncMethod = methods[key]!;
    const limiter = limiterFor(key);
    if (!limiter) {
      wrapped[key] = original as T[typeof key];
      continue;
    }

    const boundLimiter = limiter;
    wrapped[key] = (async (...args: never[]) => {
      const result = await boundLimiter.execute(() => original(...args));
      if (result.status === "ok") return result.data;
      throw new SorokitRateLimitError(key, result);
    }) as T[typeof key];
  }
  return wrapped;
}

/**
 * Thrown by a `withRateLimit`-wrapped method instead of returning a
 * `SorokitResult`, since the wrapped methods preserve the original
 * unwrapped (throwing) call signature rather than changing every method's
 * return type to `SorokitResult`. Carries the original `SorokitResult` so a
 * caller that wants the structured error (e.g. to inspect `.code`) can read
 * `error.result` instead of re-parsing `error.message`.
 */
export class SorokitRateLimitError extends Error {
  readonly methodName: string;
  readonly result: SorokitResult<unknown>;

  constructor(methodName: string, result: SorokitResult<unknown>) {
    const message =
      result.status === "error" ? `${methodName}: ${result.error.message}` : `${methodName}: rate limited`;
    super(message);
    this.name = "SorokitRateLimitError";
    this.methodName = methodName;
    this.result = result;
  }
}
