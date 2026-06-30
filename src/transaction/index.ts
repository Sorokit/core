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
  checkTrustlines,
  buildBulkTrustlines,
} from "./buildTransaction";
export { submitTransaction } from "./submitTransaction";
export { getTransactionStatus } from "./status";
export { estimateFee } from "./estimateFee";
export { streamTransactions } from "./streamTransactions";
export { validateTransaction } from "./validateTransaction";
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
export type {
  ValidationIssue,
  TransactionValidationContext,
  CustomValidationRule,
  ParsedOperation,
} from "./validateTransaction";
// Note: ValidationRules and TransactionValidationReport are re-exported below from validateTransactionXdr

export {
  validateTransactionXdr,
  DEFAULT_VALIDATION_RULES,
} from "./validateTransactionXdr";
export type {
  TransactionValidationFinding,
  TransactionValidationReport,
  ValidationRules,
} from "./validateTransactionXdr";

// ─── Asset constants and factories ───────────────────────────────────────────
export const USDC_MAINNET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDT_MAINNET_ISSUER = "GCVJWGVZCVSRMEMEMIYLAUQDFKCEH6HMA5HZGBF4QSQCIIQG7HFIC76L";
export const EURC_MAINNET_ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
export const EURC_TESTNET_ISSUER = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

export function nativeAsset(): Asset {
  return Asset.native();
}

export function usdcAsset(issuer?: string): Asset {
  return new Asset("USDC", issuer || USDC_MAINNET_ISSUER);
}

export function usdtAsset(issuer?: string): Asset {
  return new Asset("USDT", issuer || USDT_MAINNET_ISSUER);
}

export function usdt_assetAsset(issuer?: string): Asset {
  return usdtAsset(issuer);
}

export function eurcAsset(issuer?: string): Asset {
  return new Asset("EURC", issuer || EURC_MAINNET_ISSUER);
}

export { nativeAsset as ativeAsset };
