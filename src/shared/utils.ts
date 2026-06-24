/**
 * Shared utility functions used across sorokit-core modules.
 * Nothing here should import from any module — only from types and constants.
 */

import { DEFAULT_ADDRESS_DISPLAY_CHARS } from "./constants";
import { isTransientError } from "./errors";

/**
 * Detect whether we are running in a browser environment.
 * Wallet extensions are browser-only — this guard prevents crashes in Node.
 */
export function isBrowser(): boolean {
  return typeof window !== "undefined";
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
