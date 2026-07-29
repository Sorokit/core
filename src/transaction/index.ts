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

export function createHashMemo(
  hash: string | Buffer | Uint8Array,
): SorokitMemo {
  return Memo.hash(normalizeHash(hash));
}

export function createReturnMemo(
  hash: string | Buffer | Uint8Array,
): SorokitMemo {
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
  checkTrustlines,
  buildBulkTrustlines,
  clearSequenceCache,
} from "./buildTransaction";
export type { AccountMergeOptions } from "./buildTransaction";
export { submitTransaction } from "./submitTransaction";
export { getTransactionStatus } from "./status";
export { estimateFee } from "./estimateFee";
export { streamTransactions } from "./streamTransactions";
export {
  exportTransactionHistory,
  formatTransactionsToCsv,
  formatTransactionsToJson,
} from "./exportTransactionHistory";
export { validateTransaction } from "./validateTransaction";
export { validateTransactionOffline } from "./validateTransactionOffline";
export type { OfflineValidationIssue, OfflineValidationReport, OfflineValidationOptions } from "./validateTransactionOffline";
export {
  createTransactionContext,
  TRANSACTION_CONTEXT_TTL_MS,
} from "./transactionContext";
export type { TransactionBuilderContext } from "./transactionContext";
export {
  createTransactionBuilder,
} from "./transactionBuilder";
export type {
  TransactionBuilder,
  TransactionOperation,
} from "./transactionBuilder";
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
export type {
  FeeEstimate,
  FeeEstimateInput,
  FeeEstimateOptions,
  FeeTiers,
  CongestionFeeEstimate,
} from "./estimateFee";
export { fetchCongestionFeeEstimate } from "./estimateFee";
export {
  findSwapPath,
  buildPathPaymentTransaction,
  describeRouterSwapFailure,
} from "./pathPayment";
export type {
  SwapRoute,
  SwapRouteAsset,
  FindSwapPathOptions,
  BuildPathPaymentParams,
} from "./pathPayment";
export type {
  TransactionStreamConfig,
  TransactionPage,
} from "./streamTransactions";
export {
  queryTransactionHistory,
} from "./queryTransactionHistory";
export type {
  TransactionHistorySortField,
  TransactionHistorySort,
  TransactionHistoryQuery,
  TransactionHistoryResult,
} from "./queryTransactionHistory";
export type {
  ExportFormat,
  ExportedTransaction,
  ExportTransactionHistoryOptions,
} from "./exportTransactionHistory";
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

export { validateDestination } from "./validateDestination";
export type {
  DestinationValidationResult,
  ValidateDestinationOptions,
} from "./validateDestination";

// ─── Webhook support (#208) ───────────────────────────────────────────────────
export {
  registerWebhook,
  unregisterWebhook,
  listWebhooks,
  clearWebhooks,
  triggerWebhooks,
  verifySignature,
} from "./webhooks";
export type {
  WebhookEventType,
  WebhookRegistration,
  WebhookPayload,
} from "./webhooks";

// ─── Asset pair trading logic (#209) ───────────────────────────────────────────
export {
  createAssetPair,
  getPairPrice,
  getMultiplePairPrices,
  hasSufficientLiquidity,
  getTradingPaths,
} from "./assetPairs";
export type {
  AssetPair,
  PairPrice,
} from "./assetPairs";
export {
  buildMultiSigEnvelope,
  collectSignature,
  validateMultiSigThreshold,
} from "./multiSig";
export type {
  MultiSigSigner,
  MultiSigEnvelopeParams,
  MultiSigEnvelope,
} from "./types";
export {
  saveTransactionTemplate,
  loadTemplate,
  listTransactionTemplates,
  deleteTransactionTemplate,
  clearTransactionTemplates,
  InMemoryTransactionTemplateStore,
} from "./templates";
export type {
  TransactionTemplate,
  TransactionTemplateKind,
  TransactionTemplateStore,
  TemplateParamValue,
} from "./templates";
// ─── Asset constants and factories ───────────────────────────────────────────
export const USDC_MAINNET_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const USDC_TESTNET_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDT_MAINNET_ISSUER =
  "GCVJWGVZCVSRMEMEMIYLAUQDFKCEH6HMA5HZGBF4QSQCIIQG7HFIC76L";
export const EURC_MAINNET_ISSUER =
  "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
export const EURC_TESTNET_ISSUER =
  "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

export function nativeAsset(): Asset {
  return Asset.native();
}

export function usdcAsset(issuer?: string): Asset {
  return new Asset("USDC", issuer || USDC_MAINNET_ISSUER);
}

export function usdtAsset(issuer?: string): Asset {
  return new Asset("USDT", issuer || USDT_MAINNET_ISSUER);
}

export function eurcAsset(issuer?: string): Asset {
  return new Asset("EURC", issuer || EURC_MAINNET_ISSUER);
}

// ─── Cross-network fee comparison ─────────────────────────────────────────────

import { estimateFee } from "./estimateFee";
import type { FeeEstimate, FeeEstimateInput } from "./estimateFee";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

export interface NetworkFeeResult {
  network: string;
  estimate: SorokitResult<FeeEstimate>;
}

/**
 * Compare estimated fees for the same transaction across multiple networks.
 *
 * Simulates the transaction on each network concurrently and returns the fee
 * estimate (or error) for each one, so callers can see the cost difference
 * between e.g. mainnet and testnet before submitting.
 *
 * @param transaction - The transaction to estimate fees for (XDR or payment description).
 * @param networks    - Array of resolved network configs to compare against.
 * @returns An array of `{ network, estimate }` entries in the same order as `networks`.
 *
 * @example
 * const results = await compareFeeAcrossNetworks(
 *   { kind: "xdr", transactionXdr: myXdr },
 *   [mainnetConfig, testnetConfig],
 * );
 * for (const { network, estimate } of results) {
 *   if (estimate.status === "ok") console.log(network, estimate.data.fee);
 * }
 */
export async function compareFeeAcrossNetworks(
  transaction: FeeEstimateInput,
  networks: ResolvedNetworkConfig[],
): Promise<NetworkFeeResult[]> {
  const results = await Promise.all(
    networks.map(async (networkConfig) => {
      const estimate = await estimateFee(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        transaction,
      );
      return { network: networkConfig.network, estimate };
    }),
  );
  return results;
}

// NOTE: Transaction pre-flight simulation uses the Soroban RPC server
// and therefore lives in src/soroban/simulateTransaction.ts.
// It can be accessed via client.soroban.simulate().

