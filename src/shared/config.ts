/**
 * Per-operation timeout configuration (#207).
 *
 * Defines default timeout values for different operation types.
 * These can be overridden per-call or globally at client creation.
 */

import { DEFAULT_OPERATION_TIMEOUT_MS } from "./constants";

/**
 * Operation type identifiers for timeout configuration.
 */
export type OperationType =
  | "wallet_connect"
  | "wallet_disconnect"
  | "wallet_sign"
  | "account_get"
  | "account_get_offers"
  | "account_get_trades"
  | "account_get_batch"
  | "account_get_balances"
  | "account_stream"
  | "tx_build"
  | "tx_submit"
  | "tx_status"
  | "tx_estimate_fee"
  | "tx_stream"
  | "tx_validate_destination"
  | "tx_query_history"
  | "tx_export_history"
  | "soroban_get_methods"
  | "soroban_simulate"
  | "soroban_prepare"
  | "soroban_execute"
  | "soroban_invoke"
  | "soroban_read";

/**
 * Default timeout values for each operation type (in milliseconds).
 * These are reasonable defaults based on typical operation durations.
 */
export const DEFAULT_TIMEOUTS: Record<OperationType, number> = {
  // Wallet operations - typically fast (user interaction)
  wallet_connect: 30000,      // 30s - user may need to approve
  wallet_disconnect: 5000,    // 5s - should be instant
  wallet_sign: 60000,         // 60s - user may need time to review

  // Account operations - network dependent
  account_get_offers: 10000,
  account_get_trades: 10000,
  account_get: 10000,         // 10s - single Horizon query
  account_get_batch: 30000,   // 30s - multiple parallel queries
  account_get_balances: 10000, // 10s - single Horizon query
  account_stream: 0,          // 0 = no timeout (streaming)

  // Transaction operations - vary by complexity
  tx_build: 5000,             // 5s - local operation
  tx_submit: 30000,           // 30s - network submission
  tx_status: 10000,           // 10s - Horizon query
  tx_estimate_fee: 60000,     // 60s - may require simulation
  tx_stream: 0,               // 0 = no timeout (streaming)
  tx_validate_destination: 15000, // 15s - Horizon query + validation
  tx_query_history: 20000,    // 20s - may involve pagination
  tx_export_history: 30000,   // 30s - may involve large data

  // Soroban operations - can be slow due to simulation
  soroban_get_methods: 15000, // 15s - contract metadata fetch
  soroban_simulate: 60000,    // 60s - RPC simulation
  soroban_prepare: 60000,     // 60s - simulation + assembly
  soroban_execute: 120000,    // 120s - submission + polling
  soroban_invoke: 120000,     // 120s - full pipeline
  soroban_read: 30000,        // 30s - contract data read
};

/**
 * Global timeout override applied to all operations.
 * Set via createSorokitClient() config.
 */
export type GlobalTimeoutOverride = number | null;

/**
 * Resolve the effective timeout for an operation (#392).
 *
 * Precedence:
 * 1. Per-call override (the operation's `timeoutMs` parameter)
 * 2. Client-level global override (`config.timeoutMs`)
 * 3. Client-level default (`config.defaultTimeoutMs`)
 * 4. Operation-specific default from DEFAULT_TIMEOUTS
 * 5. DEFAULT_OPERATION_TIMEOUT_MS (30 s, from shared/constants)
 */
export function resolveOperationTimeout(
  operationType: OperationType,
  perCallMs?: number | null,
  clientDefaultMs?: number | null,
  globalOverride?: GlobalTimeoutOverride,
): number {
  if (typeof perCallMs === "number" && !isNaN(perCallMs)) {
    return perCallMs;
  }
  if (globalOverride !== undefined && globalOverride !== null) {
    return globalOverride;
  }
  if (typeof clientDefaultMs === "number" && !isNaN(clientDefaultMs)) {
    return clientDefaultMs;
  }
  return DEFAULT_TIMEOUTS[operationType] ?? DEFAULT_OPERATION_TIMEOUT_MS;
}

/**
 * Get the timeout for a specific operation type.
 * 
 * @param operationType - The operation type
 * @param overrideMs - Optional per-call override
 * @param globalOverride - Optional global override from client config
 * @returns Timeout in milliseconds, or 0 for no timeout
 */
export function getTimeout(
  operationType: OperationType,
  overrideMs?: number,
  globalOverride?: GlobalTimeoutOverride,
): number {
  // Per-call override takes precedence
  if (overrideMs !== undefined && overrideMs !== null) {
    return overrideMs;
  }

  // Global override takes second precedence
  if (globalOverride !== undefined && globalOverride !== null) {
    return globalOverride;
  }

  // Default to operation-specific timeout
  return DEFAULT_TIMEOUTS[operationType];
}

/**
 * Validate a timeout value.
 * 
 * @param timeoutMs - Timeout in milliseconds
 * @returns true if valid, false otherwise
 */
export function isValidTimeout(timeoutMs: number): boolean {
  return (
    typeof timeoutMs === "number" &&
    !isNaN(timeoutMs) &&
    timeoutMs >= 0 &&
    timeoutMs <= 600000 // Max 10 minutes
  );
}

/**
 * Create an AbortSignal with the specified timeout.
 * 
 * @param timeoutMs - Timeout in milliseconds (0 = no timeout)
 * @returns AbortSignal or undefined if no timeout
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs === 0) {
    return undefined;
  }

  return AbortSignal.timeout(timeoutMs);
}
