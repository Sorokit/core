import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RetryPolicyOptions { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (delayMs: number) => Promise<void>; shouldRetry?: (error: unknown, attempt: number) => boolean; }
export interface RetryPolicy { <T>(operation: (attempt: number) => Promise<SorokitResult<T>>): Promise<SorokitResult<T>>; run<T>(operation: (attempt: number) => Promise<SorokitResult<T>>): Promise<SorokitResult<T>>; }
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry failed Sorokit operations with bounded exponential backoff. */
export function createRetryPolicy(maxAttemptsOrOptions: number | RetryPolicyOptions = 3, baseDelayMs = 250): RetryPolicy {
  const options = typeof maxAttemptsOrOptions === "number" ? { maxAttempts: maxAttemptsOrOptions, baseDelayMs } : maxAttemptsOrOptions;
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelay = options.baseDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 30_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  if (!Number.isFinite(initialDelay) || initialDelay < 0 || !Number.isFinite(maxDelay) || maxDelay < initialDelay) throw new Error("backoff delays are invalid");
  const run = async <T>(operation: (attempt: number) => Promise<SorokitResult<T>>): Promise<SorokitResult<T>> => {
    let last: SorokitResult<T> | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try { last = await operation(attempt); } catch (cause) { last = err(SorokitErrorCode.NETWORK_ERROR, cause instanceof Error ? cause.message : String(cause), cause); }
      if (last.status === "ok") return last;
      if (attempt === maxAttempts || options.shouldRetry?.(last.error, attempt) === false) return last;
      await (options.sleep ?? defaultSleep)(Math.min(maxDelay, initialDelay * 2 ** (attempt - 1)));
    }
    return last!;
  };
  const policy = run as RetryPolicy;
  policy.run = run;
  return policy;
}
