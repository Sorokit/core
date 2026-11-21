import {
  Horizon,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Inclusive time bounds for a Stellar transaction.
 * Both fields are Unix timestamps in seconds.
 */
export interface TimeBounds {
  /** Earliest time the transaction is valid (Unix seconds). 0 means no lower bound. */
  minTime: number;
  /** Latest time the transaction is valid (Unix seconds). 0 means no upper bound. */
  maxTime: number;
}

/**
 * Status of a time-locked transaction evaluated against a given timestamp.
 */
export type TimeLockExecutionStatus =
  | "pending"   // current time is before minTime
  | "executable" // current time is within [minTime, maxTime]
  | "expired"   // current time is after maxTime (and maxTime !== 0)
  | "invalid";  // time bounds are logically invalid (e.g. minTime > maxTime)

/**
 * Options for buildTimeLockTransaction.
 */
export interface TimeLockTransactionOptions {
  /**
   * Time bounds to enforce on the transaction.
   */
  timeBounds: TimeBounds;
  /**
   * When provided, this sequence number is used directly and no Horizon fetch
   * is performed. Useful when the caller has already loaded the account.
   *
   * Must be the current on-chain sequence number of the source account
   * (TransactionBuilder will increment it by 1 automatically).
   */
  sequence?: string;
  /** Override the transaction fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidTimeBounds(timeBounds: TimeBounds): boolean {
  if (
    !timeBounds ||
    typeof timeBounds !== "object" ||
    !Number.isFinite(timeBounds.minTime) ||
    !Number.isFinite(timeBounds.maxTime)
  ) {
    return false;
  }
  if (timeBounds.minTime < 0 || timeBounds.maxTime < 0) return false;
  // maxTime === 0 means no upper bound, so no ordering constraint applies
  if (timeBounds.maxTime !== 0 && timeBounds.minTime > timeBounds.maxTime) {
    return false;
  }
  return true;
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Validate that a TimeBounds object is logically consistent.
 *
 * @param timeBounds - The time bounds to validate.
 * @returns `true` when the bounds are valid, `false` otherwise.
 *
 * @example
 * validateTimeBounds({ minTime: 0, maxTime: 0 }); // true — no bounds
 * validateTimeBounds({ minTime: 1000, maxTime: 2000 }); // true
 * validateTimeBounds({ minTime: 3000, maxTime: 2000 }); // false — inverted
 */
export function validateTimeBounds(timeBounds: TimeBounds): boolean {
  return isValidTimeBounds(timeBounds);
}

/**
 * Evaluate the execution status of a time-locked transaction at a given moment.
 *
 * @param timeBounds   - The time bounds set on the transaction.
 * @param nowSeconds   - Current time as Unix seconds. Defaults to `Date.now() / 1000`.
 * @returns The execution status at the given time.
 *
 * @example
 * const status = getTimeLockedTransactionStatus(
 *   { minTime: 1000, maxTime: 2000 },
 *   1500,
 * );
 * // status === "executable"
 */
export function getTimeLockedTransactionStatus(
  timeBounds: TimeBounds,
  nowSeconds?: number,
): TimeLockExecutionStatus {
  if (!isValidTimeBounds(timeBounds)) return "invalid";

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) return "invalid";

  if (timeBounds.minTime > 0 && now < timeBounds.minTime) return "pending";
  if (timeBounds.maxTime !== 0 && now > timeBounds.maxTime) return "expired";
  return "executable";
}

/**
 * Build an unsigned time-locked transaction XDR.
 *
 * The transaction uses a `bumpSequence` operation as a lightweight no-op that
 * is valid on any Stellar account. Time bounds are enforced via the transaction's
 * built-in timebounds, which Horizon validates at submission time.
 *
 * The function fetches the real account sequence number from Horizon unless a
 * `sequence` is supplied in options, avoiding `tx_bad_seq` on submission.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration (passphrase etc.).
 * @param sourcePublicKey - G-address of the transaction source account.
 * @param options         - Time bounds, optional pre-fetched sequence, optional fee.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any build error.
 *
 * @example
 * const result = await buildTimeLockTransaction(
 *   "https://horizon-testnet.stellar.org",
 *   networkConfig,
 *   sourcePublicKey,
 *   { timeBounds: { minTime: futureTimestamp, maxTime: 0 } },
 * );
 * if (result.status === "ok") {
 *   // sign and submit result.data
 * }
 */
export async function buildTimeLockTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  options: TimeLockTransactionOptions,
): Promise<SorokitResult<string>> {
  const { timeBounds, sequence, fee } = options;

  if (!isValidTimeBounds(timeBounds)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid time bounds: minTime (${timeBounds.minTime}) must not exceed maxTime (${timeBounds.maxTime}) when maxTime is non-zero.`,
    );
  }

  try {
    let sourceAccount: Account;

    if (sequence !== undefined) {
      // Use the caller-supplied sequence directly — no Horizon round trip
      sourceAccount = new Account(sourcePublicKey, sequence);
    } else {
      // Fetch the real account sequence from Horizon
      const server = new Horizon.Server(horizonUrl);
      const loaded = await server.loadAccount(sourcePublicKey);
      sourceAccount = new Account(sourcePublicKey, loaded.sequenceNumber());
    }

    // Use setTimebounds to encode both minTime and maxTime.
    // When maxTime is 0 (no upper bound), we still set a deadline via
    // setTimeout so Horizon does not reject the transaction for missing timebounds.
    // setTimebounds and setTimeout both set the max_time field and must NOT
    // be combined — use setTimebounds exclusively when maxTime is non-zero.
    let builder = new TransactionBuilder(sourceAccount, {
      fee: fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    }).addOperation(
      Operation.bumpSequence({
        bumpTo: sourceAccount.sequenceNumber(),
      }),
    );

    if (timeBounds.maxTime !== 0) {
      // maxTime is set — use setTimebounds to encode both bounds
      builder = builder.setTimebounds(timeBounds.minTime, timeBounds.maxTime);
    } else if (timeBounds.minTime !== 0) {
      // Only minTime is set — use setTimebounds(min, 0) to encode the lower bound,
      // then apply a safety deadline via setTimeout for Horizon compatibility
      builder = builder.setTimebounds(
        timeBounds.minTime,
        Math.floor(Date.now() / 1000) + DEFAULT_TX_TIMEOUT_SECONDS,
      );
    } else {
      // No bounds at all — just set a standard transaction timeout
      builder = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    }

    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build time-lock transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}
