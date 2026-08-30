/**
 * Tests for wallet authentication module (issue #500).
 *
 * Covers WebAuthn, PIN authentication, rate limiting, session management,
 * and fallback behavior.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WalletAuthenticationManager,
  detectAuthenticationCapabilities,
  isAuthenticationMethodAvailable,
  setupPIN,
  verifyPIN,
  changePIN,
  resetPIN,
  InMemoryAuthenticationStorage,
  AuthenticationState,
  AuthenticationMethod,
} from "../wallet/authentication";
import { SorokitErrorCode } from "../shared/response";

describe("Authentication Capabilities", () => {
  it("detects PIN is always available", async () => {
    const result = await detectAuthenticationCapabilities();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.pin).toBe(true);
    }
  });

  it("detects WebAuthn is not available in Node", async () => {
    const result = await detectAuthenticationCapabilities();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.webauthn).toBe(false);
    }
  });

  it("isAuthenticationMethodAvailable returns true for PIN", async () => {
    const available = await isAuthenticationMethodAvailable("PIN");
    expect(available).toBe(true);
  });

  it("isAuthenticationMethodAvailable returns false for WebAuthn in Node", async () => {
    const available = await isAuthenticationMethodAvailable("WEBAUTHN");
    expect(available).toBe(false);
  });
});

describe("PIN Authentication", () => {
  describe("setupPIN", () => {
    it("creates valid PIN credential for 4-digit PIN", async () => {
      const result = await setupPIN({ pin: "1234" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.hashedPin).toBeTruthy();
        expect(result.data.salt).toBeTruthy();
        expect(result.data.hashedPin).not.toBe("1234"); // PIN is hashed
      }
    });

    it("creates valid PIN credential for 8-digit PIN", async () => {
      const result = await setupPIN({ pin: "12345678" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.hashedPin).toBeTruthy();
      }
    });

    it("includes hint when provided", async () => {
      const result = await setupPIN({ pin: "1234", hint: "Birth year" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.hint).toBe("Birth year");
      }
    });

    it("rejects PIN with less than 4 digits", async () => {
      const result = await setupPIN({ pin: "123" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(result.error.message).toContain("4-8 digits");
      }
    });

    it("rejects PIN with more than 8 digits", async () => {
      const result = await setupPIN({ pin: "123456789" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("rejects PIN with non-numeric characters", async () => {
      const result = await setupPIN({ pin: "12a4" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("generates different hashes for same PIN with different salts", async () => {
      const result1 = await setupPIN({ pin: "1234" });
      const result2 = await setupPIN({ pin: "1234" });
      
      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      
      if (result1.status === "ok" && result2.status === "ok") {
        expect(result1.data.salt).not.toBe(result2.data.salt);
        expect(result1.data.hashedPin).not.toBe(result2.data.hashedPin);
      }
    });
  });

  describe("verifyPIN", () => {
    it("verifies correct PIN successfully", async () => {
      const setupResult = await setupPIN({ pin: "1234" });
      expect(setupResult.status).toBe("ok");
      if (setupResult.status === "ok") {
        const verifyResult = await verifyPIN({ pin: "1234" }, setupResult.data);
        expect(verifyResult.status).toBe("ok");
      }
    });

    it("rejects incorrect PIN", async () => {
      const setupResult = await setupPIN({ pin: "1234" });
      expect(setupResult.status).toBe("ok");
      if (setupResult.status === "ok") {
        const verifyResult = await verifyPIN({ pin: "5678" }, setupResult.data);
        expect(verifyResult.status).toBe("error");
        if (verifyResult.status === "error") {
          expect(verifyResult.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
          expect(verifyResult.error.message).toContain("Incorrect PIN");
        }
      }
    });
  });

  describe("changePIN", () => {
    it("changes PIN successfully with correct current PIN", async () => {
      const setupResult = await setupPIN({ pin: "1234", hint: "Old hint" });
      expect(setupResult.status).toBe("ok");
      if (setupResult.status === "ok") {
        const changeResult = await changePIN(
          { currentPin: "1234", newPin: "5678" },
          setupResult.data
        );
        expect(changeResult.status).toBe("ok");
        
        if (changeResult.status === "ok") {
          // Verify old PIN no longer works
          const verifyOld = await verifyPIN({ pin: "1234" }, changeResult.data);
          expect(verifyOld.status).toBe("error");
          
          // Verify new PIN works
          const verifyNew = await verifyPIN({ pin: "5678" }, changeResult.data);
          expect(verifyNew.status).toBe("ok");
          
          // Hint is preserved
          expect(changeResult.data.hint).toBe("Old hint");
        }
      }
    });

    it("rejects PIN change with incorrect current PIN", async () => {
      const setupResult = await setupPIN({ pin: "1234" });
      expect(setupResult.status).toBe("ok");
      if (setupResult.status === "ok") {
        const changeResult = await changePIN(
          { currentPin: "9999", newPin: "5678" },
          setupResult.data
        );
        expect(changeResult.status).toBe("error");
        if (changeResult.status === "error") {
          expect(changeResult.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
        }
      }
    });

    it("rejects PIN change with invalid new PIN format", async () => {
      const setupResult = await setupPIN({ pin: "1234" });
      expect(setupResult.status).toBe("ok");
      if (setupResult.status === "ok") {
        const changeResult = await changePIN(
          { currentPin: "1234", newPin: "123" }, // Too short
          setupResult.data
        );
        expect(changeResult.status).toBe("error");
        if (changeResult.status === "error") {
          expect(changeResult.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        }
      }
    });
  });

  describe("resetPIN", () => {
    it("returns success result", () => {
      const result = resetPIN();
      expect(result.success).toBe(true);
      expect(result.message).toContain("reset");
    });
  });
});

describe("WalletAuthenticationManager", () => {
  let manager: WalletAuthenticationManager;
  let storage: InMemoryAuthenticationStorage;

  beforeEach(() => {
    storage = new InMemoryAuthenticationStorage();
    manager = new WalletAuthenticationManager(
      {
        sessionTimeoutMs: 1000, // 1 second for testing
        maxFailedAttempts: 3,
        rateLimitDurationMs: 5000, // 5 seconds
      },
      storage
    );
  });

  describe("Initial State", () => {
    it("returns UNINITIALIZED state for wallet without authentication", async () => {
      const result = await manager.getStatus("wallet-123");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.state).toBe(AuthenticationState.UNINITIALIZED);
        expect(result.data.method).toBe(AuthenticationMethod.NONE);
        expect(result.data.failedAttempts).toBe(0);
      }
    });
  });

  describe("PIN Setup and Authentication", () => {
    it("sets up PIN authentication successfully", async () => {
      const setupResult = await manager.setupPINAuthentication("wallet-123", {
        pin: "1234",
      });
      expect(setupResult.status).toBe("ok");

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.LOCKED);
        expect(statusResult.data.method).toBe(AuthenticationMethod.PIN);
      }
    });

    it("unlocks wallet with correct PIN", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const unlockResult = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });
      expect(unlockResult.status).toBe("ok");

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.UNLOCKED);
        expect(statusResult.data.authenticatedAt).toBeTruthy();
        expect(statusResult.data.expiresAt).toBeTruthy();
        expect(statusResult.data.failedAttempts).toBe(0);
      }
    });

    it("rejects unlock with incorrect PIN", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const unlockResult = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "9999",
      });
      expect(unlockResult.status).toBe("error");
      if (unlockResult.status === "error") {
        expect(unlockResult.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.LOCKED);
        expect(statusResult.data.failedAttempts).toBe(1);
      }
    });

    it("requires PIN parameter for PIN authentication", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const unlockResult = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        // pin is missing
      });
      expect(unlockResult.status).toBe("error");
      if (unlockResult.status === "error") {
        expect(unlockResult.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });
  });

  describe("Rate Limiting", () => {
    it("rate limits after max failed attempts", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      // Attempt 3 failed unlocks (maxFailedAttempts = 3)
      for (let i = 0; i < 3; i++) {
        await manager.unlock("wallet-123", {
          method: AuthenticationMethod.PIN,
          pin: "9999",
        });
      }

      // Fourth attempt should be rate limited
      const unlockResult = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234", // Even correct PIN is rejected
      });
      expect(unlockResult.status).toBe("error");
      if (unlockResult.status === "error") {
        expect(unlockResult.error.message).toContain("Too many failed attempts");
        expect(unlockResult.error.message).toContain("Try again in");
      }

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.failedAttempts).toBe(3);
        expect(statusResult.data.nextAttemptAllowedAt).toBeTruthy();
      }
    });

    it("resets failed attempts after successful unlock", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      // One failed attempt
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "9999",
      });

      // Successful unlock
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.failedAttempts).toBe(0);
        expect(statusResult.data.nextAttemptAllowedAt).toBeNull();
      }
    });
  });

  describe("Session Management", () => {
    it("locks wallet and clears authentication", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      const lockResult = await manager.lock("wallet-123");
      expect(lockResult.status).toBe("ok");

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.LOCKED);
        expect(statusResult.data.authenticatedAt).toBeNull();
        expect(statusResult.data.expiresAt).toBeNull();
      }
    });

    it("expires session after timeout", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      // Wait for session timeout (1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.EXPIRED);
      }
    });

    it("requireAuthentication succeeds when unlocked", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      const authCheck = await manager.requireAuthentication("wallet-123");
      expect(authCheck.status).toBe("ok");
    });

    it("requireAuthentication fails when locked", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const authCheck = await manager.requireAuthentication("wallet-123");
      expect(authCheck.status).toBe("error");
      if (authCheck.status === "error") {
        expect(authCheck.error.code).toBe(SorokitErrorCode.WALLET_NOT_CONNECTED);
        expect(authCheck.error.message).toContain("locked");
      }
    });

    it("requireAuthentication fails when expired", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      // Wait for session timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const authCheck = await manager.requireAuthentication("wallet-123");
      expect(authCheck.status).toBe("error");
      if (authCheck.status === "error") {
        expect(authCheck.error.message).toContain("expired");
      }
    });
  });

  describe("PIN Change", () => {
    it("changes PIN successfully", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const changeResult = await manager.changePINAuthentication("wallet-123", {
        currentPin: "1234",
        newPin: "5678",
      });
      expect(changeResult.status).toBe("ok");

      // Old PIN should not work
      const unlockOld = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });
      expect(unlockOld.status).toBe("error");

      // New PIN should work
      const unlockNew = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "5678",
      });
      expect(unlockNew.status).toBe("ok");
    });

    it("rejects PIN change with incorrect current PIN", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const changeResult = await manager.changePINAuthentication("wallet-123", {
        currentPin: "9999",
        newPin: "5678",
      });
      expect(changeResult.status).toBe("error");
    });

    it("rejects PIN change when no PIN is configured", async () => {
      const changeResult = await manager.changePINAuthentication("wallet-123", {
        currentPin: "1234",
        newPin: "5678",
      });
      expect(changeResult.status).toBe("error");
      if (changeResult.status === "error") {
        expect(changeResult.error.code).toBe(SorokitErrorCode.WALLET_NOT_FOUND);
      }
    });
  });

  describe("Authentication Reset", () => {
    it("resets authentication and clears all data", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      const resetResult = await manager.resetAuthentication("wallet-123");
      expect(resetResult.status).toBe("ok");
      if (resetResult.status === "ok") {
        expect(resetResult.data.success).toBe(true);
      }

      const statusResult = await manager.getStatus("wallet-123");
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.UNINITIALIZED);
        expect(statusResult.data.method).toBe(AuthenticationMethod.NONE);
      }
    });
  });

  describe("WebAuthn Setup", () => {
    it("rejects WebAuthn setup in Node environment", async () => {
      const setupResult = await manager.setupWebAuthnAuthentication("wallet-123");
      expect(setupResult.status).toBe("error");
      if (setupResult.status === "error") {
        expect(setupResult.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });
  });

  describe("Error Handling", () => {
    it("returns error when unlocking wallet without authentication setup", async () => {
      const unlockResult = await manager.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });
      expect(unlockResult.status).toBe("error");
      if (unlockResult.status === "error") {
        expect(unlockResult.error.code).toBe(SorokitErrorCode.WALLET_NOT_FOUND);
      }
    });

    it("returns error for unsupported authentication method", async () => {
      await manager.setupPINAuthentication("wallet-123", { pin: "1234" });

      const unlockResult = await manager.unlock("wallet-123", {
        method: "INVALID" as AuthenticationMethod,
      });
      expect(unlockResult.status).toBe("error");
      if (unlockResult.status === "error") {
        expect(unlockResult.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });
  });

  describe("Storage Integration", () => {
    it("persists authentication state across manager instances", async () => {
      const manager1 = new WalletAuthenticationManager({}, storage);
      await manager1.setupPINAuthentication("wallet-123", { pin: "1234" });
      await manager1.unlock("wallet-123", {
        method: AuthenticationMethod.PIN,
        pin: "1234",
      });

      // Create new manager with same storage
      const manager2 = new WalletAuthenticationManager({}, storage);
      const statusResult = await manager2.getStatus("wallet-123");
      
      expect(statusResult.status).toBe("ok");
      if (statusResult.status === "ok") {
        expect(statusResult.data.state).toBe(AuthenticationState.UNLOCKED);
        expect(statusResult.data.method).toBe(AuthenticationMethod.PIN);
      }
    });
  });
});

describe("Backward Compatibility", () => {
  it("existing wallet connection works without authentication", async () => {
    // This test verifies that wallets can still be used without setting up authentication
    const manager = new WalletAuthenticationManager();
    
    const statusResult = await manager.getStatus("wallet-no-auth");
    expect(statusResult.status).toBe("ok");
    if (statusResult.status === "ok") {
      expect(statusResult.data.state).toBe(AuthenticationState.UNINITIALIZED);
      expect(statusResult.data.method).toBe(AuthenticationMethod.NONE);
    }
    
    // Wallet operations should not be blocked when authentication is not configured
    // This maintains backward compatibility with existing wallet usage
  });
});
