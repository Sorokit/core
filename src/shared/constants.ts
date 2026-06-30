/**
 * Shared constants used across sorokit-core modules.
 * Centralised here to prevent magic numbers scattered across the codebase.
 */

/** Default transaction timeout in seconds */
export const DEFAULT_TX_TIMEOUT_SECONDS = 30;

/** Default Soroban polling: max attempts before giving up */
export const DEFAULT_POLL_MAX_ATTEMPTS = 20;

/** Default Soroban polling: interval between attempts in ms */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** Minimum starting balance for account creation in XLM */
export const MIN_ACCOUNT_BALANCE_XLM = "1";

/** Number of chars shown on each side of a shortened address */
export const DEFAULT_ADDRESS_DISPLAY_CHARS = 4;

/** Default contract metadata cache TTL in milliseconds */
export const DEFAULT_CONTRACT_METADATA_TTL_MS = 60 * 60 * 1000;

/** Default cache TTL for fee estimates in milliseconds (5 minutes) */
export const DEFAULT_FEE_CACHE_TTL_MS = 300_000;

/** Default cache TTL for transaction lookups in milliseconds (5 minutes) */
export const DEFAULT_TX_CACHE_TTL_MS = DEFAULT_FEE_CACHE_TTL_MS;
