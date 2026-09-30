import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RateLimiterOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
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

  const queue: Array<() => void> = [];
  const starts: number[] = [];
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = (): void => {
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

  const acquire = (): Promise<void> => new Promise((resolve) => {
    queue.push(resolve);
    drain();
  });

  return {
    get pending() { return queue.length; },
    async execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>> {
      await acquire();
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
