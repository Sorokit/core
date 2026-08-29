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
  validateTrustline,
  getBulkTrustlines,
  buildBulkTrustlineTransaction,
  clearSequenceCache,
  validateMemoPolicy,
} from "./buildTransaction";
export type { AccountMergeOptions, TrustlineState } from "./buildTransaction";
export {
  evaluateTrustlineApproval,
  buildApprovedTrustlineTransaction,
} from "../account/trustlinePolicy";
export type {
  TrustlineApprovalPolicy,
  TrustlineApprovalDecision,
  ApprovedTrustlineBuild,
} from "../account/trustlinePolicy";
export { submitTransaction } from "./submitTransaction";
export { getTransactionStatus } from "./status";
export { estimateFee } from "./estimateFee";
export {
  analyzeTransactionCosts,
  summarizeTransactionCosts,
  forecastTransactionCosts,
} from "./costAnalysis";
export type {
  TransactionCostRecord,
  TransactionCostAnalysis,
  CostSummary,
  PlannedOperation,
  CostForecast,
} from "./costAnalysis";
export { reverseTransaction, issueRefund } from "./refunds";
export type { RefundParams, RefundDetails } from "./refunds";
export { streamTransactions } from "./streamTransactions";
export {
  getAssetPrice,
  normalizeAsset,
  normalizePrice,
  StaticPriceFeed,
  DEFAULT_PRICE_CACHE_TTL_MS,
} from "./priceFeeds";
export {
  subscribePrices,
  WebSocketPriceProvider,
  computeBackoffDelay,
} from "./priceSubscriptions";
export type {
  PriceUpdate,
  PriceSubscription,
  PriceSubscriptionProvider,
  PriceSubscriptionOptions,
  WebSocketPriceProviderOptions,
} from "./priceSubscriptions";
export { subscribeToTransactionEvents } from "./subscriptions";
export {
  exportTransactionHistory,
  formatTransactionsToCsv,
  formatTransactionsToJson,
} from "./exportTransactionHistory";
export { validateTransaction, validateTransactionBatch } from "./validateTransaction";
export { validateTransactionOffline } from "./validateTransactionOffline";
export type { OfflineValidationIssue, OfflineValidationReport, OfflineValidationOptions } from "./validateTransactionOffline";
export {
  createTransactionContext,
  TRANSACTION_CONTEXT_TTL_MS,
} from "./transactionContext";
export type {
  TransactionBuilderContext,
  SequenceValidationResult,
} from "./transactionContext";
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
  MemoType,
  MemoParams,
  MemoValidationRule,
  MemoValidationConfig,
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
  TransactionPriority,
  PriorityMultipliers,
  AdaptiveFeeOptions,
} from "./estimateFee";
export {
  fetchCongestionFeeEstimate,
  calculateAdaptiveFeeTtl,
  recordFeeEstimate,
  getFeeHistory,
  clearFeeHistory,
  ADAPTIVE_FEE_TTL_MIN_MS,
  ADAPTIVE_FEE_TTL_MAX_MS,
  ADAPTIVE_FEE_TTL_INTERMEDIATE_MS,
  FEE_HISTORY_MAX_ENTRIES,
  DEFAULT_PRIORITY_MULTIPLIERS,
  calculateAdaptiveFee,
} from "./estimateFee";
export {
  findSwapPath,
  buildPathPaymentTransaction,
  describeRouterSwapFailure,
  discoverPaymentPaths,
  clearPathDiscoveryCache,
  DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
  buildOptimizedSplitPaymentPlan,
} from "./pathPayment";
export type {
  DiscoveredPaymentPath,
  PaymentPathDiscoveryResult,
  DiscoverPaymentPathsOptions,
} from "./pathPayment";
export type {
  SwapRoute,
  SwapRouteAsset,
  FindSwapPathOptions,
  BuildPathPaymentParams,
  PaymentRouteQuote,
  SplitPaymentLeg,
  SplitPaymentPlan,
  SplitPaymentOptions,
} from "./pathPayment";
export type {
  TransactionStreamConfig,
  TransactionPage,
} from "./streamTransactions";
export type {
  AssetPrice,
  PriceFeed,
  PriceFeedStatus,
} from "../shared/types";
export type {
  GetAssetPriceOptions,
} from "./priceFeeds";
export type {
  EventSubscription as TransactionEventSubscription,
  TransactionEvent,
  TransactionEventTransport,
  TransactionEventType,
  TransactionSubscriptionOptions,
} from "./subscriptions";
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
  CostBasisLot,
  CostBasisOptions,
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

// ─── Webhook support (#208, #395) ─────────────────────────────────────────────
export {
  registerWebhook,
  unregisterWebhook,
  listWebhooks,
  clearWebhooks,
  triggerWebhooks,
  dispatchTransactionEvent,
  verifySignature,
} from "./webhooks";
export type {
  WebhookEventType,
  TransactionWebhookEvent,
  LegacyWebhookEventType,
  WebhookRegistration,
  WebhookPayload,
  WebhookEventDetails,
} from "./webhooks";

// ─── Fee-bump transactions (#398) ─────────────────────────────────────────────
export { buildFeeBumpTransaction } from "./feeBumpTransaction";

// ─── Asset pair trading logic (#209) ───────────────────────────────────────────
export {
  createAssetPair,
  getPairPrice,
  getMultiplePairPrices,
  hasSufficientLiquidity,
  getTradingPaths,
  hasExistingPair,
  resetPairRegistry,
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
export {
  createTransactionBundle,
  resolveExecutionOrder,
  areDependenciesMet,
  findNextExecutableStep,
  updateStepStatus,
  recalculateBundleStatus,
  recoverBundle,
} from "./bundles";
export type {
  BundleStep,
  BundleStepStatus,
  BundleStatus,
  TransactionBundle,
  CreateBundleOptions,
} from "./bundles";
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

export { compose } from "./compose";
export type { OperationStep, ComposedPipeline } from "./compose";

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


export { SpendingPolicyEngine, createSpendingPolicyEngine } from "./spendingPolicy";
export type {
  SpendingLimitPeriod,
  SpendingLimit,
  DestinationRestriction,
  ApprovalThreshold,
  SpendingPolicyConfig,
  SpendingRequest,
  SpendingRecordStatus,
  SpendingRecord,
  PolicyViolationCode,
  PolicyViolation,
  SpendingDecision,
  SpendingEvaluation,
  SpendingUsage,
} from "./spendingPolicy";
// ─── Historical fee forecasting (#523) ────────────────────────────────────────
export {
  forecastFees,
  normalizeFeeHistory,
  recordFeeObservation,
  getFeeObservations,
  clearFeeObservations,
  evaluateForecastAccuracy,
  linearFeeForecastModel,
  DEFAULT_OUTLIER_THRESHOLD,
  DEFAULT_FORECAST_CONFIDENCE_LEVEL,
  FEE_OBSERVATION_MAX_ENTRIES,
} from "./feeForecast";
export type {
  FeeObservation,
  NormalizedFeeObservation,
  NormalizedFeeHistory,
  NormalizeFeeHistoryOptions,
  DiscardedObservation,
  DiscardedObservationReason,
  ForecastDataWindow,
  FeeForecast,
  FeeForecastResult,
  FeeForecastModel,
  FeeForecastPrediction,
  ForecastFeesOptions,
  ForecastUnavailableReason,
  ForecastAccuracySample,
  ForecastAccuracyReport,
} from "./feeForecast";

// ─── Transaction dependency ordering (#526) ───────────────────────────────────
export {
  validateDependencies,
  planTransactionExecution,
  resolveTransactionOrder,
  findParallelizableTransactions,
  DependencyGraphError,
} from "./dependencyGraph";
export type {
  TransactionNode,
  DependencyError,
  DependencyErrorCode,
  DependencyValidation,
  ExecutionPlan,
  DependencyPlanResult,
} from "./dependencyGraph";
