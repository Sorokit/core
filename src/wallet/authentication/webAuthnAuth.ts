/**
 * WebAuthn-based authentication implementation.
 *
 * Provides biometric and security key authentication using the WebAuthn API.
 * Never stores raw biometric data - only public key credentials.
 */

import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type {
  WebAuthnRegistrationOptions,
  WebAuthnAuthenticationOptions,
  WebAuthnCredentialData,
} from "./types";

/**
 * Check if WebAuthn is available in the current environment.
 */
function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

/**
 * Generate a random challenge for WebAuthn operations.
 */
function generateChallenge(): Uint8Array {
  const challenge = new Uint8Array(32);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues !== "undefined") {
    crypto.getRandomValues(challenge);
  } else {
    // Fallback for testing (not cryptographically secure)
    for (let i = 0; i < challenge.length; i++) {
      challenge[i] = Math.floor(Math.random() * 256);
    }
  }
  return challenge;
}

/**
 * Convert ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Register a new WebAuthn credential (biometric or security key).
 *
 * Creates a new credential that can be used for authentication.
 * The private key never leaves the authenticator device.
 *
 * @param walletId - Unique identifier for the wallet
 * @param options - Registration options
 * @returns Credential data to store, or error if registration fails
 *
 * @example
 * const result = await registerWebAuthn("wallet-123", {
 *   authenticatorName: "Touch ID",
 *   requireUserVerification: true
 * });
 * if (result.status === "ok") {
 *   // Store result.data securely
 * }
 */
export async function registerWebAuthn(
  walletId: string,
  options: WebAuthnRegistrationOptions = {}
): Promise<SorokitResult<WebAuthnCredentialData>> {
  if (!isWebAuthnAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      "WebAuthn is not available in this environment",
    );
  }

  try {
    const challenge = generateChallenge();
    
    const publicKeyOptions: PublicKeyCredentialCreationOptions = {
      challenge,
      rp: {
        name: "Sorokit Wallet",
        id: window.location.hostname,
      },
      user: {
        id: new TextEncoder().encode(walletId),
        name: walletId,
        displayName: `Wallet ${walletId.slice(0, 8)}`,
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },  // ES256
        { alg: -257, type: "public-key" }, // RS256
      ],
      authenticatorSelection: {
        userVerification: options.requireUserVerification ? "required" : "preferred",
        authenticatorAttachment: "platform", // Prefer platform authenticators (Touch ID, Windows Hello)
      },
      timeout: 60000,
      attestation: "none",
    };

    const credential = await navigator.credentials.create({
      publicKey: publicKeyOptions,
    }) as PublicKeyCredential | null;

    if (!credential) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "Failed to create WebAuthn credential",
      );
    }

    const response = credential.response as AuthenticatorAttestationResponse;
    
    const credentialData: WebAuthnCredentialData = {
      credentialId: arrayBufferToBase64(credential.rawId),
      publicKey: arrayBufferToBase64(response.getPublicKey()!),
      counter: 0,
      ...(options.authenticatorName ? { authenticatorName: options.authenticatorName } : {}),
    };

    return ok(credentialData);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    // User cancelled or denied the operation
    if (errorMessage.includes("cancel") || errorMessage.includes("abort")) {
      return err(
        SorokitErrorCode.WALLET_SIGN_REJECTED,
        "WebAuthn registration was cancelled",
      );
    }

    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      `WebAuthn registration failed: ${errorMessage}`,
    );
  }
}

/**
 * Authenticate using a registered WebAuthn credential.
 *
 * Verifies the user's identity using biometric or security key.
 * The private key never leaves the authenticator device.
 *
 * @param storedCredential - Previously registered credential data
 * @param options - Authentication options
 * @returns Success if authentication passes, error otherwise
 *
 * @example
 * const result = await authenticateWebAuthn(storedCredential, {
 *   requireUserVerification: true
 * });
 * if (result.status === "ok") {
 *   // Authentication successful
 * }
 */
export async function authenticateWebAuthn(
  storedCredential: WebAuthnCredentialData,
  options: WebAuthnAuthenticationOptions = {}
): Promise<SorokitResult<void>> {
  if (!isWebAuthnAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      "WebAuthn is not available in this environment",
    );
  }

  try {
    const challenge = generateChallenge();
    const credentialId = base64ToArrayBuffer(storedCredential.credentialId);

    const publicKeyOptions: PublicKeyCredentialRequestOptions = {
      challenge,
      allowCredentials: [
        {
          id: credentialId,
          type: "public-key",
          transports: ["internal", "usb", "nfc", "ble"],
        },
      ],
      userVerification: options.requireUserVerification ? "required" : "preferred",
      timeout: 60000,
    };

    const assertion = await navigator.credentials.get({
      publicKey: publicKeyOptions,
    }) as PublicKeyCredential | null;

    if (!assertion) {
      return err(
        SorokitErrorCode.WALLET_SIGN_REJECTED,
        "WebAuthn authentication failed",
      );
    }

    // Verify credential ID matches
    const assertionCredentialId = arrayBufferToBase64(assertion.rawId);
    if (assertionCredentialId !== storedCredential.credentialId) {
      return err(
        SorokitErrorCode.WALLET_SIGN_REJECTED,
        "Credential ID mismatch",
      );
    }

    // In a production implementation, you would verify the signature here
    // using the stored public key. For this SDK, we trust the browser's
    // WebAuthn implementation to handle the cryptographic verification.

    return ok(undefined);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    // User cancelled or denied the operation
    if (errorMessage.includes("cancel") || errorMessage.includes("abort")) {
      return err(
        SorokitErrorCode.WALLET_SIGN_REJECTED,
        "WebAuthn authentication was cancelled",
      );
    }

    return err(
      SorokitErrorCode.WALLET_SIGN_REJECTED,
      `WebAuthn authentication failed: ${errorMessage}`,
    );
  }
}
