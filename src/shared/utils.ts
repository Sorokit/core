/**
 * Shared utility functions used across sorokit-core modules.
 * Nothing here should import from any module — only from types and constants.
 */

import { DEFAULT_ADDRESS_DISPLAY_CHARS } from "./constants";

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
 * In-flight request registry for deduplication.
 * Exported only for testing — callers should not interact with it directly.
 */
export const _inflightRequests = new Map<string, Promise<unknown>>();

/**
 * Deduplicate concurrent identical API calls.
 *
 * When two or more callers invoke the same async function with the same
 * parameters simultaneously, only a single underlying call is made. All
 * concurrent callers await the same Promise and receive the same result.
 * Once the Promise settles (resolves or rejects), it is removed from the
 * registry so the next call triggers a fresh request.
 *
 * Cache key is a stable JSON serialisation of `(funcName, params)`. Values
 * that cannot be serialised (e.g. circular refs) fall back to `String()`.
 *
 * @param funcName  Logical name of the operation (used as part of the key).
 * @param params    Parameters passed to the function (must be serialisable).
 * @param fn        The async function to deduplicate.
 * @returns         A Promise that resolves with the function's return value.
 */
export function deduplicateRequest<T>(
  funcName: string,
  params: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  let paramsStr: string;
  try {
    paramsStr = JSON.stringify(params);
  } catch {
    paramsStr = String(params);
  }

  const key = `${funcName}:${paramsStr}`;

  const existing = _inflightRequests.get(key);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    _inflightRequests.delete(key);
  });

  _inflightRequests.set(key, promise);
  return promise;
}
