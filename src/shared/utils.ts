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
 * Deep equality check using JSON serialisation.
 * Sufficient for plain data objects with no circular references or functions.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
