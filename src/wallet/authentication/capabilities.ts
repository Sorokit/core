/**
 * Authentication capability detection.
 *
 * Detects available authentication methods in the current environment.
 */

import { ok } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type { AuthenticationCapabilities } from "./types";

/**
 * Detect available authentication capabilities in the current environment.
 *
 * Checks for WebAuthn support and specific authenticator capabilities.
 * Always returns ok() with capability flags - never fails.
 *
 * @returns Available authentication capabilities
 *
 * @example
 * const result = await detectAuthenticationCapabilities();
 * if (result.data.webauthn) {
 *   // Use WebAuthn authentication
 * } else if (result.data.pin) {
 *   // Fallback to PIN authentication
 * }
 */
export async function detectAuthenticationCapabilities(): Promise<SorokitResult<AuthenticationCapabilities>> {
  const capabilities: AuthenticationCapabilities = {
    webauthn: false,
    pin: true, // PIN is always available as fallback
  };

  // Check if running in browser environment
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return ok(capabilities);
  }

  // Check for WebAuthn API support
  const hasWebAuthn = 
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined";

  if (!hasWebAuthn) {
    return ok(capabilities);
  }

  capabilities.webauthn = true;

  // Detect specific WebAuthn capabilities
  try {
    const webauthnDetails: AuthenticationCapabilities["webauthnDetails"] = {
      platformAuthenticator: false,
      crossPlatformAuthenticator: true, // Assume cross-platform support if WebAuthn exists
      userVerification: true, // Assume user verification support
    };

    // Check for platform authenticator (Touch ID, Windows Hello, etc.)
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
      const platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      webauthnDetails.platformAuthenticator = platformAvailable;
    }

    capabilities.webauthnDetails = webauthnDetails;
  } catch (error) {
    // If capability detection fails, we still know basic WebAuthn is available
    // Set conservative defaults
    capabilities.webauthnDetails = {
      platformAuthenticator: false,
      crossPlatformAuthenticator: true,
      userVerification: false,
    };
  }

  return ok(capabilities);
}

/**
 * Check if a specific authentication method is available.
 *
 * @param method - Authentication method to check
 * @returns Whether the method is available
 *
 * @example
 * const webauthnAvailable = await isAuthenticationMethodAvailable('WEBAUTHN');
 * if (webauthnAvailable) {
 *   // Setup WebAuthn
 * }
 */
export async function isAuthenticationMethodAvailable(
  method: "WEBAUTHN" | "PIN"
): Promise<boolean> {
  const capabilities = await detectAuthenticationCapabilities();
  
  if (method === "WEBAUTHN") {
    return capabilities.data.webauthn;
  }
  
  // PIN is always available
  return true;
}
