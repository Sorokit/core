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
 * Validate a Stellar public key.
 *
 * Uses the Stellar SDK's full validation which checks:
 * - Non-null / non-empty input
 * - Correct base32 encoding (valid alphabet, no padding issues)
 * - Correct version byte (G… prefix = 0x30 = Ed25519 public key)
 * - Correct length (56 characters, 32-byte payload)
 * - Valid CRC-16 checksum
 *
 * Rejects anything that would fail when passed to Horizon — empty strings,
 * wrong length, invalid characters, wrong prefix, and keys with a valid
 * format but an incorrect checksum.
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
 * Uses the Stellar SDK's full base32 + checksum validation.
 */
export function isValidContractId(id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
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
