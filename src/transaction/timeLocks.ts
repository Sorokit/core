/**
 * Time-locked transaction scheduling and execution (#587).
 *
 * Provides time-lock support for scheduling transactions to execute at
 * specific future times using Stellar time bounds (ledger close time).
 */

import {
  BASE_FEE,
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
 * Time-lock execution eligibility check result.
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
 * Build a time-locked transaction with min/max time bounds.
 *
 * Uses Stellar time bounds (ledger close time in seconds) to restrict
 * when the transaction can be executed.
 *
 * @param source - Source account public key (G... address)
 * @param operations - Transaction operations to add
 * @param timeBounds - Min and max times (seconds since epoch)
 * @param networkPassphrase - Network passphrase
 * @param baseFee - Per-operation fee in stroops (defaults to BASE_FEE)
 * @returns A SorokitResult containing the unsigned transaction XDR
 *
 * @example
 * const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour
 * const tx = await buildTimeLockTransaction(source, operations, {
 *   minTime: futureTime,
 *   maxTime: futureTime + 86400, // valid for 24h
 * }, networkPassphrase);
 */
export function buildTimeLockTransaction(
  source: string,
  operations: any[],
  timeBounds: TimeBounds,
  networkPassphrase: string,
  baseFee?: string | number,
): SorokitResult<string> {
  if (!StrKey.isValidEd25519PublicKey(source)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid source account address: ${source}. Expected G... address.`,
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

  const fee = baseFee ? String(baseFee) : BASE_FEE;

  try {
    const builder = new TransactionBuilder(
      {
        id: () => source,
        sequence: () => "1",
        incrementSequenceNumber: () => {},
      } as any,
      {
        fee,
        networkPassphrase,
        timebounds: {
          minTime,
          maxTime,
        },
      },
    );

    for (const operation of operations) {
      builder.addOperation(operation);
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

/**
 * Check if a time-locked transaction is eligible for execution.
 *
 * @param timeBounds - The time bounds from the transaction
 * @param currentTime - Current ledger close time (defaults to now)
 * @returns A SorokitResult containing execution eligibility details
 *
 * @example
 * const status = await getTimeLockedTransactionStatus(tx.timebounds);
 * if (status.status === "ok" && status.data.canExecute) {
 *   // Transaction is ready to execute
 * }
 */
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
