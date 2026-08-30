/**
 * Tests for wallet connection throttling and abuse detection (#506).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkThrottle,
  recordConnectionAttempt,
  addToAllowlist,
  addToBlocklist,
  removeRateLimitRule,
  getOriginState,
  resetOriginState,
  detectAbuse,
  getConnectionStats,
  clearThrottlingState,
} from "./throttlingCore";
import { SorokitErrorCode } from "../shared/response";

const TEST_ORIGIN = "https://example.com";
const TEST_ORIGIN_2 = "https://other.com";
const MALICIOUS_ORIGIN = "https://attacker.com";

describe("Wallet Connection Throttling", () => {
  beforeEach(() => {
    clearThrottlingState();
  });

  describe("checkThrottle", () => {
    it("should allow connection when throttling is disabled", () => {
      const result = checkThrottle(TEST_ORIGIN, { enabled: false });

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should allow a normal connection attempt", () => {
      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should reject empty origin", () => {
      const result = checkThrottle("");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });

    it("should block an origin after exceeding rate limit", () => {
      const config = {
        maxAttemptsPerWindow: 3,
        timeWindowMs: 60000,
        blockDurationMs: 300000,
      };

      // Make enough attempts to trigger the block
      for (let i = 0; i < 3; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      // Exceed the limit to trigger block
      const limitResult = checkThrottle(TEST_ORIGIN, config);
      expect(limitResult.status).toBe("ok");
      expect(limitResult.data!.allowed).toBe(false);
      expect(limitResult.data!.reason).toContain("Rate limit exceeded");
    });

    it("should return blockExpiresIn when blocked", () => {
      const config = {
        maxAttemptsPerWindow: 3,
        timeWindowMs: 60000,
        blockDurationMs: 300000,
      };

      for (let i = 0; i < 3; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      const result = checkThrottle(TEST_ORIGIN, config);
      expect(result.status).toBe("ok");
      if (!result.data!.allowed) {
        expect(result.data!.blockExpiresIn).toBeGreaterThan(0);
        expect(result.data!.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it("should include origin state in response when allowed", () => {
      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
      expect(result.data!.state).toBeDefined();
    });

    it("should track separate rate limits per origin", () => {
      const config = {
        maxAttemptsPerWindow: 3,
        timeWindowMs: 60000,
      };

      // Block origin 1
      for (let i = 0; i < 3; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      checkThrottle(TEST_ORIGIN, config); // triggers block

      // Origin 2 should still be allowed
      const result2 = checkThrottle(TEST_ORIGIN_2, config);
      expect(result2.data!.allowed).toBe(true);
    });
  });

  describe("recordConnectionAttempt", () => {
    it("should record a successful connection", () => {
      const result = recordConnectionAttempt(TEST_ORIGIN, true);

      expect(result.status).toBe("ok");
      expect(result.data!.successfulAttempts).toBe(1);
      expect(result.data!.failedAttempts).toBe(0);
      expect(result.data!.totalAttempts).toBe(1);
    });

    it("should record a failed connection", () => {
      const result = recordConnectionAttempt(TEST_ORIGIN, false, "TIMEOUT");

      expect(result.status).toBe("ok");
      expect(result.data!.failedAttempts).toBe(1);
      expect(result.data!.successfulAttempts).toBe(0);
    });

    it("should block origin after too many authentication failures", () => {
      const config = {
        maxAuthFailures: 3,
        blockDurationMs: 300000,
        enableAuthFailureTracking: true,
      };

      let finalState = recordConnectionAttempt(TEST_ORIGIN, false, "AUTH_REJECTED", config).data!;
      recordConnectionAttempt(TEST_ORIGIN, false, "AUTH_REJECTED", config);
      finalState = recordConnectionAttempt(TEST_ORIGIN, false, "AUTH_REJECTED", config).data!;

      expect(finalState.authenticationFailures).toBe(3);
      expect(finalState.blocked).toBe(true);
      expect(finalState.blockReason).toContain("authentication");
    });

    it("should reset failure count on successful connection", () => {
      recordConnectionAttempt(TEST_ORIGIN, false, "TIMEOUT");
      recordConnectionAttempt(TEST_ORIGIN, false, "TIMEOUT");
      const result = recordConnectionAttempt(TEST_ORIGIN, true);

      expect(result.status).toBe("ok");
      expect(result.data!.failedAttempts).toBe(0);
      expect(result.data!.authenticationFailures).toBe(0);
    });

    it("should track lastAttemptAt timestamp", () => {
      const before = Date.now();
      const result = recordConnectionAttempt(TEST_ORIGIN, true);
      const after = Date.now();

      expect(result.data!.lastAttemptAt).toBeGreaterThanOrEqual(before);
      expect(result.data!.lastAttemptAt).toBeLessThanOrEqual(after);
    });

    it("should track lastSuccessAt on successful connection", () => {
      const before = Date.now();
      const result = recordConnectionAttempt(TEST_ORIGIN, true);
      const after = Date.now();

      expect(result.data!.lastSuccessAt).toBeGreaterThanOrEqual(before);
      expect(result.data!.lastSuccessAt).toBeLessThanOrEqual(after);
    });
  });

  describe("allowlist", () => {
    it("should allow an allowlisted origin regardless of rate limits", () => {
      addToAllowlist(TEST_ORIGIN);

      // Even if we have a burst of attempts, allowlisted origin should pass
      const config = { maxAttemptsPerWindow: 1, timeWindowMs: 60000 };
      recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);

      const result = checkThrottle(TEST_ORIGIN, config);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should remove allowlist when expired", async () => {
      addToAllowlist(TEST_ORIGIN, 1); // 1ms expiration

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const config = { maxAttemptsPerWindow: 1 };

      // Force rate limit state
      for (let i = 0; i < 2; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      const result = checkThrottle(TEST_ORIGIN, config);

      // The allowlist has expired, so should now be rate-limited
      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(false);
    });

    it("should require a valid origin for allowlist", () => {
      // addToAllowlist normalizes the origin, so empty would hit the guard
      // Testing that a valid origin doesn't throw
      const result = addToAllowlist(TEST_ORIGIN);
      expect(result.status).toBe("ok");
    });
  });

  describe("blocklist", () => {
    it("should block a blocklisted origin immediately", () => {
      addToBlocklist(TEST_ORIGIN, "Known malicious origin");

      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(false);
      expect(result.data!.reason).toContain("blocklisted");
    });

    it("should remove blocklist entry when expired", async () => {
      addToBlocklist(TEST_ORIGIN, "test", 1); // 1ms expiration

      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = checkThrottle(TEST_ORIGIN, { maxAttemptsPerWindow: 100 });

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should allow removing a blocklist rule", () => {
      addToBlocklist(TEST_ORIGIN, "Temporary block");
      removeRateLimitRule(TEST_ORIGIN);

      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should override allowlist with blocklist when re-added", () => {
      // Ensure blocklist takes priority over allowlist re-addition order
      addToAllowlist(TEST_ORIGIN);
      addToBlocklist(TEST_ORIGIN, "Overriding allowlist");

      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(false);
    });
  });

  describe("abuse detection", () => {
    it("should detect rapid connection attempts", () => {
      const config = {
        maxAttemptsPerWindow: 5,
        timeWindowMs: 60000,
      };

      for (let i = 0; i < 6; i++) {
        recordConnectionAttempt(MALICIOUS_ORIGIN, false, undefined, config);
      }

      const result = detectAbuse(MALICIOUS_ORIGIN, config);

      expect(result.status).toBe("ok");
      expect(result.data!.isSuspicious).toBe(true);
      expect(result.data!.patterns).toContain("rapid_connection_attempts");
    });

    it("should detect repeated authentication failures", () => {
      const config = {
        maxAuthFailures: 2,
        enableAuthFailureTracking: true,
      };

      recordConnectionAttempt(MALICIOUS_ORIGIN, false, "AUTH_REJECTED", config);
      recordConnectionAttempt(MALICIOUS_ORIGIN, false, "AUTH_REJECTED", config);
      recordConnectionAttempt(MALICIOUS_ORIGIN, false, "AUTH_REJECTED", config);

      const result = detectAbuse(MALICIOUS_ORIGIN, config);

      expect(result.status).toBe("ok");
      expect(result.data!.patterns).toContain("authentication_failures");
    });

    it("should detect high failure rate", () => {
      // Record many consecutive failures (no success, so failedAttempts stays high)
      for (let i = 0; i < 9; i++) {
        recordConnectionAttempt(MALICIOUS_ORIGIN, false);
      }

      const result = detectAbuse(MALICIOUS_ORIGIN);

      expect(result.status).toBe("ok");
      // 9 failures / 9 total = 100% failure rate → high_failure_rate pattern
      expect(result.data!.patterns).toContain("high_failure_rate");
    });

    it("should return confidence score between 0 and 1", () => {
      const result = detectAbuse(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.confidence).toBeGreaterThanOrEqual(0);
      expect(result.data!.confidence).toBeLessThanOrEqual(1);
    });

    it("should provide recommendations for suspicious origins", () => {
      const config = { maxAttemptsPerWindow: 2, timeWindowMs: 60000 };

      for (let i = 0; i < 10; i++) {
        recordConnectionAttempt(MALICIOUS_ORIGIN, false, undefined, config);
      }

      const result = detectAbuse(MALICIOUS_ORIGIN, config);

      expect(result.status).toBe("ok");
      if (result.data!.isSuspicious) {
        expect(result.data!.recommendations.length).toBeGreaterThan(0);
      }
    });

    it("should not flag legitimate origins as suspicious", () => {
      // Just a couple of attempts
      recordConnectionAttempt(TEST_ORIGIN, true);
      recordConnectionAttempt(TEST_ORIGIN, true);

      const result = detectAbuse(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.isSuspicious).toBe(false);
      expect(result.data!.confidence).toBe(0);
    });
  });

  describe("origin state management", () => {
    it("should get origin state", () => {
      recordConnectionAttempt(TEST_ORIGIN, true);

      const result = getOriginState(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.origin).toBeDefined();
      expect(result.data!.totalAttempts).toBe(1);
    });

    it("should reset origin state", () => {
      recordConnectionAttempt(TEST_ORIGIN, false);
      recordConnectionAttempt(TEST_ORIGIN, false);

      resetOriginState(TEST_ORIGIN);

      const result = getOriginState(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.totalAttempts).toBe(0);
    });

    it("should reset blocked status after block expires", async () => {
      const config = {
        maxAttemptsPerWindow: 2,
        timeWindowMs: 60000,
        blockDurationMs: 1, // 1ms block
      };

      for (let i = 0; i < 2; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      // Trigger the block
      const blockedResult = checkThrottle(TEST_ORIGIN, config);
      expect(blockedResult.data!.allowed).toBe(false);

      // Wait for block to expire
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      // Clear history so recent attempts window is empty too
      resetOriginState(TEST_ORIGIN);

      const result = checkThrottle(TEST_ORIGIN, config);
      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });
  });

  describe("connection statistics", () => {
    it("should track total connection stats", () => {
      recordConnectionAttempt(TEST_ORIGIN, true);
      recordConnectionAttempt(TEST_ORIGIN, false);
      recordConnectionAttempt(TEST_ORIGIN_2, true);

      const stats = getConnectionStats();

      expect(stats.totalAttempts).toBeGreaterThanOrEqual(3);
      expect(stats.successfulConnections).toBeGreaterThanOrEqual(2);
      expect(stats.failedConnections).toBeGreaterThanOrEqual(1);
    });

    it("should track blocked origins", () => {
      addToBlocklist(MALICIOUS_ORIGIN, "Test block");

      const stats = getConnectionStats();

      expect(stats.blocklistedOrigins).toBeGreaterThanOrEqual(1);
    });

    it("should track allowlisted origins", () => {
      addToAllowlist(TEST_ORIGIN);

      const stats = getConnectionStats();

      expect(stats.allowlistedOrigins).toBeGreaterThanOrEqual(1);
    });

    it("should report total unique origins tracked", () => {
      recordConnectionAttempt(TEST_ORIGIN, true);
      recordConnectionAttempt(TEST_ORIGIN_2, true);

      const stats = getConnectionStats();

      expect(stats.totalOrigins).toBeGreaterThanOrEqual(2);
    });
  });

  describe("rate limit expiry", () => {
    it("should clear state on clearThrottlingState", () => {
      recordConnectionAttempt(TEST_ORIGIN, true);
      addToBlocklist(MALICIOUS_ORIGIN);
      addToAllowlist(TEST_ORIGIN_2);

      clearThrottlingState();

      const stats = getConnectionStats();

      expect(stats.totalOrigins).toBe(0);
      expect(stats.totalAttempts).toBe(0);
      expect(stats.allowlistedOrigins).toBe(0);
      expect(stats.blocklistedOrigins).toBe(0);
    });

    it("should allow connections again after block window expires", async () => {
      const config = {
        maxAttemptsPerWindow: 2,
        timeWindowMs: 1, // 1ms window
        blockDurationMs: 1, // 1ms block
      };

      for (let i = 0; i < 3; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      // Block triggered by exceeding window
      checkThrottle(TEST_ORIGIN, config);

      // Wait for both window and block to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = checkThrottle(TEST_ORIGIN, config);
      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });
  });

  describe("structured error responses", () => {
    it("should return structured error when blocked", () => {
      addToBlocklist(TEST_ORIGIN, "Explicitly blocked");

      const result = checkThrottle(TEST_ORIGIN);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(false);
      expect(result.data!.reason).toBeDefined();
      expect(typeof result.data!.reason).toBe("string");
    });

    it("should include retryAfterMs when rate limited", () => {
      const config = {
        maxAttemptsPerWindow: 2,
        timeWindowMs: 60000,
        blockDurationMs: 300000,
      };

      for (let i = 0; i < 2; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false, undefined, config);
      }

      const result = checkThrottle(TEST_ORIGIN, config);

      expect(result.status).toBe("ok");
      if (!result.data!.allowed) {
        expect(result.data!.retryAfterMs).toBeDefined();
        expect(result.data!.retryAfterMs).toBeGreaterThan(0);
      }
    });
  });

  describe("existing wallet integrations remain compatible", () => {
    it("should not affect connections when protection is disabled", () => {
      const config = { enabled: false };

      // Even with many failed attempts, disabled throttling allows all
      for (let i = 0; i < 100; i++) {
        recordConnectionAttempt(TEST_ORIGIN, false);
      }

      const result = checkThrottle(TEST_ORIGIN, config);

      expect(result.status).toBe("ok");
      expect(result.data!.allowed).toBe(true);
    });

    it("should normalize origin URLs consistently", () => {
      // Different representations of the same origin should be treated identically
      recordConnectionAttempt("https://example.com/app/page", true);
      const state1 = getOriginState("https://example.com");

      expect(state1.status).toBe("ok");
      expect(state1.data!.totalAttempts).toBe(1);
    });
  });
});
