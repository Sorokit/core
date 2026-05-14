import { SorokitErrorCode } from "./response";
import type { SorokitError } from "./response";

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
 * Build a SorokitError object directly (for use outside the result helpers).
 */
export function buildError(
  code: SorokitErrorCode,
  message: string,
  cause?: unknown,
): SorokitError {
  return { code, message, cause };
}
