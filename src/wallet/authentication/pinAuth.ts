/**
 * PIN-based authentication implementation.
 *
 * Provides secure PIN setup, verification, change, and reset functionality.
 * PINs are never stored in plaintext - only salted hashes are persisted.
 */

import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type {
  PINSetupOptions,
  PINVerificationOptions,
  PINChangeOptions,
  PINResetResult,
  PINCredentialData,
} from "./types";

/**
 * Validate PIN format.
 * PINs must be 4-8 digits.
 */
function validatePINFormat(pin: string): SorokitResult<void> {
  if (!/^\d{4,8}$/.test(pin)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "PIN must be 4-8 digits",
    );
  }
  return ok(undefined);
}

/**
 * Hash a PIN with salt using Web Crypto API.
 * Falls back to simple hashing if Web Crypto is unavailable.
 */
async function hashPIN(pin: string, salt: string): Promise<string> {
  const data = pin + salt;
  
  // Try Web Crypto API first (browser environment)
  if (typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined") {
    try {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall through to simple hash
    }
  }
  
  // Fallback: simple deterministic hash (not cryptographically secure, for testing only)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/**
 * Generate a random salt for PIN hashing.
 */
function generateSalt(): string {
  // Try Web Crypto API first
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues !== "undefined") {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  
  // Fallback: Math.random (not cryptographically secure, for testing only)
  return Array.from({ length: 16 }, () => 
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Setup PIN authentication.
 *
 * Creates a hashed PIN credential that can be stored securely.
 * The PIN itself is never stored - only the salted hash.
 *
 * @param options - PIN setup options
 * @returns Credential data to store, or error if PIN format is invalid
 *
 * @example
 * const result = await setupPIN({ pin: "1234", hint: "Birth year" });
 * if (result.status === "ok") {
 *   // Store result.data securely
 * }
 */
export async function setupPIN(
  options: PINSetupOptions
): Promise<SorokitResult<PINCredentialData>> {
  const validation = validatePINFormat(options.pin);
  if (validation.status === "error") {
    return validation as SorokitResult<PINCredentialData>;
  }

  const salt = generateSalt();
  const hashedPin = await hashPIN(options.pin, salt);

  const credential: PINCredentialData = {
    hashedPin,
    salt,
    ...(options.hint ? { hint: options.hint } : {}),
  };

  return ok(credential);
}

/**
 * Verify a PIN against stored credential data.
 *
 * Hashes the provided PIN with the stored salt and compares.
 * Never exposes the stored hash or salt.
 *
 * @param options - PIN verification options
 * @param storedCredential - Stored PIN credential data
 * @returns Success if PIN matches, error otherwise
 *
 * @example
 * const result = await verifyPIN({ pin: "1234" }, storedCredential);
 * if (result.status === "ok") {
 *   // Authentication successful
 * }
 */
export async function verifyPIN(
  options: PINVerificationOptions,
  storedCredential: PINCredentialData
): Promise<SorokitResult<void>> {
  const hashedInput = await hashPIN(options.pin, storedCredential.salt);
  
  if (hashedInput !== storedCredential.hashedPin) {
    return err(
      SorokitErrorCode.WALLET_SIGN_REJECTED,
      "Incorrect PIN",
    );
  }

  return ok(undefined);
}

/**
 * Change PIN authentication.
 *
 * Verifies the current PIN, then sets up a new PIN with a new salt.
 *
 * @param options - PIN change options
 * @param storedCredential - Current PIN credential data
 * @returns New credential data to store, or error if current PIN is incorrect
 *
 * @example
 * const result = await changePIN(
 *   { currentPin: "1234", newPin: "5678" },
 *   storedCredential
 * );
 * if (result.status === "ok") {
 *   // Store result.data securely
 * }
 */
export async function changePIN(
  options: PINChangeOptions,
  storedCredential: PINCredentialData
): Promise<SorokitResult<PINCredentialData>> {
  // Verify current PIN
  const verification = await verifyPIN(
    { pin: options.currentPin },
    storedCredential
  );
  if (verification.status === "error") {
    return verification as SorokitResult<PINCredentialData>;
  }

  // Setup new PIN
  return setupPIN({
    pin: options.newPin,
    hint: storedCredential.hint,
  });
}

/**
 * Reset PIN authentication.
 *
 * Removes PIN authentication entirely. This is a destructive operation
 * that should require additional verification (e.g., wallet re-connection).
 *
 * Applications should implement their own verification flow before calling this.
 *
 * @returns Reset result with success message
 *
 * @example
 * // After additional verification flow
 * const result = resetPIN();
 * console.log(result.message);
 */
export function resetPIN(): PINResetResult {
  return {
    success: true,
    message: "PIN authentication has been reset. Please setup a new PIN or use WebAuthn.",
  };
}
