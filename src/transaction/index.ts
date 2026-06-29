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

export interface FeeHistoryPercentiles {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface FeeHistoryAnalytics {
  windowSize: number;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  stddev: number | null;
  percentiles: FeeHistoryPercentiles;
}

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

function parseTransactionFee(fee: string | number | undefined): number | null {
  if (fee == null || fee === "") {
    return null;
  }

  const parsed = typeof fee === "number" ? fee : Number.parseFloat(fee);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function calculatePercentiles(values: number[]): FeeHistoryPercentiles {
  if (values.length === 0) {
    return {
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (ratio: number): number | null => {
    if (sorted.length === 0) {
      return null;
    }

    const index = Math.min(Math.floor(ratio * sorted.length), sorted.length - 1);
    return sorted[index] ?? null;
  };

  return {
    p10: percentile(0.1),
    p25: percentile(0.25),
    p50: percentile(0.5),
    p75: percentile(0.75),
    p90: percentile(0.9),
  };
}

export function analyzeFeeHistory(
  recentTransactions: Array<{ fee?: string | number }>,
  windowSize: number,
): FeeHistoryAnalytics {
  const normalizedWindowSize = Number.isFinite(windowSize) && windowSize > 0 ? Math.floor(windowSize) : 0;
  const window = normalizedWindowSize > 0
    ? recentTransactions.slice(-normalizedWindowSize)
    : recentTransactions;
  const fees = window
    .map((transaction) => parseTransactionFee(transaction.fee))
    .filter((fee): fee is number => fee != null);

  if (fees.length === 0) {
    return {
      windowSize: normalizedWindowSize,
      count: 0,
      min: null,
      max: null,
      avg: null,
      median: null,
      stddev: null,
      percentiles: {
        p10: null,
        p25: null,
        p50: null,
        p75: null,
        p90: null,
      },
    };
  }

  const sorted = [...fees].sort((a, b) => a - b);
  const count = fees.length;
  const sum = fees.reduce((acc, fee) => acc + fee, 0);
  const avg = sum / count;
  const median = count % 2 === 0
    ? (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2
    : sorted[(count - 1) / 2]!;
  const variance = fees.reduce((acc, fee) => acc + (fee - avg) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);

  return {
    windowSize: normalizedWindowSize,
    count,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    avg,
    median,
    stddev,
    percentiles: calculatePercentiles(fees),
  };
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
  buildCreateLiquidityPool,
  buildDepositLiquidityPool,
  buildWithdrawLiquidityPool,
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
  CreateLiquidityPoolParams,
  DepositLiquidityPoolParams,
  WithdrawLiquidityPoolParams,
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

// ─── exportTransactionHistory ─────────────────────────────────────────────────

/**
 * Export transaction history in CSV or JSON format.
 * Includes all transaction fields in the export.
 *
 * @param transactions - Array of TransactionResult objects to export
 * @param format - Export format: 'csv' or 'json'
 * @returns Formatted string (CSV or JSON)
 */
export function exportTransactionHistory(
  transactions: TransactionResult[],
  format: "csv" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(transactions, null, 2);
  }

  if (format === "csv") {
    if (transactions.length === 0) {
      return "";
    }

    const headers = [
      "hash",
      "status",
      "ledger",
      "createdAt",
      "fee",
      "envelopeXdr",
      "resultXdr",
    ];
    const rows = transactions.map((tx) => [
      escapeCsvField(tx.hash),
      escapeCsvField(tx.status),
      tx.ledger?.toString() ?? "",
      escapeCsvField(tx.createdAt ?? ""),
      escapeCsvField(tx.fee ?? ""),
      escapeCsvField(tx.envelopeXdr ?? ""),
      escapeCsvField(tx.resultXdr ?? ""),
    ]);

    const headerRow = headers.join(",");
    const dataRows = rows.map((row) => row.join(","));
    return [headerRow, ...dataRows].join("\n");
  }

  throw new Error("Unsupported export format. Use 'csv' or 'json'.");
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ─── predictNetworkFee ────────────────────────────────────────────────────────

/**
 * Predict network fee based on recent transaction fee trends.
 * Analyzes recent fees and predicts the fee minutesAhead in the future.
 *
 * @param horizonUrl - Horizon server URL to fetch recent transactions
 * @param minutesAhead - Number of minutes to predict ahead (1-60)
 * @returns Predicted fee in stroops
 */
export async function predictNetworkFee(
  horizonUrl: string,
  minutesAhead: number = 5,
): Promise<string> {
  if (minutesAhead < 1 || minutesAhead > 60) {
    throw new Error("minutesAhead must be between 1 and 60.");
  }

  try {
    const url = new URL(horizonUrl);
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    url.pathname += "transactions";
    url.searchParams.set("limit", "10");
    url.searchParams.set("order", "desc");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch transactions: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      _embedded?: { records?: Array<{ max_fee?: string }> };
    };
    const records = data._embedded?.records ?? [];

    if (records.length === 0) {
      return "100";
    }

    const fees = records
      .map((r) => {
        const fee = r.max_fee ?? "0";
        return BigInt(fee);
      })
      .sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });

    const median = fees[Math.floor(fees.length / 2)];
    const max = fees[fees.length - 1];
    const min = fees[0];
    const avgTrend = (max! - min!) / BigInt(fees.length);

    const minuteFraction = BigInt(minutesAhead) / BigInt(60);
    const predictedFee = median! + avgTrend * minuteFraction;

    return predictedFee.toString();
  } catch (cause) {
    throw new Error(`Failed to predict network fee: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
}


// ==========================================
// --- EXPORT HISTORY ENGINE (ISSUE #133) ---
// ==========================================

export interface TransactionRecord {
  id: string;
  timestamp: number;
  amount: number;
  currency: string;
  sender: string;
  receiver: string;
  status: 'success' | 'failed' | 'pending';
}

/**
 * Exports transaction history into formatted CSV or JSON strings for auditing.
 */
export function exportTransactionHistory(
  transactions: TransactionRecord[],
  format: 'csv' | 'json'
): string {
  if (format === 'json') {
    return JSON.stringify(transactions, null, 2);
  }

  if (format === 'csv') {
    if (transactions.length === 0) {
      return "id,timestamp,amount,currency,sender,receiver,status";
    }

    const headers = ['id', 'timestamp', 'amount', 'currency', 'sender', 'receiver', 'status'] as (keyof TransactionRecord)[];
    const csvHeader = headers.join(',');

    const csvRows = transactions.map(tx => {
      return headers.map(header => {
        const val = tx[header];
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val}"`;
        }
        return val;
      }).join(',');
    });

    return [csvHeader, ...csvRows].join('\n');
  }

  throw new Error(`Unsupported export format: ${format}`);
}

// --- AUTOMATED IN-SOURCE TEST MATRIX ---
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const mockTransactions: TransactionRecord[] = [
    {
      id: "tx_01",
      timestamp: 1719677880,
      amount: 250,
      currency: "XLM",
      sender: "G_SENDER_AAA",
      receiver: "G_RECEIVER_BBB",
      status: "success"
    },
    {
      id: "tx_02",
      timestamp: 1719677940,
      amount: 15,
      currency: "USD",
      sender: "G_RECEIVER_BBB",
      receiver: "G_SENDER_AAA",
      status: "failed"
    }
  ];

  describe("Issue #133 - Transaction Export Utility Tests", () => {
    it("should correctly format transaction listings into structured JSON strings", () => {
      const output = exportTransactionHistory(mockTransactions, 'json');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe("tx_01");
    });

    it("should compile records into comma-separated CSV rows", () => {
      const output = exportTransactionHistory(mockTransactions, 'csv');
      const lines = output.split('\n');
      expect(lines[0]).toBe("id,timestamp,amount,currency,sender,receiver,status");
      expect(lines[1]).toBe("tx_01,1719677880,250,XLM,G_SENDER_AAA,G_RECEIVER_BBB,success");
    });
  });
}