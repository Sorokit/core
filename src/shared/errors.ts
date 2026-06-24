import { SorokitErrorCode, ok } from "./response";
import type { SorokitError, SorokitResult } from "./response";

/**
 * Recovery action that an error handler can request.
 */
export type ErrorRecoveryAction =
  | { type: "retry" }
  | { type: "fallback"; fallbackValue: unknown }
  | { type: "rethrow" };

/**
 * Context passed to error handlers.
 */
export interface ErrorContext {
  /** Name of the function that produced the error */
  functionName: string;
  /** Parameters passed to the function (for logging/debugging) */
  params?: Record<string, unknown>;
}

/**
 * Error handler interface for centralized error processing.
 * Handlers can log errors, attempt recovery, or transform errors.
 */
export interface ErrorHandler {
  /**
   * Handle an error from a Sorokit function.
   * @param error - The SorokitError that occurred
   * @param context - Context about where the error occurred
   * @returns Optional recovery action, or undefined to let error propagate normally
   */
  handle(error: SorokitError, context: ErrorContext): ErrorRecoveryAction | void;
}

/**
 * Normalise an unknown caught value into a human-readable message string.
 */
export function toMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Detect whether a Horizon/RPC error is a 404 (resource not found).
 */
export function isNotFoundError(cause: unknown): boolean {
  if (cause instanceof Error) {
    return (
      cause.message.includes("404") ||
      cause.message.toLowerCase().includes("not found")
    );
  }
  if (
    cause !== null &&
    typeof cause === "object" &&
    "response" in cause &&
    cause.response !== null &&
    typeof cause.response === "object" &&
    "status" in cause.response
  ) {
    return (cause.response as { status: number }).status === 404;
  }
  return false;
}

/**
 * Detect whether a wallet error represents a user-initiated rejection.
 */
export function isUserRejection(cause: unknown): boolean {
  const msg = toMessage(cause).toLowerCase();
  return (
    msg.includes("reject") ||
    msg.includes("cancel") ||
    msg.includes("denied") ||
    msg.includes("user declined")
  );
}

/**
 * Detect whether an error is transient (retryable) vs permanent.
 * Transient errors include timeouts, network issues, and 5xx server errors.
 */
export function isTransientError(cause: unknown): boolean {
  const msg = toMessage(cause).toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return true;
  }
  if (
    cause !== null &&
    typeof cause === "object" &&
    "response" in cause &&
    cause.response !== null &&
    typeof cause.response === "object" &&
    "status" in cause.response
  ) {
    const status = (cause.response as { status: number }).status;
    return status >= 500 && status < 600;
  }
  return false;
}

/**
 * Build a SorokitError object directly (for use outside the result helpers).
 */
export function buildError(
  code: SorokitErrorCode,
  message: string,
  cause?: unknown,
): SorokitError {
  return { code, message, cause };
}

/**
 * Apply error handler to a SorokitResult if it's an error.
 * This is called by client methods before returning results to users.
 */
export function applyErrorHandler<T>(
  result: SorokitResult<T>,
  errorHandler: ErrorHandler | undefined,
  context: ErrorContext,
): SorokitResult<T> {
  if (result.status === "error" && errorHandler) {
    const recoveryAction = errorHandler.handle(result.error, context);
    if (recoveryAction) {
      if (recoveryAction.type === "fallback") {
        return ok(recoveryAction.fallbackValue as T);
      }
      if (recoveryAction.type === "rethrow") {
        throw new Error(result.error.message);
      }
      if (recoveryAction.type === "retry") {
        return result;
      }
    }
  }
  return result;
}

/**
 * Wrap an async function with error handling.
 * Applies the error handler to the result before returning.
 */
export function withErrorHandling<T>(
  errorHandler: ErrorHandler | undefined,
  context: ErrorContext,
  fn: () => Promise<SorokitResult<T>>,
): Promise<SorokitResult<T>> {
  return fn().then((result) => applyErrorHandler(result, errorHandler, context));
}
