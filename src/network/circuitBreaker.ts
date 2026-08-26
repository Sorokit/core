/**
 * Circuit breaker for RPC endpoint failures.
 *
 * Wraps the retry layer so that a consistently failing endpoint stops being
 * called immediately (fail-fast) instead of retrying for 30+ seconds.
 *
 * State machine:
 *   CLOSED  ──(5 consecutive transient failures)──▶  OPEN
 *   OPEN    ──(60 s recovery window)───▶  HALF_OPEN
 *   HALF_OPEN ──(probe succeeds)─────▶  CLOSED
 *   HALF_OPEN ──(probe fails)────────▶  OPEN
 *
 * The circuit breaker is intentionally stateful: create one instance per
 * endpoint and reuse it across calls.
 */

import { isTransientError } from "../shared/errors";

// ─── Public types ─────────────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /**
   * Number of consecutive transient failures required to trip the circuit.
   * @default 5
   */
  failureThreshold?: number;
  /**
   * Milliseconds to wait in OPEN state before transitioning to HALF_OPEN.
   * @default 60_000
   */
  recoveryWindowMs?: number;
  /**
   * Optional callback invoked on every state transition.
   * Useful for metrics, logging, and alerting.
   */
  onStateChange?: (event: CircuitStateChangeEvent) => void;
}

export interface CircuitStateChangeEvent {
  endpoint: string;
  from: CircuitState;
  to: CircuitState;
  at: number;
  consecutiveFailures: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  /** Epoch ms when the circuit was last opened, or null if never opened. */
  lastOpenedAt: number | null;
  /** Epoch ms when the circuit last transitioned to any state. */
  lastTransitionAt: number;
}

/** Thrown when a call is attempted while the circuit is OPEN. */
export class CircuitOpenError extends Error {
  readonly endpoint: string;
  readonly openedAt: number;

  constructor(endpoint: string, openedAt: number) {
    super(
      `Circuit breaker OPEN for "${endpoint}" — failing fast. ` +
        `Opened at ${new Date(openedAt).toISOString()}.`,
    );
    this.name = "CircuitOpenError";
    this.endpoint = endpoint;
    this.openedAt = openedAt;
  }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RECOVERY_WINDOW_MS = 60_000;

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Circuit breaker state machine for a single RPC endpoint.
 *
 * @example
 * const cb = new CircuitBreaker("https://soroban-testnet.stellar.org");
 *
 * // Wrap every call:
 * const result = await cb.call(() => rpc.simulateTransaction(tx));
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastOpenedAt: number | null = null;
  private lastTransitionAt: number = Date.now();

  private readonly failureThreshold: number;
  private readonly recoveryWindowMs: number;
  private readonly onStateChange:
    | ((event: CircuitStateChangeEvent) => void)
    | undefined;

  constructor(
    readonly endpoint: string,
    config: CircuitBreakerConfig = {},
  ) {
    this.failureThreshold =
      config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.recoveryWindowMs =
      config.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
    this.onStateChange = config.onStateChange ?? undefined;
  }

  // ─── State queries ──────────────────────────────────────────────────────────

  get currentState(): CircuitState {
    this.checkRecovery();
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastOpenedAt: this.lastOpenedAt,
      lastTransitionAt: this.lastTransitionAt,
    };
  }

  // ─── Core call wrapper ──────────────────────────────────────────────────────

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - CLOSED: execute normally; track failures and successes.
   * - OPEN: throw `CircuitOpenError` immediately without calling `fn`.
   * - HALF_OPEN: execute one probe; close on success, reopen on failure.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.checkRecovery();

    if (this.state === "OPEN") {
      throw new CircuitOpenError(this.endpoint, this.lastOpenedAt!);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      // Only transient errors (5xx, timeout, network) count as circuit failures.
      // Permanent errors (bad params, 404) pass through without tripping the circuit.
      if (isTransientError(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  // ─── Manual reset ───────────────────────────────────────────────────────────

  /** Force the circuit back to CLOSED. Useful for tests or manual recovery. */
  reset(): void {
    this.transition("CLOSED");
    this.consecutiveFailures = 0;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * If the circuit is OPEN and the recovery window has elapsed,
   * transition to HALF_OPEN to allow a probe request.
   */
  private checkRecovery(): void {
    if (
      this.state === "OPEN" &&
      this.lastOpenedAt !== null &&
      Date.now() - this.lastOpenedAt >= this.recoveryWindowMs
    ) {
      this.transition("HALF_OPEN");
    }
  }

  private onSuccess(): void {
    this.totalSuccesses += 1;

    if (this.state === "HALF_OPEN") {
      // Probe succeeded — close the circuit
      this.consecutiveFailures = 0;
      this.transition("CLOSED");
      return;
    }

    // CLOSED: reset consecutive failure counter on any success
    this.consecutiveFailures = 0;
  }

  private onFailure(): void {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;

    if (this.state === "HALF_OPEN") {
      // Probe failed — reopen the circuit and restart the recovery clock
      this.lastOpenedAt = Date.now();
      this.transition("OPEN");
      return;
    }

    if (
      this.state === "CLOSED" &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.lastOpenedAt = Date.now();
      this.transition("OPEN");
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;
    this.lastTransitionAt = Date.now();

    this.onStateChange?.({
      endpoint: this.endpoint,
      from,
      to,
      at: this.lastTransitionAt,
      consecutiveFailures: this.consecutiveFailures,
    });
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * A lightweight registry that creates and reuses `CircuitBreaker` instances
 * keyed by endpoint URL.
 *
 * Use this when you want a single shared breaker per RPC endpoint across
 * multiple callers without passing a `CircuitBreaker` instance through params.
 *
 * @example
 * const registry = new CircuitBreakerRegistry();
 * const result = await registry.call(rpcUrl, () => rpc.simulateTransaction(tx));
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = config;
  }

  /** Get or create the breaker for a given endpoint. */
  getBreakerFor(endpoint: string): CircuitBreaker {
    let breaker = this.breakers.get(endpoint);
    if (!breaker) {
      breaker = new CircuitBreaker(endpoint, this.config);
      this.breakers.set(endpoint, breaker);
    }
    return breaker;
  }

  /** Convenience wrapper: call `fn` through the breaker for `endpoint`. */
  async call<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    return this.getBreakerFor(endpoint).call(fn);
  }

  /** Metrics snapshot for all tracked endpoints. */
  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const result: Record<string, CircuitBreakerMetrics> = {};
    for (const [endpoint, breaker] of this.breakers) {
      result[endpoint] = breaker.getMetrics();
    }
    return result;
  }

  /** Reset all breakers — useful between tests. */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
