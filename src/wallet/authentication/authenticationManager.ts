/**
 * Wallet authentication manager.
 *
 * Coordinates authentication flows, rate limiting, and session management.
 * Supports WebAuthn and PIN authentication with automatic fallback.
 */

import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type {
  AuthenticationConfig,
  AuthenticationStatus,
  AuthenticationState,
  AuthenticationMethod,
  AuthenticationCredential,
  AuthenticationStorage,
  PINSetupOptions,
  PINVerificationOptions,
  PINChangeOptions,
  PINResetResult,
  WebAuthnRegistrationOptions,
  WebAuthnAuthenticationOptions,
  PINCredentialData,
  WebAuthnCredentialData,
} from "./types";
import { detectAuthenticationCapabilities } from "./capabilities";
import { setupPIN, verifyPIN, changePIN, resetPIN } from "./pinAuth";
import { registerWebAuthn, authenticateWebAuthn } from "./webAuthnAuth";
import { InMemoryAuthenticationStorage } from "./storage";

const DEFAULT_CONFIG: Required<Omit<AuthenticationConfig, "preferredMethod">> = {
  sessionTimeoutMs: 15 * 60 * 1000, // 15 minutes
  maxFailedAttempts: 5,
  rateLimitDurationMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Authentication manager for wallet access control.
 *
 * Provides a complete authentication layer with:
 * - WebAuthn (biometric/security key) where available
 * - PIN fallback authentication
 * - Rate limiting for failed attempts
 * - Session management with expiration
 * - Secure credential storage
 *
 * @example
 * const manager = new WalletAuthenticationManager({
 *   sessionTimeoutMs: 900000, // 15 minutes
 * });
 *
 * // Setup authentication
 * await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
 *
 * // Lock wallet
 * await manager.lock("wallet-123");
 *
 * // Unlock with PIN
 * await manager.unlock("wallet-123", { method: "PIN", pin: "1234" });
 *
 * // Check if unlocked
 * const status = await manager.getStatus("wallet-123");
 * if (status.data.state === "UNLOCKED") {
 *   // Perform sensitive operation
 * }
 */
export class WalletAuthenticationManager {
  private config: Required<Omit<AuthenticationConfig, "preferredMethod">>;
  private storage: AuthenticationStorage;

  constructor(
    config: AuthenticationConfig = {},
    storage?: AuthenticationStorage
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.storage = storage ?? new InMemoryAuthenticationStorage();
  }

  /**
   * Get current authentication status for a wallet.
   *
   * Checks if the wallet is locked, unlocked, or expired.
   * Updates state to EXPIRED if session timeout has passed.
   *
   * @param walletId - Wallet identifier
   * @returns Current authentication status
   */
  async getStatus(walletId: string): Promise<SorokitResult<AuthenticationStatus>> {
    const sessionResult = await this.storage.getSession(walletId);
    if (sessionResult.status === "error") {
      return sessionResult;
    }

    let status = sessionResult.data;

    // If no session exists, check if credential is configured
    if (!status) {
      const credentialResult = await this.storage.getCredential(walletId);
      if (credentialResult.status === "error") {
        return credentialResult as SorokitResult<AuthenticationStatus>;
      }

      const hasCredential = credentialResult.data !== null;
      const method = hasCredential ? credentialResult.data!.method : AuthenticationMethod.NONE;

      status = {
        state: hasCredential ? AuthenticationState.LOCKED : AuthenticationState.UNINITIALIZED,
        method,
        authenticatedAt: null,
        expiresAt: null,
        failedAttempts: 0,
        nextAttemptAllowedAt: null,
      };
    }

    // Check if session has expired
    if (
      status.state === AuthenticationState.UNLOCKED &&
      status.expiresAt &&
      new Date(status.expiresAt) <= new Date()
    ) {
      status = {
        ...status,
        state: AuthenticationState.EXPIRED,
      };
      await this.storage.storeSession(walletId, status);
    }

    return ok(status);
  }

  /**
   * Setup PIN authentication for a wallet.
   *
   * Creates a hashed PIN credential that can be used for authentication.
   * The PIN itself is never stored.
   *
   * @param walletId - Wallet identifier
   * @param options - PIN setup options
   * @returns Success or error
   */
  async setupPINAuthentication(
    walletId: string,
    options: PINSetupOptions
  ): Promise<SorokitResult<void>> {
    const pinDataResult = await setupPIN(options);
    if (pinDataResult.status === "error") {
      return pinDataResult as SorokitResult<void>;
    }

    const credential: AuthenticationCredential = {
      id: `pin-${walletId}-${Date.now()}`,
      method: AuthenticationMethod.PIN,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      data: pinDataResult.data,
    };

    const storeResult = await this.storage.storeCredential(walletId, credential);
    if (storeResult.status === "error") {
      return storeResult;
    }

    // Update session to locked state
    await this.storage.storeSession(walletId, {
      state: AuthenticationState.LOCKED,
      method: AuthenticationMethod.PIN,
      authenticatedAt: null,
      expiresAt: null,
      failedAttempts: 0,
      nextAttemptAllowedAt: null,
    });

    return ok(undefined);
  }

  /**
   * Setup WebAuthn authentication for a wallet.
   *
   * Registers a new biometric or security key credential.
   * Falls back to error if WebAuthn is not available.
   *
   * @param walletId - Wallet identifier
   * @param options - WebAuthn registration options
   * @returns Success or error
   */
  async setupWebAuthnAuthentication(
    walletId: string,
    options: WebAuthnRegistrationOptions = {}
  ): Promise<SorokitResult<void>> {
    const capabilities = await detectAuthenticationCapabilities();
    if (!capabilities.data.webauthn) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "WebAuthn is not available in this environment",
      );
    }

    const webAuthnDataResult = await registerWebAuthn(walletId, options);
    if (webAuthnDataResult.status === "error") {
      return webAuthnDataResult as SorokitResult<void>;
    }

    const credential: AuthenticationCredential = {
      id: `webauthn-${walletId}-${Date.now()}`,
      method: AuthenticationMethod.WEBAUTHN,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      data: webAuthnDataResult.data,
    };

    const storeResult = await this.storage.storeCredential(walletId, credential);
    if (storeResult.status === "error") {
      return storeResult;
    }

    // Update session to locked state
    await this.storage.storeSession(walletId, {
      state: AuthenticationState.LOCKED,
      method: AuthenticationMethod.WEBAUTHN,
      authenticatedAt: null,
      expiresAt: null,
      failedAttempts: 0,
      nextAttemptAllowedAt: null,
    });

    return ok(undefined);
  }

  /**
   * Unlock a wallet using the configured authentication method.
   *
   * Performs rate limiting and session management.
   * Updates authentication status on success.
   *
   * @param walletId - Wallet identifier
   * @param options - Authentication options
   * @returns Success or error
   */
  async unlock(
    walletId: string,
    options: { method: AuthenticationMethod; pin?: string }
  ): Promise<SorokitResult<void>> {
    const statusResult = await this.getStatus(walletId);
    if (statusResult.status === "error") {
      return statusResult as SorokitResult<void>;
    }

    const status = statusResult.data;

    // Check rate limiting
    if (status.nextAttemptAllowedAt) {
      const now = new Date();
      const nextAttempt = new Date(status.nextAttemptAllowedAt);
      if (now < nextAttempt) {
        const secondsRemaining = Math.ceil((nextAttempt.getTime() - now.getTime()) / 1000);
        return err(
          SorokitErrorCode.WALLET_SIGN_REJECTED,
          `Too many failed attempts. Try again in ${secondsRemaining} seconds.`,
        );
      }
    }

    // Get stored credential
    const credentialResult = await this.storage.getCredential(walletId);
    if (credentialResult.status === "error") {
      return credentialResult as SorokitResult<void>;
    }

    const credential = credentialResult.data;
    if (!credential) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        "No authentication configured for this wallet",
      );
    }

    // Verify authentication based on method
    let authResult: SorokitResult<void>;

    if (options.method === AuthenticationMethod.PIN) {
      if (!options.pin) {
        return err(SorokitErrorCode.INVALID_CONFIG, "PIN is required");
      }
      authResult = await verifyPIN(
        { pin: options.pin },
        credential.data as PINCredentialData
      );
    } else if (options.method === AuthenticationMethod.WEBAUTHN) {
      authResult = await authenticateWebAuthn(
        credential.data as WebAuthnCredentialData,
        {}
      );
    } else {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Unsupported authentication method: ${options.method}`,
      );
    }

    // Handle authentication result
    if (authResult.status === "error") {
      // Increment failed attempts
      const newFailedAttempts = status.failedAttempts + 1;
      const isRateLimited = newFailedAttempts >= this.config.maxFailedAttempts;

      await this.storage.storeSession(walletId, {
        ...status,
        failedAttempts: newFailedAttempts,
        nextAttemptAllowedAt: isRateLimited
          ? new Date(Date.now() + this.config.rateLimitDurationMs).toISOString()
          : null,
      });

      return authResult;
    }

    // Authentication successful
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.sessionTimeoutMs);

    await this.storage.storeSession(walletId, {
      state: AuthenticationState.UNLOCKED,
      method: credential.method,
      authenticatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      failedAttempts: 0,
      nextAttemptAllowedAt: null,
    });

    // Update credential last used time
    await this.storage.storeCredential(walletId, {
      ...credential,
      lastUsedAt: now.toISOString(),
    });

    return ok(undefined);
  }

  /**
   * Lock a wallet, requiring authentication to unlock.
   *
   * Clears the current session and sets state to LOCKED.
   *
   * @param walletId - Wallet identifier
   * @returns Success or error
   */
  async lock(walletId: string): Promise<SorokitResult<void>> {
    const statusResult = await this.getStatus(walletId);
    if (statusResult.status === "error") {
      return statusResult as SorokitResult<void>;
    }

    const status = statusResult.data;

    await this.storage.storeSession(walletId, {
      ...status,
      state: AuthenticationState.LOCKED,
      authenticatedAt: null,
      expiresAt: null,
    });

    return ok(undefined);
  }

  /**
   * Change PIN for a wallet.
   *
   * Verifies the current PIN before setting a new one.
   *
   * @param walletId - Wallet identifier
   * @param options - PIN change options
   * @returns Success or error
   */
  async changePINAuthentication(
    walletId: string,
    options: PINChangeOptions
  ): Promise<SorokitResult<void>> {
    const credentialResult = await this.storage.getCredential(walletId);
    if (credentialResult.status === "error") {
      return credentialResult as SorokitResult<void>;
    }

    const credential = credentialResult.data;
    if (!credential || credential.method !== AuthenticationMethod.PIN) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        "No PIN authentication configured for this wallet",
      );
    }

    const newPinDataResult = await changePIN(
      options,
      credential.data as PINCredentialData
    );
    if (newPinDataResult.status === "error") {
      return newPinDataResult as SorokitResult<void>;
    }

    const updatedCredential: AuthenticationCredential = {
      ...credential,
      data: newPinDataResult.data,
      lastUsedAt: new Date().toISOString(),
    };

    return this.storage.storeCredential(walletId, updatedCredential);
  }

  /**
   * Reset authentication for a wallet.
   *
   * Removes all credentials and sessions.
   * Wallet will need to be re-authenticated.
   *
   * @param walletId - Wallet identifier
   * @returns Reset result
   */
  async resetAuthentication(walletId: string): Promise<SorokitResult<PINResetResult>> {
    await this.storage.removeCredential(walletId);
    await this.storage.clearSession(walletId);

    return ok(resetPIN());
  }

  /**
   * Require authentication before proceeding.
   *
   * Checks if the wallet is unlocked. If not, returns an error.
   * Use this before sensitive wallet operations.
   *
   * @param walletId - Wallet identifier
   * @returns Success if unlocked, error otherwise
   *
   * @example
   * const authCheck = await manager.requireAuthentication("wallet-123");
   * if (authCheck.status === "error") {
   *   // Prompt user to unlock wallet
   *   return authCheck;
   * }
   * // Proceed with sensitive operation
   */
  async requireAuthentication(walletId: string): Promise<SorokitResult<void>> {
    const statusResult = await this.getStatus(walletId);
    if (statusResult.status === "error") {
      return statusResult as SorokitResult<void>;
    }

    const status = statusResult.data;

    if (status.state !== AuthenticationState.UNLOCKED) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        `Wallet is ${status.state.toLowerCase()}. Please authenticate to continue.`,
      );
    }

    return ok(undefined);
  }
}
