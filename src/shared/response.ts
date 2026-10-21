/**
 * SorokitResult — the single response format for every public function.
 *
 * All public operations return a discriminated result. Error metadata is
 * intentionally structured so applications can choose a recovery path without
 * parsing human-readable messages.
 */

export type SorokitResult<T> =
  | { status: "ok"; data: T; error: null }
  | { status: "error"; data: null; error: SorokitError };

/**
 * Assert that a discriminated-union switch handled every case.
 * With strict TypeScript settings, adding a new result status makes the call
 * site fail to compile until its branch is handled.
 */
export function assertNever(value: never, context = "Unexpected result status"): never {
  throw new Error(`${context}: ${String(value)}`);
}

export interface RecoveryAttempt {
  endpoint: string;
  error: string;
  timestamp: number;
}

export enum SorokitErrorCategory {
  VALIDATION = "validation",
  NETWORK = "network",
  TIMEOUT = "timeout",
  CONTRACT = "contract",
  WALLET = "wallet",
  TRANSACTION = "transaction",
  INTERNAL = "internal",
  UNKNOWN = "unknown",
}

export interface SorokitErrorContext {
  operation?: string;
  parameters?: Record<string, unknown>;
}

export interface RecoveryGuidance {
  retryable: boolean;
  action: string;
  retryAfterMs?: number;
  suggestions?: string[];
}

export interface SorokitError {
  code: SorokitErrorCode;
  message: string;
  category: SorokitErrorCategory;
  cause?: unknown;
  context?: SorokitErrorContext;
  recovery?: RecoveryGuidance;
  suggestions?: string[];
  traceId?: string;
  recoveryAttempts?: RecoveryAttempt[];
  degradedMode?: boolean;
}

export interface SorokitErrorOptions {
  context?: SorokitErrorContext;
  recovery?: RecoveryGuidance;
  suggestions?: string[];
}

export enum SorokitErrorCode {
  WALLET_NOT_FOUND = "WALLET_NOT_FOUND",
  WALLET_NOT_CONNECTED = "WALLET_NOT_CONNECTED",
  WALLET_CONNECT_FAILED = "WALLET_CONNECT_FAILED",
  WALLET_SIGN_REJECTED = "WALLET_SIGN_REJECTED",
  WALLET_SIGN_FAILED = "WALLET_SIGN_FAILED",
  WALLET_BROWSER_ONLY = "WALLET_BROWSER_ONLY",
  ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND",
  SOURCE_ACCOUNT_NOT_FOUND = "SOURCE_ACCOUNT_NOT_FOUND",
  ACCOUNT_FETCH_FAILED = "ACCOUNT_FETCH_FAILED",
  TX_BUILD_FAILED = "TX_BUILD_FAILED",
  TX_SIMULATE_FAILED = "TX_SIMULATE_FAILED",
  TX_SUBMIT_FAILED = "TX_SUBMIT_FAILED",
  INVALID_TRANSACTION = "INVALID_TRANSACTION",
  TX_FETCH_FAILED = "TX_FETCH_FAILED",
  TX_NOT_FOUND = "TX_NOT_FOUND",
  TX_SEQUENCE_CONFLICT = "TX_SEQUENCE_CONFLICT",
  ROUTER_INVALID_PATH = "ROUTER_INVALID_PATH",
  ROUTER_INSUFFICIENT_LIQUIDITY = "ROUTER_INSUFFICIENT_LIQUIDITY",
  ROUTER_SLIPPAGE_EXCEEDED = "ROUTER_SLIPPAGE_EXCEEDED",
  ROUTER_SWAP_FAILED = "ROUTER_SWAP_FAILED",
  CONTRACT_INVOKE_FAILED = "CONTRACT_INVOKE_FAILED",
  CONTRACT_READ_FAILED = "CONTRACT_READ_FAILED",
  CONTRACT_PREPARE_FAILED = "CONTRACT_PREPARE_FAILED",
  CONTRACT_SIMULATE_FAILED = "CONTRACT_SIMULATE_FAILED",
  SOROBAN_SIMULATION_FAILED = "SOROBAN_SIMULATION_FAILED",
  INSUFFICIENT_FEE = "INSUFFICIENT_FEE",
  INVALID_AUTH = "INVALID_AUTH",
  RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED",
  XDR_INVALID = "XDR_INVALID",
  RATE_LIMITED = "RATE_LIMITED",
  NETWORK_ERROR = "NETWORK_ERROR",
  INVALID_NETWORK = "INVALID_NETWORK",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  OPERATION_TIMEOUT = "OPERATION_TIMEOUT",
  INVALID_CONFIG = "INVALID_CONFIG",
  INVALID_ADDRESS = "INVALID_ADDRESS",
  MAINNET_SAFETY_LIMIT = "MAINNET_SAFETY_LIMIT",
  VALIDATION = "VALIDATION",
  INTERNAL = "INTERNAL",
  UNKNOWN = "UNKNOWN",
}

const SENSITIVE_KEY =
  /(secret|password|token|mnemonic|private|seed|authorization|api[-_]?key)/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(entry),
    ]),
  );
}

export function sanitizeErrorContext(
  context?: SorokitErrorContext,
): SorokitErrorContext | undefined {
  if (!context) return undefined;
  return {
    ...(context.operation !== undefined
      ? { operation: context.operation }
      : {}),
    ...(context.parameters !== undefined
      ? {
          parameters: sanitizeValue(context.parameters) as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}

export function classifyError(code: SorokitErrorCode): SorokitErrorCategory {
  if (
    code === SorokitErrorCode.INVALID_CONFIG ||
    code === SorokitErrorCode.INVALID_ADDRESS ||
    code === SorokitErrorCode.MAINNET_SAFETY_LIMIT ||
    code === SorokitErrorCode.VALIDATION
  ) {
    return SorokitErrorCategory.VALIDATION;
  }
  if (code === SorokitErrorCode.OPERATION_TIMEOUT)
    return SorokitErrorCategory.TIMEOUT;
  if (
    [
      SorokitErrorCode.NETWORK_ERROR,
      SorokitErrorCode.INVALID_NETWORK,
      SorokitErrorCode.SERVICE_UNAVAILABLE,
    ].includes(code)
  ) {
    return SorokitErrorCategory.NETWORK;
  }
  if (
    code.startsWith("CONTRACT") ||
    code === SorokitErrorCode.SOROBAN_SIMULATION_FAILED ||
    code === SorokitErrorCode.INSUFFICIENT_FEE ||
    code === SorokitErrorCode.INVALID_AUTH ||
    code === SorokitErrorCode.RESOURCE_LIMIT_EXCEEDED ||
    code === SorokitErrorCode.XDR_INVALID
  ) return SorokitErrorCategory.CONTRACT;
  if (code === SorokitErrorCode.RATE_LIMITED) return SorokitErrorCategory.NETWORK;
  if (code.startsWith("WALLET")) return SorokitErrorCategory.WALLET;
  if (
    code === SorokitErrorCode.INVALID_TRANSACTION ||
    code.startsWith("TX_") ||
    code.startsWith("ROUTER_")
  )
    return SorokitErrorCategory.TRANSACTION;
  if (
    code === SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND ||
    code.startsWith("ACCOUNT")
  ) {
    return SorokitErrorCategory.INTERNAL;
  }
  return SorokitErrorCategory.UNKNOWN;
}

export const SOURCE_ACCOUNT_RECOVERY_SUGGESTIONS: readonly string[] = Object.freeze([
  "retry: Verify network connectivity and endpoint status, then retry if the account fetch was transiently unavailable.",
  "wait: Wait for a pending account creation or funding transaction to confirm on-chain before retrying.",
  "create account: Create and fund the account with minimum reserve (at least 1 XLM) on the Stellar network before submitting transactions.",
  "use fallback: Use a fallback account or different active keypair with sufficient balance as the source account.",
]);

export function defaultRecoveryGuidance(
  category: SorokitErrorCategory,
  code?: SorokitErrorCode,
): RecoveryGuidance {
  if (
    code === SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND ||
    code === SorokitErrorCode.ACCOUNT_NOT_FOUND
  ) {
    return {
      retryable: true,
      action:
        "Account was not found on-ledger. Create/fund the account, wait for on-chain confirmation, or use a fallback account.",
      suggestions: [...SOURCE_ACCOUNT_RECOVERY_SUGGESTIONS],
    };
  }

  switch (category) {
    case SorokitErrorCategory.NETWORK:
      return {
        retryable: true,
        action:
          "Check connectivity and endpoint health, then retry with backoff.",
      };
    case SorokitErrorCategory.TIMEOUT:
      return {
        retryable: true,
        action:
          "Retry after confirming the operation has not already been submitted.",
      };
    case SorokitErrorCategory.VALIDATION:
      return {
        retryable: false,
        action: "Correct the reported input and submit the operation again.",
      };
    case SorokitErrorCategory.WALLET:
      return {
        retryable: false,
        action:
          "Reconnect or select an approved wallet and request authorization again.",
      };
    case SorokitErrorCategory.CONTRACT:
      return {
        retryable: false,
        action:
          "Inspect the contract error and simulation inputs before retrying.",
      };
    default:
      return {
        retryable: false,
        action:
          "Inspect the operation context and underlying cause before retrying.",
      };
  }
}

export function ok<T>(data: T): SorokitResult<T> {
  return Object.freeze({ status: "ok", data, error: null }) as SorokitResult<T>;
}

export function err<T>(
  code: SorokitErrorCode,
  message: string,
  cause?: unknown,
  traceId?: string,
  options?: SorokitErrorOptions,
): SorokitResult<T> {
  const category = classifyError(code);
  const recovery = options?.recovery ?? defaultRecoveryGuidance(category, code);
  const suggestions = options?.suggestions ?? recovery.suggestions;
  const error: SorokitError = {
    code,
    message,
    category,
    ...(cause !== undefined ? { cause } : {}),
    ...(options?.context
      ? { context: sanitizeErrorContext(options.context)! }
      : {}),
    recovery,
    ...(suggestions !== undefined ? { suggestions } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  };
  return Object.freeze({
    status: "error",
    data: null,
    error,
  }) as SorokitResult<T>;
}

export interface SourceAccountNotFoundOptions {
  accountId?: string;
  operation?: string;
  cause?: unknown;
  traceId?: string;
  scenario?: "retry" | "wait" | "create_account" | "use_fallback" | "all";
}

/**
 * Creates an error result for missing source accounts with actionable recovery suggestions.
 */
export function sourceAccountNotFoundError<T = never>(
  accountIdOrOptions?: string | SourceAccountNotFoundOptions,
  options?: SourceAccountNotFoundOptions,
): SorokitResult<T> {
  const accountId =
    typeof accountIdOrOptions === "string"
      ? accountIdOrOptions
      : accountIdOrOptions?.accountId;
  const opts =
    typeof accountIdOrOptions === "object" ? accountIdOrOptions : (options ?? {});

  const suggestions = [...SOURCE_ACCOUNT_RECOVERY_SUGGESTIONS];
  return err<T>(
    SorokitErrorCode.SOURCE_ACCOUNT_NOT_FOUND,
    accountId
      ? `Source account not found: ${accountId}. The account must exist on-ledger and maintain minimum reserve.`
      : "Source account not found on the network. The account must exist on-ledger and maintain minimum reserve.",
    opts.cause,
    opts.traceId,
    {
      context: {
        operation: opts.operation ?? "resolveSourceAccount",
        parameters: accountId ? { accountId } : undefined,
      },
      recovery: {
        retryable: true,
        action:
          "Account does not exist on-ledger. Create/fund the account, wait for on-chain confirmation, or use a fallback account.",
        suggestions,
      },
      suggestions,
    },
  );
}

export function attachTraceId<T>(
  result: SorokitResult<T>,
  traceId: string,
): SorokitResult<T> {
  if (result.status === "error" && result.error.traceId === undefined) {
    return { ...result, error: { ...result.error, traceId } };
  }
  return result;
}

export function isOk<T>(
  result: SorokitResult<T>,
): result is { status: "ok"; data: T; error: null } {
  return result.status === "ok";
}

export function isErr<T>(
  result: SorokitResult<T>,
): result is { status: "error"; data: null; error: SorokitError } {
  return result.status === "error";
}

export function isErrorCode<T, C extends SorokitErrorCode>(
  result: SorokitResult<T>,
  code: C,
): result is {
  status: "error";
  data: null;
  error: SorokitError & { code: C };
} {
  return result.status === "error" && result.error.code === code;
}

export function assertOk<T>(
  result: SorokitResult<T>,
): asserts result is { status: "ok"; data: T; error: null } {
  if (result.status === "error") {
    throw new Error(
      `Expected ok result but got error: [${result.error.code}] ${result.error.message}`,
    );
  }
}
