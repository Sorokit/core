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

function getStringProperty(
  cause: unknown,
  property: "code" | "name",
): string | undefined {
  const record = cause as Record<string, unknown>;
  if (
    cause !== null &&
    typeof cause === "object" &&
    property in cause &&
    typeof record[property] === "string"
  ) {
    return record[property];
  }
  return undefined;
}

function getResponseStatus(cause: unknown): number | undefined {
  if (cause !== null && typeof cause === "object" && "response" in cause) {
    const response = (cause as Record<string, unknown>).response;
    if (
      response !== null &&
      typeof response === "object" &&
      "status" in response &&
      typeof response.status === "number"
    ) {
      return response.status;
    }
  }
  return undefined;
}

function getBase64DecodedLength(value: string): number | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length % 4 === 1) return null;

  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;

  return Math.floor((normalized.length * 3) / 4) - padding;
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
  return getResponseStatus(cause) === 404;
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
 * Detect whether an error represents a timeout from fetch, Horizon, or RPC.
 */
export function isTimeoutError(cause: unknown): boolean {
  const code = getStringProperty(cause, "code")?.toUpperCase();
  const name = getStringProperty(cause, "name");
  const msg = toMessage(cause).toLowerCase();

  return (
    name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "TIMEOUT" ||
    code === "ECONNABORTED" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("request aborted") ||
    msg.includes("deadline exceeded") ||
    msg.includes("rpc timeout")
  );
}

/**
 * Detect network connectivity failures separately from RPC service failures.
 */
export function isNetworkConnectivityError(cause: unknown): boolean {
  const code = getStringProperty(cause, "code")?.toUpperCase();
  const msg = toMessage(cause).toLowerCase();

  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }

  return (
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("network error") ||
    msg.includes("connection refused") ||
    msg.includes("connection reset") ||
    msg.includes("host unreachable") ||
    msg.includes("network unreachable")
  );
}

/**
 * Detect malformed transaction XDR before or after Stellar SDK parsing.
 */
export function isXdrInvalidError(cause: unknown): boolean {
  if (typeof cause === "string") {
    const value = cause.trim();
    if (value.length === 0) return true;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
    const decodedLength = getBase64DecodedLength(value);
    if (decodedLength === null || decodedLength === 0 || decodedLength % 4 !== 0) {
      return true;
    }
  }

  const msg = toMessage(cause).toLowerCase();
  return (
    msg.includes("xdr read error") ||
    msg.includes("invalid xdr") ||
    msg.includes("malformed xdr") ||
    msg.includes("invalid transaction envelope") ||
    msg.includes("unknown envelopetype member") ||
    msg.includes("bad union switch") ||
    msg.includes("invalid enum") ||
    msg.includes("attempt to read outside the boundary") ||
    msg.includes("read past end") ||
    (msg.includes("xdr") && msg.includes("base64")) ||
    (msg.includes("xdr") && msg.includes("decode"))
  );
}

/**
 * Detect whether an error is transient (retryable) vs permanent.
 * Transient errors include timeouts, network issues, and 5xx server errors.
 */
export function isTransientError(cause: unknown): boolean {
  if (isTimeoutError(cause) || isNetworkConnectivityError(cause)) {
    return true;
  }
  const status = getResponseStatus(cause);
  return status !== undefined && status >= 500 && status < 600;
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
