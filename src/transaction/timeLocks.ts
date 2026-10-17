/**
 * Time-locked transaction scheduling and execution (#587).
 *
 * Provides time-lock support for scheduling transactions to execute at
 * specific future times using Stellar time bounds (ledger close time).
 *
 * Two call shapes are supported by `buildTimeLockTransaction`:
 *
 * 1. **Sequence-aware mode** — `(horizonUrl, networkConfig, sourcePublicKey,
 *    options)`. When `options.sequence` is absent the source account sequence is
 *    fetched from Horizon with `loadAccount`. Returns a promise.
 * 2. **Legacy mode** — `(source, operations, timeBounds, networkPassphrase,
 *    baseFee?)`. Builds locally against a placeholder sequence. Synchronous.
 */

import {
  Account,
  BASE_FEE,
  Horizon,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

/**
 * Time bounds configuration for a time-locked transaction.
 */
export interface TimeBounds {
  minTime: number;
  maxTime: number;
}

/**
 * Execution eligibility of a time-locked transaction.
 */
export type TimeLockStatus = "invalid" | "pending" | "executable" | "expired";

/**
 * Detailed time-lock execution eligibility.
 *
 * @deprecated Kept for consumers of the legacy `SorokitResult`-shaped
 * `getTimeLockedTransactionStatus`. The current contract returns
 * {@link TimeLockStatus} directly.
 */
export interface TimeLockExecutionStatus {
  canExecute: boolean;
  currentTime: number;
  minTime: number;
  maxTime: number;
  timeUntilExecutable: number;
  timeRemaining: number;
  reason?: string;
}

/**
 * Options for the sequence-aware `buildTimeLockTransaction` call shape.
 */
export interface TimeLockBuildOptions {
  timeBounds: TimeBounds;
  /**
   * Source account sequence. When omitted the sequence is fetched from Horizon
   * via `loadAccount`.
   */
  sequence?: string;
  /** Operations to include. Defaults to none. */
  operations?: unknown[];
  /** Per-operation fee in stroops. Defaults to {@link BASE_FEE}. */
  baseFee?: string | number;
}

/**
 * Validate time bounds for correctness.
 *
 * `maxTime === 0` means "no upper bound", so it is always accepted as long as
 * `minTime >= 0`. `minTime === maxTime` is a valid (instant) window.
 *
 * @param timeBounds - The time bounds to validate
 * @returns True when the bounds are usable
 */
export function isTimeBoundsValid(timeBounds: TimeBounds): boolean {
  if (!timeBounds || typeof timeBounds !== "object") {
    return false;
  }

  const { minTime, maxTime } = timeBounds;

  if (typeof minTime !== "number" || typeof maxTime !== "number") {
    return false;
  }

  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    return false;
  }

  if (minTime < 0 || maxTime < 0) {
    return false;
  }

  // maxTime === 0 means unbounded — skip the ordering check in that case.
  if (maxTime !== 0 && minTime > maxTime) {
    return false;
  }

  return true;
}

/**
 * Classify a time-locked transaction against a point in time.
 *
 * @param timeBounds - The time bounds from the transaction
 * @param currentTime - Current ledger close time in seconds (defaults to now)
 * @returns `"invalid"` for unusable bounds, `"pending"` before `minTime`,
 *          `"expired"` after a real `maxTime`, otherwise `"executable"`
 */
export function getTimeLockStatus(
  timeBounds: TimeBounds,
  currentTime?: number,
): TimeLockStatus {
  if (!isTimeBoundsValid(timeBounds)) {
    return "invalid";
  }

  const { minTime, maxTime } = timeBounds;
  const now = currentTime ?? Math.floor(Date.now() / 1000);

  if (now < minTime) {
    return "pending";
  }

  // maxTime === 0 means no upper bound.
  if (maxTime !== 0 && now > maxTime) {
    return "expired";
  }

  return "executable";
}

/**
 * Build a time-locked transaction, fetching the source account sequence from
 * Horizon when the caller does not supply one.
 *
 * @param horizonUrl - Horizon endpoint used to load the source account
 * @param networkConfig - Resolved network configuration (passphrase source)
 * @param sourcePublicKey - Source account public key (G... address)
 * @param options - Time bounds, optional sequence, operations and fee
 * @returns A promise resolving to a SorokitResult with the unsigned XDR
 */
export function buildTimeLockTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  options: TimeLockBuildOptions,
): Promise<SorokitResult<string>>;
/**
 * Legacy builder signature: builds locally against a placeholder sequence.
 *
 * @deprecated Prefer the sequence-aware call shape.
 */
export function buildTimeLockTransaction(
  source: string,
  operations: unknown[],
  timeBounds: TimeBounds,
  networkPassphrase: string,
  baseFee?: string | number,
): SorokitResult<string>;
export function buildTimeLockTransaction(
  first: string,
  second: ResolvedNetworkConfig | unknown[],
  third: string | TimeBounds,
  fourth: TimeLockBuildOptions | string,
  fifth?: string | number,
): SorokitResult<string> | Promise<SorokitResult<string>> {
  if (isTimeLockBuildOptions(fourth)) {
    return buildTimeLockTransactionWithSequenceFetch(
      first,
      third as string,
      second as ResolvedNetworkConfig,
      fourth,
    );
  }

  return buildTimeLockTransactionLocally(
    first,
    second as unknown[],
    third as TimeBounds,
    fourth as string,
    fifth,
  );
}

function isTimeLockBuildOptions(value: unknown): value is TimeLockBuildOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    "timeBounds" in (value as Record<string, unknown>)
  );
}

/**
 * Sequence-aware builder. Validation of the time bounds happens before any
 * network call, so invalid bounds never touch Horizon.
 */
async function buildTimeLockTransactionWithSequenceFetch(
  horizonUrl: string,
  sourcePublicKey: string,
  networkConfig: ResolvedNetworkConfig,
  options: TimeLockBuildOptions,
): Promise<SorokitResult<string>> {
  const timeBounds = options.timeBounds;

  if (!StrKey.isValidEd25519PublicKey(sourcePublicKey)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid source account address: ${sourcePublicKey}. Expected G... address.`,
    );
  }

  if (!isTimeBoundsValid(timeBounds)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid time bounds: minTime and maxTime must be non-negative and minTime must not exceed a non-zero maxTime",
    );
  }

  let sequence = options.sequence;

  if (sequence === undefined) {
    try {
      const server = new Horizon.Server(horizonUrl);
      const account = await server.loadAccount(sourcePublicKey);
      sequence = readAccountSequence(account);
    } catch (error) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to load source account sequence: ${String(error)}`,
        error,
      );
    }
  }

  if (!sequence) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Source account sequence must be a non-empty value",
    );
  }

  try {
    return buildWithAccount(
      new Account(sourcePublicKey, sequence),
      timeBounds,
      networkConfig.networkPassphrase,
      options.operations,
      options.baseFee,
    );
  } catch (error) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build time-lock transaction: ${String(error)}`,
      error,
    );
  }
}

/**
 * Read the sequence from a Horizon account record, preferring the accessor and
 * falling back to the raw field.
 */
function readAccountSequence(account: unknown): string | undefined {
  if (!account || typeof account !== "object") {
    return undefined;
  }

  const record = account as {
    sequenceNumber?: () => string;
    sequence?: string;
  };

  if (typeof record.sequenceNumber === "function") {
    return record.sequenceNumber();
  }

  return record.sequence;
}

/**
 * Legacy local builder: validates inputs and builds against sequence `"1"`.
 */
function buildTimeLockTransactionLocally(
  source: string,
  operations: unknown[],
  timeBounds: TimeBounds,
  networkPassphrase: string,
  baseFee?: string | number,
): SorokitResult<string> {
  // Accept any non-empty string for source — let TransactionBuilder surface
  // build errors (TX_BUILD_FAILED) instead of returning INVALID_ADDRESS for
  // test placeholder keys that are not valid Stellar G-addresses.
  if (!StrKey.isValidEd25519PublicKey(source)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid source account address: ${String(source)}. Expected G... address.`,
    );
  }

  if (!Array.isArray(operations) || operations.length === 0) {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      "Operations array must be non-empty",
    );
  }

  if (!networkPassphrase || typeof networkPassphrase !== "string") {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      "Network passphrase must be a non-empty string",
    );
  }

  if (typeof timeBounds !== "object" || !timeBounds.minTime || !timeBounds.maxTime) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must include minTime and maxTime",
    );
  }

  const minTime = Number(timeBounds.minTime);
  const maxTime = Number(timeBounds.maxTime);

  if (minTime < 0 || maxTime < 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must be non-negative integers",
    );
  }

  if (minTime >= maxTime) {
    return err(
      SorokitErrorCode.VALIDATION,
      "minTime must be less than maxTime",
    );
  }

  return buildWithAccount(
    {
      id: () => source,
      sequence: () => "1",
      incrementSequenceNumber: () => {},
    },
    timeBounds,
    networkPassphrase,
    operations,
    baseFee,
  );
}

/**
 * Build the envelope XDR from a TransactionBuilder-compatible source.
 */
function buildWithAccount(
  account: unknown,
  timeBounds: TimeBounds,
  networkPassphrase: string,
  operations: unknown[] | undefined,
  baseFee: string | number | undefined,
): SorokitResult<string> {
  const fee = baseFee ? String(baseFee) : BASE_FEE;
  const { minTime, maxTime } = timeBounds;

  try {
    const builder = new TransactionBuilder(account as never, {
      fee,
      networkPassphrase,
      timebounds: { minTime, maxTime },
    });

    for (const operation of operations ?? []) {
      builder.addOperation(operation as never);
    }

    const tx = builder.build();
    return ok(tx.toEnvelope().toXDR("base64"));
  } catch (error) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build time-locked transaction: ${String(error)}`,
      error,
    );
  }
}

/* --- pre-#808 public API, restored for backward compatibility --- */
export function getTimeLockedTransactionStatus(
  timeBounds: TimeBounds,
  currentTime?: number,
): SorokitResult<TimeLockExecutionStatus> {
  if (!timeBounds || typeof timeBounds !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must be a valid object",
    );
  }

  const minTime = Number(timeBounds.minTime);
  const maxTime = Number(timeBounds.maxTime);

  if (isNaN(minTime) || isNaN(maxTime)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must contain valid numeric values",
    );
  }

  const now = currentTime ?? Math.floor(Date.now() / 1000);

  const canExecute = now >= minTime && now <= maxTime;
  const timeUntilExecutable = Math.max(0, minTime - now);
  const timeRemaining = Math.max(0, maxTime - now);

  let reason: string | undefined;
  if (now < minTime) {
    reason = `Transaction not yet executable. Wait ${timeUntilExecutable} seconds.`;
  } else if (now > maxTime) {
    reason = "Transaction window has expired.";
  }

  const status: TimeLockExecutionStatus = {
    canExecute,
    currentTime: now,
    minTime,
    maxTime,
    timeUntilExecutable,
    timeRemaining,
    ...(reason ? { reason } : {}),
  };

  return ok(status);
}

/**
 * Validate time bounds for correctness.
 *
 * @param timeBounds - The time bounds to validate
 * @returns A SorokitResult indicating validity
 */
export function validateTimeBounds(
  timeBounds: TimeBounds,
): SorokitResult<void> {
  if (!timeBounds || typeof timeBounds !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must be a valid object",
    );
  }

  if (typeof timeBounds.minTime !== "number" || typeof timeBounds.maxTime !== "number") {
    return err(
      SorokitErrorCode.VALIDATION,
      "minTime and maxTime must be numbers",
    );
  }

  if (timeBounds.minTime < 0 || timeBounds.maxTime < 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Time bounds must be non-negative",
    );
  }

  if (timeBounds.minTime >= timeBounds.maxTime) {
    return err(
      SorokitErrorCode.VALIDATION,
      "minTime must be less than maxTime",
    );
  }

  return ok(undefined);
}
