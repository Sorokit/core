/**
 * Transaction signing session with timeout and cancellation support (#860).
 *
 * Enforces a configurable signing timeout when waiting for user signatures
 * through connected wallet extensions or hardware prompts, preventing
 * applications from hanging indefinitely.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SignTransactionInput, WalletAdapter } from "./types";
import { signTransaction } from "./signTransaction";
import type { SigningHistoryStore } from "./signingHistory";
import type { SigningRateLimiter } from "./signingRateLimiter";

/**
 * Default signing session timeout duration (5 minutes, ≥ 5 minutes as required).
 */
export const DEFAULT_SIGNING_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

export type TransactionSigningSessionStatus =
  | "idle"
  | "pending"
  | "completed"
  | "timed_out"
  | "cancelled"
  | "failed";

export interface TransactionSigningSessionOptions {
  /**
   * Timeout in milliseconds before the session is aborted.
   * Default: 300,000 ms (5 minutes).
   */
  timeoutMs?: number;
  /**
   * Optional callback triggered when the session times out.
   */
  onTimeout?: () => void;
  /**
   * Optional callback triggered when the session is cancelled by caller.
   */
  onCancel?: () => void;
  /**
   * Optional history store for recording signing outcomes.
   */
  historyStore?: SigningHistoryStore;
  /**
   * Optional rate limiter for queueing signing prompts.
   */
  rateLimiter?: SigningRateLimiter;
}

export class TransactionSigningSession {
  private status: TransactionSigningSessionStatus = "idle";
  private timeoutMs: number;
  private deadline: number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolvePending: ((result: SorokitResult<string>) => void) | null = null;
  private readonly onTimeout?: () => void;
  private readonly onCancel?: () => void;
  private readonly historyStore?: SigningHistoryStore;
  private readonly rateLimiter?: SigningRateLimiter;

  constructor(options: TransactionSigningSessionOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SIGNING_SESSION_TIMEOUT_MS;
    if (this.timeoutMs <= 0 || !Number.isFinite(this.timeoutMs)) {
      this.timeoutMs = DEFAULT_SIGNING_SESSION_TIMEOUT_MS;
    }
    this.onTimeout = options.onTimeout;
    this.onCancel = options.onCancel;
    this.historyStore = options.historyStore;
    this.rateLimiter = options.rateLimiter;
  }

  /**
   * Current session lifecycle status.
   */
  getStatus(): TransactionSigningSessionStatus {
    return this.status;
  }

  /**
   * Configured timeout in milliseconds.
   */
  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  /**
   * Remaining time until the session times out, in milliseconds.
   * Returns 0 if not currently pending or expired.
   */
  getTimeRemainingMs(): number {
    if (this.status !== "pending") return 0;
    return Math.max(0, this.deadline - Date.now());
  }

  /**
   * Extend the current timeout by additional milliseconds.
   *
   * @param additionalMs - Number of additional milliseconds to add to deadline.
   * @returns SorokitResult with the updated remaining time, or error if not pending.
   */
  extendTimeout(additionalMs: number): SorokitResult<number> {
    if (this.status !== "pending") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Cannot extend timeout for session in '${this.status}' state; must be 'pending'.`,
      );
    }
    if (!Number.isFinite(additionalMs) || additionalMs <= 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "additionalMs must be a positive finite number.",
      );
    }

    this.clearTimer();
    this.deadline += additionalMs;
    const remaining = this.getTimeRemainingMs();
    this.scheduleTimer(remaining);
    return ok(remaining);
  }

  /**
   * Reset the session timeout from the current moment.
   *
   * @param newTimeoutMs - Optional new timeout duration in milliseconds. Defaults to original timeout.
   * @returns SorokitResult with the new remaining time.
   */
  resetTimeout(newTimeoutMs?: number): SorokitResult<number> {
    if (this.status !== "pending") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Cannot reset timeout for session in '${this.status}' state; must be 'pending'.`,
      );
    }
    const duration = newTimeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(duration) || duration <= 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "newTimeoutMs must be a positive finite number.",
      );
    }

    this.clearTimer();
    this.timeoutMs = duration;
    this.deadline = Date.now() + duration;
    this.scheduleTimer(duration);
    return ok(duration);
  }

  /**
   * Cancel the signing session immediately.
   *
   * @param reason - Optional explanation for cancellation.
   */
  cancel(reason = "Transaction signing session was cancelled by caller."): SorokitResult<void> {
    if (this.status !== "pending") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Cannot cancel session in '${this.status}' state.`,
      );
    }

    this.clearTimer();
    this.status = "cancelled";

    if (this.onCancel) {
      try {
        this.onCancel();
      } catch {
        // Callback errors should not crash caller
      }
    }

    if (this.resolvePending) {
      const resolver = this.resolvePending;
      this.resolvePending = null;
      resolver(err(SorokitErrorCode.WALLET_SIGN_REJECTED, reason));
    }

    return ok(undefined);
  }

  /**
   * Start the signing session with the provided wallet adapter and transaction input.
   * Resolves with the signed XDR or an error result (e.g. timeout or rejection).
   */
  start(
    adapter: WalletAdapter,
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (this.status === "pending") {
      return Promise.resolve(
        err(
          SorokitErrorCode.VALIDATION,
          "Signing session is already active.",
        ),
      );
    }

    this.status = "pending";
    this.deadline = Date.now() + this.timeoutMs;

    return new Promise<SorokitResult<string>>((resolve) => {
      this.resolvePending = resolve;
      this.scheduleTimer(this.timeoutMs);

      signTransaction(adapter, input, this.historyStore, this.rateLimiter)
        .then((result) => {
          if (this.status !== "pending") return;
          this.clearTimer();
          this.status = result.status === "ok" ? "completed" : "failed";
          const resolver = this.resolvePending;
          this.resolvePending = null;
          resolver?.(result);
        })
        .catch((cause) => {
          if (this.status !== "pending") return;
          this.clearTimer();
          this.status = "failed";
          const resolver = this.resolvePending;
          this.resolvePending = null;
          resolver?.(
            err(
              SorokitErrorCode.WALLET_SIGN_FAILED,
              `Signing session failed: ${String(cause)}`,
              cause,
            ),
          );
        });
    });
  }

  private scheduleTimer(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.status !== "pending") return;
      this.status = "timed_out";
      this.timer = null;

      if (this.onTimeout) {
        try {
          this.onTimeout();
        } catch {
          // Ignore callback failure
        }
      }

      const resolver = this.resolvePending;
      this.resolvePending = null;
      resolver?.(
        err(
          SorokitErrorCode.OPERATION_TIMEOUT,
          `Transaction signing session timed out after ${Math.round(this.timeoutMs / 1000)} seconds. No signature was received.`,
        ),
      );
    }, ms);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Create a new TransactionSigningSession instance.
 */
export function createTransactionSigningSession(
  options?: TransactionSigningSessionOptions,
): TransactionSigningSession {
  return new TransactionSigningSession(options);
}

/**
 * Convenience helper to sign a transaction with session timeout and cancellation control.
 */
export async function signTransactionWithSession(
  adapter: WalletAdapter,
  input: SignTransactionInput,
  options?: TransactionSigningSessionOptions,
): Promise<SorokitResult<string>> {
  const session = new TransactionSigningSession(options);
  return session.start(adapter, input);
}
