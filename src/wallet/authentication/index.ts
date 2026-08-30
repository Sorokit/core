/**
 * Wallet authentication module.
 *
 * Application-level authentication layer for wallet access control.
 * Supports WebAuthn (biometric/security key) and PIN authentication.
 *
 * @module wallet/authentication
 *
 * @example
 * import { WalletAuthenticationManager, detectAuthenticationCapabilities } from "sorokit-core";
 *
 * // Detect available authentication methods
 * const capabilities = await detectAuthenticationCapabilities();
 *
 * // Create authentication manager
 * const authManager = new WalletAuthenticationManager({
 *   sessionTimeoutMs: 900000, // 15 minutes
 * });
 *
 * // Setup authentication
 * if (capabilities.data.webauthn) {
 *   await authManager.setupWebAuthnAuthentication("wallet-123");
 * } else {
 *   await authManager.setupPINAuthentication("wallet-123", { pin: "1234" });
 * }
 *
 * // Lock wallet
 * await authManager.lock("wallet-123");
 *
 * // Unlock wallet
 * await authManager.unlock("wallet-123", { method: "PIN", pin: "1234" });
 *
 * // Check authentication before sensitive operation
 * const authCheck = await authManager.requireAuthentication("wallet-123");
 * if (authCheck.status === "ok") {
 *   // Perform wallet operation
 * }
 */

export { WalletAuthenticationManager } from "./authenticationManager";
export { detectAuthenticationCapabilities, isAuthenticationMethodAvailable } from "./capabilities";
export { setupPIN, verifyPIN, changePIN, resetPIN } from "./pinAuth";
export { registerWebAuthn, authenticateWebAuthn } from "./webAuthnAuth";
export {
  InMemoryAuthenticationStorage,
  createLocalStorageAuthenticationStorage,
} from "./storage";

export type {
  AuthenticationState,
  AuthenticationMethod,
  AuthenticationStatus,
  AuthenticationConfig,
  AuthenticationCredential,
  AuthenticationCapabilities,
  AuthenticationStorage,
  PINSetupOptions,
  PINVerificationOptions,
  PINChangeOptions,
  PINResetResult,
  PINCredentialData,
  WebAuthnRegistrationOptions,
  WebAuthnAuthenticationOptions,
  WebAuthnCredentialData,
} from "./types";
