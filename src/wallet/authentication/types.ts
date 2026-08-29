/**
 * Wallet authentication types and interfaces.
 *
 * Provides application-level authentication layer around wallet access
 * using WebAuthn where available, with PIN-based fallback.
 */

import type { SorokitResult } from "../../shared/response";

/**
 * Authentication state for a wallet session.
 */
export enum AuthenticationState {
  /** Authentication has not been initialized */
  UNINITIALIZED = "UNINITIALIZED",
  /** Wallet is locked and requires authentication */
  LOCKED = "LOCKED",
  /** Wallet is unlocked and operations are permitted */
  UNLOCKED = "UNLOCKED",
  /** Authentication session has expired */
  EXPIRED = "EXPIRED",
}

/**
 * Authentication method available for wallet access.
 */
export enum AuthenticationMethod {
  /** WebAuthn (biometric or security key) */
  WEBAUTHN = "WEBAUTHN",
  /** PIN-based authentication */
  PIN = "PIN",
  /** No authentication configured */
  NONE = "NONE",
}

/**
 * Current authentication status and metadata.
 */
export interface AuthenticationStatus {
  /** Current state of authentication */
  state: AuthenticationState;
  /** Authentication method currently in use */
  method: AuthenticationMethod;
  /** When the current session was authenticated (ISO 8601) */
  authenticatedAt: string | null;
  /** When the current session will expire (ISO 8601) */
  expiresAt: string | null;
  /** Number of consecutive failed authentication attempts */
  failedAttempts: number;
  /** When the next authentication attempt is allowed (ISO 8601), null if not rate-limited */
  nextAttemptAllowedAt: string | null;
}

/**
 * Configuration for authentication setup.
 */
export interface AuthenticationConfig {
  /** Session timeout in milliseconds (default: 15 minutes) */
  sessionTimeoutMs?: number;
  /** Maximum failed attempts before rate limiting (default: 5) */
  maxFailedAttempts?: number;
  /** Rate limit duration in milliseconds after max failed attempts (default: 5 minutes) */
  rateLimitDurationMs?: number;
  /** Preferred authentication method (will fallback if unavailable) */
  preferredMethod?: AuthenticationMethod;
}

/**
 * Options for PIN setup.
 */
export interface PINSetupOptions {
  /** The PIN to set (must be 4-8 digits) */
  pin: string;
  /** Optional hint for PIN recovery (should not reveal the PIN) */
  hint?: string;
}

/**
 * Options for PIN verification.
 */
export interface PINVerificationOptions {
  /** The PIN to verify */
  pin: string;
}

/**
 * Options for PIN change.
 */
export interface PINChangeOptions {
  /** Current PIN */
  currentPin: string;
  /** New PIN (must be 4-8 digits) */
  newPin: string;
}

/**
 * Result of PIN reset operation.
 */
export interface PINResetResult {
  /** Whether reset was successful */
  success: boolean;
  /** Message describing the reset outcome */
  message: string;
}

/**
 * WebAuthn credential options for registration.
 */
export interface WebAuthnRegistrationOptions {
  /** User-friendly name for the authenticator */
  authenticatorName?: string;
  /** Require user verification (biometric/PIN on authenticator) */
  requireUserVerification?: boolean;
}

/**
 * WebAuthn credential options for authentication.
 */
export interface WebAuthnAuthenticationOptions {
  /** Require user verification (biometric/PIN on authenticator) */
  requireUserVerification?: boolean;
}

/**
 * Stored authentication credential (never contains raw biometric data or private keys).
 */
export interface AuthenticationCredential {
  /** Unique identifier for this credential */
  id: string;
  /** Authentication method for this credential */
  method: AuthenticationMethod;
  /** When this credential was created (ISO 8601) */
  createdAt: string;
  /** When this credential was last used (ISO 8601) */
  lastUsedAt: string | null;
  /** Method-specific credential data (hashed/encrypted) */
  data: WebAuthnCredentialData | PINCredentialData;
}

/**
 * WebAuthn-specific credential data (stored securely).
 */
export interface WebAuthnCredentialData {
  /** Public key credential ID (base64) */
  credentialId: string;
  /** Public key (base64) - never stores private key */
  publicKey: string;
  /** Authenticator counter for replay protection */
  counter: number;
  /** User-friendly authenticator name */
  authenticatorName?: string;
}

/**
 * PIN-specific credential data (stored securely).
 */
export interface PINCredentialData {
  /** Hashed PIN (never stores plaintext) */
  hashedPin: string;
  /** Salt for PIN hashing */
  salt: string;
  /** Optional hint for PIN recovery */
  hint?: string;
}

/**
 * Authentication capability detection result.
 */
export interface AuthenticationCapabilities {
  /** Whether WebAuthn is available in this environment */
  webauthn: boolean;
  /** Whether PIN authentication is available */
  pin: boolean;
  /** Specific WebAuthn capabilities if available */
  webauthnDetails?: {
    /** Platform authenticator available (e.g., Touch ID, Windows Hello) */
    platformAuthenticator: boolean;
    /** Cross-platform authenticator support (e.g., USB security key) */
    crossPlatformAuthenticator: boolean;
    /** User verification supported */
    userVerification: boolean;
  };
}

/**
 * Storage adapter for authentication credentials.
 * Implementations must ensure secure storage without exposing sensitive data.
 */
export interface AuthenticationStorage {
  /**
   * Store authentication credential securely.
   * @param walletId - Wallet identifier
   * @param credential - Credential to store
   */
  storeCredential(walletId: string, credential: AuthenticationCredential): Promise<SorokitResult<void>>;

  /**
   * Retrieve authentication credential for a wallet.
   * @param walletId - Wallet identifier
   */
  getCredential(walletId: string): Promise<SorokitResult<AuthenticationCredential | null>>;

  /**
   * Remove authentication credential for a wallet.
   * @param walletId - Wallet identifier
   */
  removeCredential(walletId: string): Promise<SorokitResult<void>>;

  /**
   * Store authentication session state.
   * @param walletId - Wallet identifier
   * @param status - Current authentication status
   */
  storeSession(walletId: string, status: AuthenticationStatus): Promise<SorokitResult<void>>;

  /**
   * Retrieve authentication session state.
   * @param walletId - Wallet identifier
   */
  getSession(walletId: string): Promise<SorokitResult<AuthenticationStatus | null>>;

  /**
   * Clear authentication session state.
   * @param walletId - Wallet identifier
   */
  clearSession(walletId: string): Promise<SorokitResult<void>>;
}
