import { Asset, Memo } from "@stellar/stellar-sdk";

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

