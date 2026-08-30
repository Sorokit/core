/**
 * Wallet connection throttling and abuse detection core logic.
 */

import type {
  ThrottlingConfig,
  ThrottleCheckResult,
  OriginRateLimitState,
  ConnectionAttempt,
  RateLimitRule,
  AbuseDetectionResult,
  ConnectionStats,
} from "./throttlingTypes";
import { RateLimitRuleType } from "./throttlingTypes";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCode, err, ok } from "../shared/response";

/**
 * Default throttling configuration.
 */
const DEFAULT_THROTTLING_CONFIG: Required<ThrottlingConfig> = {
  maxAttemptsPerWindow: 10,
  timeWindowMs: 60000, // 1 minute
  maxAuthFailures: 3,
  blockDurationMs: 300000, // 5 minutes
  enableOriginTracking: true,
  enableAuthFailureTracking: true,
  reconnectGraceMs: 5000, // 5 second grace period
  enabled: true,
};

/**
 * Origin rate limit state storage.
 */
const originStates = new Map<string, OriginRateLimitState>();

/**
 * Connection attempt history.
 */
const connectionHistory: ConnectionAttempt[] = [];

/**
 * Rate limiting rules (allowlist/blocklist).
 */
const rateLimitRules = new Map<string, RateLimitRule>();

/**
 * Extracts origin from URL or returns as-is if already an origin string.
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    // Already an origin string or invalid URL, return as-is
    return origin.toLowerCase();
  }
}

/**
 * Gets or initializes rate limit state for an origin.
 */
function getOrCreateState(origin: string): OriginRateLimitState {
  const normalized = normalizeOrigin(origin);

  if (!originStates.has(normalized)) {
    originStates.set(normalized, {
      origin: normalized,
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      authenticationFailures: 0,
      blocked: false,
    });
  }

  return originStates.get(normalized)!;
}

/**
 * Checks if an origin is in the allowlist.
 */
function isAllowlisted(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  const rule = rateLimitRules.get(normalized);
  if (rule && rule.type === RateLimitRuleType.ALLOWLIST) {
    if (rule.expiresAt && rule.expiresAt < Date.now()) {
      rateLimitRules.delete(normalized);
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Checks if an origin is in the blocklist.
 */
function isBlocklisted(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  const rule = rateLimitRules.get(normalized);
  if (rule && rule.type === RateLimitRuleType.BLOCKLIST) {
    if (rule.expiresAt && rule.expiresAt < Date.now()) {
      rateLimitRules.delete(normalized);
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Checks throttle status and decides if connection should be allowed.
 */
export function checkThrottle(
  origin: string,
  config?: ThrottlingConfig,
): SorokitResult<ThrottleCheckResult> {
  const fullConfig = { ...DEFAULT_THROTTLING_CONFIG, ...config };

  if (!fullConfig.enabled) {
    return ok({
      allowed: true,
    });
  }

  if (!origin || typeof origin !== "string") {
    return err<ThrottleCheckResult>(
      SorokitErrorCode.INVALID_CONFIG,
      "Origin is required",
    );
  }

  const normalized = normalizeOrigin(origin);

  // Check allowlist first
  if (isAllowlisted(normalized)) {
    return ok({
      allowed: true,
    });
  }

  // Check blocklist
  if (isBlocklisted(normalized)) {
    return ok({
      allowed: false,
      reason: "Origin is blocklisted",
    });
  }

  const state = getOrCreateState(normalized);

  // Check if currently blocked due to too many attempts
  if (state.blocked && state.blockExpiresAt) {
    if (Date.now() < state.blockExpiresAt) {
      const remainingMs = state.blockExpiresAt - Date.now();
      return ok({
        allowed: false,
        reason: `Origin temporarily blocked: ${state.blockReason || "too many failed attempts"}`,
        blockExpiresIn: remainingMs,
        retryAfterMs: remainingMs,
        state,
      });
    } else {
      // Block has expired, reset
      state.blocked = false;
      state.blockExpiresAt = undefined;
      state.blockReason = undefined;
      state.authenticationFailures = 0;
    }
  }

  // Check rate limit window
  const now = Date.now();
  const windowStart = now - fullConfig.timeWindowMs;

  // Clean up old attempts
  const recentAttempts = connectionHistory.filter(
    (a) => a.origin === normalized && a.timestamp > windowStart,
  );

  if (recentAttempts.length >= fullConfig.maxAttemptsPerWindow) {
    // Block this origin temporarily
    state.blocked = true;
    state.blockExpiresAt = now + fullConfig.blockDurationMs;
    state.blockReason = "Too many connection attempts";

    return ok({
      allowed: false,
      reason: "Rate limit exceeded",
      blockExpiresIn: fullConfig.blockDurationMs,
      retryAfterMs: fullConfig.blockDurationMs,
      state,
    });
  }

  return ok({
    allowed: true,
    state,
  });
}

/**
 * Records a connection attempt.
 */
export function recordConnectionAttempt(
  origin: string,
  success: boolean,
  failureReason?: string,
  config?: ThrottlingConfig,
): SorokitResult<OriginRateLimitState> {
  const fullConfig = { ...DEFAULT_THROTTLING_CONFIG, ...config };
  const normalized = normalizeOrigin(origin);

  if (!normalized || typeof normalized !== "string") {
    return err<OriginRateLimitState>(
      SorokitErrorCode.INVALID_CONFIG,
      "Origin is required",
    );
  }

  const state = getOrCreateState(normalized);

  // Record attempt
  connectionHistory.push({
    origin: normalized,
    timestamp: Date.now(),
    success,
    failureReason,
  });

  state.totalAttempts++;
  state.lastAttemptAt = Date.now();

  if (success) {
    state.successfulAttempts++;
    state.lastSuccessAt = Date.now();
    state.failedAttempts = 0;
    state.authenticationFailures = 0;
  } else {
    state.failedAttempts++;

    // Track authentication failures
    if (
      fullConfig.enableAuthFailureTracking &&
      failureReason?.includes("AUTH")
    ) {
      state.authenticationFailures++;

      // Block after too many auth failures
      if (state.authenticationFailures >= fullConfig.maxAuthFailures) {
        state.blocked = true;
        state.blockExpiresAt = Date.now() + fullConfig.blockDurationMs;
        state.blockReason = "Too many authentication failures";
      }
    }
  }

  return ok(state);
}

/**
 * Adds an origin to the allowlist.
 */
export function addToAllowlist(
  origin: string,
  expirationMs?: number,
): SorokitResult<void> {
  const normalized = normalizeOrigin(origin);

  if (!normalized || typeof normalized !== "string") {
    return err<void>(
      SorokitErrorCode.INVALID_CONFIG,
      "Origin is required",
    );
  }

  // Remove from blocklist if present
  rateLimitRules.delete(normalized);

  rateLimitRules.set(normalized, {
    origin: normalized,
    type: RateLimitRuleType.ALLOWLIST,
    expiresAt: expirationMs ? Date.now() + expirationMs : undefined,
    reason: "Added to allowlist",
  });

  return ok(undefined);
}

/**
 * Adds an origin to the blocklist.
 */
export function addToBlocklist(
  origin: string,
  reason?: string,
  expirationMs?: number,
): SorokitResult<void> {
  const normalized = normalizeOrigin(origin);

  if (!normalized || typeof normalized !== "string") {
    return err<void>(
      SorokitErrorCode.INVALID_CONFIG,
      "Origin is required",
    );
  }

  // Remove from allowlist if present
  rateLimitRules.delete(normalized);

  rateLimitRules.set(normalized, {
    origin: normalized,
    type: RateLimitRuleType.BLOCKLIST,
    expiresAt: expirationMs ? Date.now() + expirationMs : undefined,
    reason: reason || "Added to blocklist",
  });

  return ok(undefined);
}

/**
 * Removes a rate limit rule for an origin.
 */
export function removeRateLimitRule(origin: string): SorokitResult<void> {
  const normalized = normalizeOrigin(origin);
  rateLimitRules.delete(normalized);
  return ok(undefined);
}

/**
 * Gets rate limit state for an origin.
 */
export function getOriginState(
  origin: string,
): SorokitResult<OriginRateLimitState> {
  const normalized = normalizeOrigin(origin);
  const state = getOrCreateState(normalized);
  return ok(state);
}

/**
 * Resets rate limit state for an origin.
 */
export function resetOriginState(origin: string): SorokitResult<void> {
  const normalized = normalizeOrigin(origin);
  originStates.delete(normalized);

  // Clean up history for this origin
  const index = connectionHistory.findIndex((a) => a.origin === normalized);
  if (index !== -1) {
    connectionHistory.splice(index, 1);
  }

  return ok(undefined);
}

/**
 * Detects potential abuse patterns.
 */
export function detectAbuse(
  origin: string,
  config?: ThrottlingConfig,
): SorokitResult<AbuseDetectionResult> {
  const fullConfig = { ...DEFAULT_THROTTLING_CONFIG, ...config };
  const normalized = normalizeOrigin(origin);

  const state = getOrCreateState(normalized);
  const patterns: string[] = [];
  let confidence = 0;

  // Check for rapid attempts
  const now = Date.now();
  const recentAttempts = connectionHistory.filter(
    (a) =>
      a.origin === normalized &&
      a.timestamp > now - fullConfig.timeWindowMs,
  );

  if (recentAttempts.length >= fullConfig.maxAttemptsPerWindow) {
    patterns.push("rapid_connection_attempts");
    confidence += 0.3;
  }

  // Check for repeated failures
  if (state.failedAttempts >= fullConfig.maxAttemptsPerWindow / 2) {
    patterns.push("repeated_failures");
    confidence += 0.25;
  }

  // Check for authentication failures
  if (state.authenticationFailures >= fullConfig.maxAuthFailures) {
    patterns.push("authentication_failures");
    confidence += 0.25;
  }

  // Check failure rate
  if (state.totalAttempts > 0) {
    const failureRate = state.failedAttempts / state.totalAttempts;
    if (failureRate > 0.8) {
      patterns.push("high_failure_rate");
      confidence += 0.2;
    }
  }

  const recommendations: string[] = [];
  if (confidence > 0.5) {
    recommendations.push("Consider adding origin to temporary blocklist");
    recommendations.push("Monitor for continued suspicious activity");
  }
  if (patterns.includes("authentication_failures")) {
    recommendations.push("Reset authentication state");
  }

  return ok({
    isSuspicious: confidence > 0.5,
    confidence: Math.min(confidence, 1),
    patterns,
    recommendations,
  });
}

/**
 * Gets connection statistics.
 */
export function getConnectionStats(): ConnectionStats {
  let blockedOrigins = 0;
  let allowlistedOrigins = 0;
  let blocklistedOrigins = 0;

  for (const rule of rateLimitRules.values()) {
    if (rule.expiresAt && rule.expiresAt < Date.now()) {
      continue;
    }
    if (rule.type === RateLimitRuleType.ALLOWLIST) {
      allowlistedOrigins++;
    } else if (rule.type === RateLimitRuleType.BLOCKLIST) {
      blocklistedOrigins++;
    }
  }

  for (const state of originStates.values()) {
    if (state.blocked) {
      blockedOrigins++;
    }
  }

  let successfulConnections = 0;
  let failedConnections = 0;

  for (const attempt of connectionHistory) {
    if (attempt.success) {
      successfulConnections++;
    } else {
      failedConnections++;
    }
  }

  return {
    totalOrigins: originStates.size,
    blockedOrigins,
    allowlistedOrigins,
    blocklistedOrigins,
    totalAttempts: connectionHistory.length,
    successfulConnections,
    failedConnections,
  };
}

/**
 * Clears all throttling state (for testing/reset).
 */
export function clearThrottlingState(): void {
  originStates.clear();
  connectionHistory.length = 0;
  rateLimitRules.clear();
}
