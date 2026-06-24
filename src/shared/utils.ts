/**
 * Shared utility functions used across sorokit-core modules.
 * Nothing here should import from any module — only from types and constants.
 */

import { StrKey } from "@stellar/stellar-sdk";
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
 * Validate a Stellar public key (Ed25519 G... address).
 *
 * Checks:
 * - Must be a non-empty string
 * - Must start with 'G'
 * - Must be exactly 56 characters (base32-encoded with version byte)
 * - Must contain only valid base32 characters (A-Z, 2-7)
 * - Must pass checksum validation via the Stellar SDK
 *
 * Uses `StrKey.isValidEd25519PublicKey()` from `@stellar/stellar-sdk`,
 * which performs full format, length, and CRC-16 checksum validation.
 */
export function isValidPublicKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
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
