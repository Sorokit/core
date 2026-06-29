import { Asset, Memo } from "@stellar/stellar-sdk";

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
    const avgTrend = (max - min) / BigInt(fees.length);

    const minuteFraction = BigInt(minutesAhead) / BigInt(60);
    const predictedFee = median + avgTrend * minuteFraction;

    return predictedFee.toString();
  } catch (cause) {
    throw new Error(`Failed to predict network fee: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
}

