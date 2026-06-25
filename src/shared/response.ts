/**
 * SorokitResult — the single response format for every public function.
 *
 * Shape: { status, data?, error? }
 *
 * Rules:
 * - Every public function returns SorokitResult<T>
 * - No function throws — all errors are returned as typed values
 * - No raw returns (plain strings, booleans, objects) from public API
 * - Use ok() for success, err() for failure
 * - Discriminate on result.status === 'ok' | 'error'
 */

export type SorokitResult<T> =
  | { status: "ok"; data: T; error: null }
  | { status: "error"; data: null; error: SorokitError };

export interface SorokitError {
  code: SorokitErrorCode;
  message: string;
  cause?: unknown;
  /**
   * Optional correlation ID linking this error to the operation chain that
   * produced it. Set automatically by client methods when a trace ID is active.
   */
  traceId?: string;
}

export enum SorokitErrorCode {
  // Wallet
  WALLET_NOT_FOUND = "WALLET_NOT_FOUND",
  WALLET_NOT_CONNECTED = "WALLET_NOT_CONNECTED",
  WALLET_CONNECT_FAILED = "WALLET_CONNECT_FAILED",
  WALLET_SIGN_REJECTED = "WALLET_SIGN_REJECTED",
  WALLET_SIGN_FAILED = "WALLET_SIGN_FAILED",
  WALLET_BROWSER_ONLY = "WALLET_BROWSER_ONLY",

  // Account
  ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND",
  ACCOUNT_FETCH_FAILED = "ACCOUNT_FETCH_FAILED",

  // Transaction
  TX_BUILD_FAILED = "TX_BUILD_FAILED",
  TX_SIMULATE_FAILED = "TX_SIMULATE_FAILED",
  TX_SUBMIT_FAILED = "TX_SUBMIT_FAILED",
  TX_NOT_FOUND = "TX_NOT_FOUND",

  // Soroban
  CONTRACT_INVOKE_FAILED = "CONTRACT_INVOKE_FAILED",
  CONTRACT_READ_FAILED = "CONTRACT_READ_FAILED",
  CONTRACT_PREPARE_FAILED = "CONTRACT_PREPARE_FAILED",
  CONTRACT_SIMULATE_FAILED = "CONTRACT_SIMULATE_FAILED",

  // Network
  NETWORK_ERROR = "NETWORK_ERROR",
  INVALID_NETWORK = "INVALID_NETWORK",

  // Generic
  UNKNOWN = "UNKNOWN",
}

/** Construct a success result */
export function ok<T>(data: T): SorokitResult<T> {
  return { status: "ok", data, error: null };
}

/** Construct a failure result */
export function err<T>(
  code: SorokitErrorCode,
  message: string,
  cause?: unknown,
  traceId?: string,
): SorokitResult<T> {
  return {
    status: "error",
    data: null,
    error: traceId !== undefined ? { code, message, cause, traceId } : { code, message, cause },
  };
}

/**
 * Stamp a trace ID onto an error result if it does not already carry one.
 * Success results pass through untouched.
 */
export function attachTraceId<T>(
  result: SorokitResult<T>,
  traceId: string,
): SorokitResult<T> {
  if (result.status === "error" && result.error.traceId === undefined) {
    return { ...result, error: { ...result.error, traceId } };
  }
  return result;
}

/** Type guard — narrows to the success branch */
export function isOk<T>(
  result: SorokitResult<T>,
): result is { status: "ok"; data: T; error: null } {
  return result.status === "ok";
}

/** Type guard — narrows to the error branch */
export function isErr<T>(
  result: SorokitResult<T>,
): result is { status: "error"; data: null; error: SorokitError } {
  return result.status === "error";
}

/**
 * Type guard — narrows result to a specific error code.
 * @example
 * if (isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)) {
 *   // result.error.code is narrowed to SorokitErrorCode.ACCOUNT_NOT_FOUND
 * }
 */
export function isErrorCode<T, C extends SorokitErrorCode>(
  result: SorokitResult<T>,
  code: C,
): result is { status: "error"; data: null; error: SorokitError & { code: C } } {
  return result.status === "error" && result.error.code === code;
}

/**
 * Assert that a result is ok — throws if it is an error.
 * Use in contexts where an error is unrecoverable and you want to fail fast.
 * @example
 * assertOk(result); // throws if error
 * result.data // typed as non-null after this point
 */
export function assertOk<T>(
  result: SorokitResult<T>,
): asserts result is { status: "ok"; data: T; error: null } {
  if (result.status === "error") {
    throw new Error(
      `Expected ok result but got error: [${result.error.code}] ${result.error.message}`,
    );
  }
}
