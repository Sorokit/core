import {
  Account,
  TransactionBuilder,
  Operation,
  Horizon,
} from "@stellar/stellar-sdk";
import { SorokitResult, ok, err, SorokitErrorCode } from "../shared/response";
import {
  toMessage,
  isTimeoutError,
  isNetworkConnectivityError,
} from "../shared/errors";
import type { SorokitMemo } from "./index";

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_FEE = "100"; // stroops per operation
const DEFAULT_TX_TIMEOUT_SECONDS = 30;
const SEQUENCE_CACHE_TTL_MS = 5_000;

// ─── Sequence cache ───────────────────────────────────────────────────────────
const sequenceCache = new Map<string, { sequence: string; cachedAt: number }>();

function getSequenceCacheEntry(publicKey: string): Account | null {
  const entry = sequenceCache.get(publicKey);
  if (!entry || Date.now() - entry.cachedAt > SEQUENCE_CACHE_TTL_MS) {
    sequenceCache.delete(publicKey);
    return null;
  }
  return new Account(publicKey, entry.sequence);
}

function updateSequenceCache(publicKey: string, seqNum: string): void {
  sequenceCache.set(publicKey, { sequence: seqNum, cachedAt: Date.now() });
}

const POOL_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Describes a transaction build failure with proper error context.
 */
function describeTransactionBuildFailure(
  action: string,
  cause: unknown,
): string {
  if (isTimeoutError(cause)) {
    return `Failed to build ${action} transaction because Horizon timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Failed to build ${action} transaction due to network connectivity: ${toMessage(cause)}`;
  }
  return `Failed to build ${action} transaction: ${toMessage(cause)}`;
}

/**
 * Validates a liquidity pool ID.
 * Must be a 64-character hex string.
 */
function validatePoolId(poolId: string): SorokitResult<void> {
  if (typeof poolId !== "string" || poolId.trim() === "") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "liquidityPoolId is required.",
    );
  }
  if (!POOL_ID_PATTERN.test(poolId)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `liquidityPoolId must be a 64-character hex string, got: "${poolId}".`,
    );
  }
  return ok(undefined);
}

/**
 * Validates a positive decimal amount with at most 7 decimal places.
 */
function validatePoolAmount(
  label: string,
  amount: string,
): SorokitResult<void> {
  if (typeof amount !== "string" || amount.trim() === "") {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `${label} is required.`);
  }
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} must be a positive number, got: "${amount}".`,
    );
  }
  const match = amount.match(/^(\d+)\.?(\d*)$/);
  if (!match) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} has an invalid format: "${amount}". Expected a positive decimal number.`,
    );
  }
  const decimals = match[2]?.length ?? 0;
  if (decimals > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} exceeds maximum precision of 7 decimal places: "${amount}".`,
    );
  }
  return ok(undefined);
}

/**
 * Builder class for liquidity pool withdrawal transactions.
 * Provides a fluent interface for constructing withdrawals with slippage protection.
 */
export class LiquidityPoolWithdrawBuilder {
  private _poolId: string | null = null;
  private _shares: string | null = null;
  private _minAmountA: string | null = null;
  private _minAmountB: string | null = null;
  private _memo: SorokitMemo | null = null;
  private _horizonUrl: string;
  private _networkPassphrase: string;
  private _sourcePublicKey: string;
  private _autoFetchSequence: boolean = true;

  /**
   * Constructs a new LiquidityPoolWithdrawBuilder.
   * @param sourcePublicKey The public key of the source account.
   * @param horizonUrl The Horizon server URL.
   * @param networkPassphrase The Stellar network passphrase.
   */
  constructor(
    sourcePublicKey: string,
    horizonUrl: string,
    networkPassphrase: string,
  ) {
    this._sourcePublicKey = sourcePublicKey;
    this._horizonUrl = horizonUrl;
    this._networkPassphrase = networkPassphrase;
  }

  /**
   * Sets the liquidity pool ID to withdraw from.
   * @param poolId The pool ID (64 lowercase hex characters).
   */
  poolId(poolId: string): this {
    this._poolId = poolId;
    return this;
  }

  /**
   * Sets the LP shares to burn.
   * @param amount The number of shares (positive decimal, max 7 decimals).
   */
  shares(amount: string): this {
    this._shares = amount;
    return this;
  }

  /**
   * Sets the minimum asset A return.
   * @param amount Minimum amount of asset A to receive (positive decimal, max 7 decimals).
   */
  minAmountA(amount: string): this {
    this._minAmountA = amount;
    return this;
  }

  /**
   * Sets the minimum asset B return.
   * @param amount Minimum amount of asset B to receive (positive decimal, max 7 decimals).
   */
  minAmountB(amount: string): this {
    this._minAmountB = amount;
    return this;
  }

  /**
   * Sets a memo for the transaction.
   * @param memo A valid Stellar memo.
   */
  memo(memo: SorokitMemo): this {
    this._memo = memo;
    return this;
  }

  /**
   * Enables or disables automatic sequence number fetching from Horizon.
   * @param enable If true, sequence is cached and reused; if false, always fetch fresh.
   */
  autoFetchSequence(enable: boolean): this {
    this._autoFetchSequence = enable;
    return this;
  }

  /**
   * Builds and returns the transaction XDR as a SorokitResult.
   * Validates all required parameters and returns an error if validation fails.
   */
  async build(): Promise<SorokitResult<string>> {
    // ── Pool ID validation ─────────────────────────────────────────────────────
    if (this._poolId === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Pool ID is required. Call .poolId() first.",
      );
    }
    const poolIdResult = validatePoolId(this._poolId);
    if (poolIdResult.status === "error") return poolIdResult;

    // ── Shares amount validation ───────────────────────────────────────────────
    if (this._shares === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Share amount is required. Call .shares() first.",
      );
    }
    const sharesResult = validatePoolAmount("shares", this._shares);
    if (sharesResult.status === "error") return sharesResult;

    // ── Min amount A validation ────────────────────────────────────────────────
    if (this._minAmountA === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Minimum amount A is required. Call .minAmountA() first.",
      );
    }
    const minAResult = validatePoolAmount("minAmountA", this._minAmountA);
    if (minAResult.status === "error") return minAResult;

    // ── Min amount B validation ────────────────────────────────────────────────
    if (this._minAmountB === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Minimum amount B is required. Call .minAmountB() first.",
      );
    }
    const minBResult = validatePoolAmount("minAmountB", this._minAmountB);
    if (minBResult.status === "error") return minBResult;

    // ── Build transaction ──────────────────────────────────────────────────────
    try {
      const useCache = this._autoFetchSequence;
      let sourceAccount:
        | Account
        | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

      if (useCache) {
        const cached = getSequenceCacheEntry(this._sourcePublicKey);
        if (cached) {
          sourceAccount = cached;
        } else {
          const server = new Horizon.Server(this._horizonUrl);
          sourceAccount = await server.loadAccount(this._sourcePublicKey);
        }
      } else {
        const server = new Horizon.Server(this._horizonUrl);
        sourceAccount = await server.loadAccount(this._sourcePublicKey);
      }

      const builder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this._networkPassphrase,
      })
        .addOperation(
          Operation.liquidityPoolWithdraw({
            liquidityPoolId: this._poolId,
            amount: this._shares,
            minAmountA: this._minAmountA,
            minAmountB: this._minAmountB,
          }),
        )
        .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

      if (this._memo) {
        builder.addMemo(this._memo);
      }

      const tx = builder.build();

      if (useCache) {
        updateSequenceCache(
          this._sourcePublicKey,
          sourceAccount.sequenceNumber(),
        );
      }

      return ok(tx.toXDR());
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        describeTransactionBuildFailure("liquidity pool withdraw", cause),
        cause,
      );
    }
  }
}

/**
 * Factory function to create a new LiquidityPoolWithdrawBuilder.
 * @param sourcePublicKey The public key of the source account.
 * @param horizonUrl The Horizon server URL.
 * @param networkPassphrase The Stellar network passphrase.
 * @returns A new builder instance ready for configuration.
 */
export function createLiquidityPoolWithdrawBuilder(
  sourcePublicKey: string,
  horizonUrl: string,
  networkPassphrase: string,
): LiquidityPoolWithdrawBuilder {
  return new LiquidityPoolWithdrawBuilder(
    sourcePublicKey,
    horizonUrl,
    networkPassphrase,
  );
}
