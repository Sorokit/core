import { Asset, Horizon, Memo } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, isValidPublicKey, retryWithBackoff, toMessage } from "../shared";
import type { ResolvedNetworkConfig } from "../shared/types";
import { MIN_ACCOUNT_BALANCE_XLM } from "../shared/constants";
import { buildCreateAccountTransaction } from "./buildTransaction";
import type { MemoParams } from "./types";

export type SorokitMemo =
  | ReturnType<typeof Memo.text>
  | ReturnType<typeof Memo.id>
  | ReturnType<typeof Memo.hash>
  | ReturnType<typeof Memo.return>;

const MAX_TEXT_MEMO_BYTES = 28;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const HASH_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeHash(hash: string | Buffer | Uint8Array): string | Buffer {
  if (typeof hash === "string") {
    if (!HASH_HEX_PATTERN.test(hash)) {
      throw new Error("Hash memo must be a 32-byte hex string.");
    }
    return hash;
  }

  if (hash.length !== 32) {
    throw new Error("Hash memo must be exactly 32 bytes.");
  }

  return Buffer.from(hash);
}

export function createTextMemo(text: string): SorokitMemo {
  if (typeof text !== "string") {
    throw new Error("Text memo must be a string.");
  }

  if (byteLength(text) > MAX_TEXT_MEMO_BYTES) {
    throw new Error("Text memo must be 28 bytes or fewer.");
  }

  return Memo.text(text);
}

export function createIdMemo(id: string | number | bigint): SorokitMemo {
  let value: bigint;

  try {
    value = typeof id === "bigint" ? id : BigInt(id);
  } catch {
    throw new Error("ID memo must be an unsigned 64-bit integer.");
  }

  if (value < 0n || value > UINT64_MAX) {
    throw new Error("ID memo must be an unsigned 64-bit integer.");
  }

  return Memo.id(value.toString());
}

export function createHashMemo(hash: string | Buffer | Uint8Array): SorokitMemo {
  return Memo.hash(normalizeHash(hash));
}

export function createReturnMemo(hash: string | Buffer | Uint8Array): SorokitMemo {
  return Memo.return(normalizeHash(hash) as any);
}

export {
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
  buildPaymentWithTrustline,
  buildSwapTransaction,
  buildReverseTransaction,
  buildPathPayment,
  buildAtomicSwap,
  buildAccountMerge,
} from "./buildTransaction";
export type { AccountMergeOptions } from "./buildTransaction";
export { submitTransaction } from "./submitTransaction";
export { getTransactionStatus } from "./status";
export { estimateFee } from "./estimateFee";
export { streamTransactions } from "./streamTransactions";
export { createTransactionContext, TRANSACTION_CONTEXT_TTL_MS } from "./transactionContext";
export type { TransactionBuilderContext } from "./transactionContext";
export type {
  TransactionResult,
  TransactionStatus,
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  PaymentWithTrustlineParams,
  SwapTransactionParams,
  ReverseTransactionParams,
  PathPaymentParams,
  PathPaymentMode,
  AtomicSwapParams,
} from "./types";
export type { FeeEstimate, FeeEstimateInput, FeeEstimateOptions } from "./estimateFee";
export type {
  TransactionStreamConfig,
  TransactionPage,
} from "./streamTransactions";

export {
  validateTransactionXdr,
  DEFAULT_VALIDATION_RULES,
} from "./validateTransactionXdr";
export type {
  TransactionValidationFinding,
  TransactionValidationReport,
  ValidationRules,
} from "./validateTransactionXdr";

export { validateDestination } from "./validateDestination";
export type {
  DestinationValidationResult,
  ValidateDestinationOptions,
} from "./validateDestination";

// ─── Options for prepareAccountCreation ──────────────────────────────────────

export interface PrepareAccountCreationOptions extends MemoParams {
  /**
   * When true, verifies that the destination account does NOT already exist
   * on-chain before building the transaction. Requires `horizonUrl` to be
   * passed via the network config.
   * @default false
   */
  checkDestinationExists?: boolean;

  /**
   * When true, reuses a 5-second module-level sequence cache to avoid
   * repeated Horizon round trips (forwarded to the underlying builder).
   */
  autoFetchSequence?: boolean;
}

// ─── prepareAccountCreation (#113) ───────────────────────────────────────────

/**
 * Prepare an unsigned create-account transaction XDR with explicit
 * Stellar-specific validation.
 *
 * Validation steps performed before building:
 * 1. **Minimum balance** — `startingBalance` must be >= 1 XLM.
 * 2. **Public key format** — both `sourceKey` and `destinationKey` must be
 *    valid G-addresses.
 * 3. **Destination exists check** (opt-in) — when `options.checkDestinationExists`
 *    is `true`, queries Horizon to ensure the destination account does NOT
 *    already exist (creating an account that already exists is an error on-chain).
 * 4. **Memo handling** — forwards memo parameters to the underlying builder.
 *
 * @param horizonUrl    - Horizon base URL (from `networkConfig.horizonUrl`).
 * @param networkConfig - Resolved network configuration.
 * @param sourceKey     - G-address of the funding (source) account.
 * @param destinationKey - G-address of the account to be created.
 * @param startingBalance - Starting balance in XLM. Defaults to `"1"` (minimum).
 * @param options       - Optional memo params and destination-existence check flag.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          `error(INVALID_BALANCE)` when balance is below 1 XLM,
 *          `error(TX_BUILD_FAILED)` on key-format or memo errors,
 *          `error(ACCOUNT_FETCH_FAILED)` when the destination-exists check fails.
 *
 * @example
 * const result = await prepareAccountCreation(
 *   networkConfig.horizonUrl,
 *   networkConfig,
 *   "GSOURCE...",
 *   "GDEST...",
 *   "2",
 *   { checkDestinationExists: true },
 * );
 * if (result.status === "ok") {
 *   // sign result.data and submit
 * }
 */
export async function prepareAccountCreation(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourceKey: string,
  destinationKey: string,
  startingBalance: string = MIN_ACCOUNT_BALANCE_XLM,
  options?: PrepareAccountCreationOptions,
): Promise<SorokitResult<string>> {
  // 1. Validate source key format
  if (!isValidPublicKey(sourceKey)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Source key is not a valid Stellar public key: ${sourceKey}`,
    );
  }

  // 2. Validate destination key format
  if (!isValidPublicKey(destinationKey)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Destination key is not a valid Stellar public key: ${destinationKey}`,
    );
  }

  // 3. Minimum balance check — must be >= 1 XLM
  const balanceNum = parseFloat(startingBalance);
  if (
    isNaN(balanceNum) ||
    balanceNum < parseFloat(MIN_ACCOUNT_BALANCE_XLM)
  ) {
    return err(
      SorokitErrorCode.INVALID_BALANCE,
      `Starting balance must be at least ${MIN_ACCOUNT_BALANCE_XLM} XLM. Received: ${startingBalance}`,
    );
  }

  // 4. Optional destination-existence check
  //    For account creation, the destination must NOT already exist.
  if (options?.checkDestinationExists) {
    try {
      await retryWithBackoff(async () => {
        const server = new Horizon.Server(horizonUrl);
        return await server.loadAccount(destinationKey);
      });

      // loadAccount succeeded → account already exists → creation would fail
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Destination account ${destinationKey} already exists on-chain. Cannot create an account that already exists.`,
      );
    } catch (cause) {
      if (isNotFoundError(cause)) {
        // 404 → account does not exist → safe to proceed
      } else {
        return err(
          SorokitErrorCode.ACCOUNT_FETCH_FAILED,
          `Failed to verify destination account existence: ${toMessage(cause)}`,
          cause,
        );
      }
    }
  }

  // 5. Delegate to the existing builder (handles memo, sequence, XDR output)
  return buildCreateAccountTransaction(horizonUrl, networkConfig, sourceKey, {
    destination: destinationKey,
    startingBalance,
    memo: options?.memo,
    memoType: options?.memoType,
    requireMemo: options?.requireMemo,
    memoValidator: options?.memoValidator,
    autoFetchSequence: options?.autoFetchSequence,
  });
}

