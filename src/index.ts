/**
 * sorokit-core — public API
 *
 * Single entry point: createSorokitClient()
 * All functionality is accessed through the returned client object.
 */

// ─── Entry point ──────────────────────────────────────────────────────────────
export { createSorokitClient } from "./client/createSorokitClient";
export type {
  SorokitClient,
  SorokitClientConfig,
  HealthCheckReport,
} from "./client/createSorokitClient";

// ─── Wallet adapters ──────────────────────────────────────────────────────────
export {
  addSignatureToEnvelope,
  collectMultiSignatures,
  detectInstalledWallets,
  diagnoseWalletConnection,
  prioritizeWallet,
  recommendWallets,
  removeSignatureFromEnvelope,
  signTransactionOffline,
} from "./wallet";
export type { EnvelopeSignatureInput, SignatureHintInput } from "./wallet";
export {
  FreighterAdapter,
  LobstrAdapter,
  XBullAdapter,
} from "./wallet/adapters";

// ─── Wallet types ─────────────────────────────────────────────────────────────
export { WalletType } from "./wallet/types";
export type {
  DetectedWallet,
  DiagnosticCheck,
  DiagnosticStatus,
  RecommendationCriteria,
  SWKInstance,
  SignTransactionInput,
  WalletAdapter,
  WalletDiagnosticOptions,
  WalletDiagnosticReport,
  WalletFeature,
  WalletState,
} from "./wallet/types";

// ─── Wallet Status Tracker ─────────────────────────────────────────────────────
export {
  WalletStatusTracker,
  getAdapterName,
  truncatePublicKey,
  getAriaLabel,
  getStatusColorClass,
} from "./wallet/walletStatusTracker";
export type {
  WalletConnectionStatus,
  WalletStatus,
  WalletStatusListener,
  WalletStatusUnsubscribe,
  WalletStatusTrackerConfig,
} from "./wallet/walletStatusTracker";

// ─── Signing History ───────────────────────────────────────────────────────────
export {
  getSigningHistory,
  exportSigningHistory,
  InMemorySigningHistoryStore,
} from "./wallet/signingHistory";
export type {
  SigningRecord,
  SigningHistoryFilter,
  SigningHistoryStore,
} from "./wallet/signingHistory";

// ─── Network ──────────────────────────────────────────────────────────────────
export type { NetworkType } from "./network/config";
export { resolveNetwork } from "./network/resolveNetwork";
export type { NetworkOverrides } from "./network/resolveNetwork";
export type { ResolvedNetworkConfig } from "./shared/types";
export {
  checkNetworkHealth,
  NetworkSwitcher,
  getNetwork,
  setNetwork,
  NETWORK_DEFAULTS,
} from "./network";
export type {
  CheckNetworkHealthOptions,
  NetworkEndpointHealth,
  NetworkHealthReport,
  NetworkHealthStatus,
  CustomNetwork,
  NetworkOption,
  NetworkInfo,
  NetworkStatus,
  NetworkSwitchListener,
  NetworkStatusListener,
  NetworkSwitchUnsubscribe,
  NetworkSwitcherConfig,
} from "./network";

// ─── Circuit breaker (#186) ────────────────────────────────────────────────────
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
} from "./network";
export type {
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
  CircuitState,
  CircuitStateChangeEvent,
} from "./network";

// ─── Account types & utilities ────────────────────────────────────────────────
export { evaluateBalanceAlerts } from "./account/balanceAlerts";
export { createBalanceAlert } from "./account/createBalanceAlert";
export type { BalanceAlertConfig } from "./account/createBalanceAlert";
export { getAccountsBatch } from "./account/getAccountsBatch";
export type { AssetBalanceFilter } from "./account/getAssetBalances";
export { getMultipleAssetBalances } from "./account/getMultipleAssetBalances";
export type { MultipleAssetBalancesResult } from "./account/getMultipleAssetBalances";
export { streamAccount } from "./account/streamAccount";
export type { AccountStreamConfig } from "./account/streamAccount";
export { setSponsor, removeSponsor } from "./account/sponsorship";
export type {
  AccountInfo,
  AssetBalance,
  BalanceAlert,
  BalanceAlertCondition,
  BalanceAlertRule,
  SponsorshipResult,
} from "./account/types";
// Standalone account functions for use without a client instance
export { getAccount } from "./account/getAccount";
export { getBalances } from "./account/getBalances";
export { getAssetBalances } from "./account/getAssetBalances";
export {
  getAccountActivitySummary,
  DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS,
} from "./account/getAccountActivitySummary";
export type {
  ActivityPeriod,
  AssetActivity,
  AccountActivitySummary,
  AccountActivitySummaryOptions,
  CounterpartyActivity,
} from "./account/getAccountActivitySummary";
export {
  rotateAccountKey,
  setAccountRecovery,
  recoverAccountKeys,
  isValidStellarPublicKey,
} from "./account/keyRotation";
export type {
  RotateAccountKeyParams,
  SetAccountRecoveryParams,
  RecoverAccountKeysParams,
  RecoveryNewKey,
} from "./account/keyRotation";

// ─── Transaction validation ───────────────────────────────────────────────────
export {
  createHashMemo,
  createIdMemo,
  createReturnMemo,
  createTextMemo,
  DEFAULT_VALIDATION_RULES,
  validateTransactionXdr,
  USDC_MAINNET_ISSUER,
  USDC_TESTNET_ISSUER,
  USDT_MAINNET_ISSUER,
  EURC_MAINNET_ISSUER,
  EURC_TESTNET_ISSUER,
  nativeAsset,
  usdcAsset,
  usdtAsset,
  eurcAsset,
} from "./transaction";
export type { SorokitMemo } from "./transaction";
export type {
  TransactionValidationFinding,
  TransactionValidationReport,
  ValidationRules,
} from "./transaction/validateTransactionXdr";
export { validateDestination } from "./transaction/validateDestination";
export type {
  DestinationValidationResult,
  ValidateDestinationOptions,
} from "./transaction/validateDestination";
export {
  buildMultiSigEnvelope,
  collectSignature,
  validateMultiSigThreshold,
} from "./transaction/multiSig";
export type {
  MultiSigSigner,
  MultiSigEnvelopeParams,
  MultiSigEnvelope,
} from "./transaction/types";

// ─── Transaction types ────────────────────────────────────────────────────────
export type {
  FeeEstimate,
  FeeEstimateInput,
  FeeEstimateOptions,
  FeeTiers,
  CongestionFeeEstimate,
} from "./transaction/estimateFee";
export {
  calculateFeeTiers,
  fetchCongestionFeeEstimate,
  calculateAdaptiveFeeTtl,
  recordFeeEstimate,
  getFeeHistory,
  clearFeeHistory,
  ADAPTIVE_FEE_TTL_MIN_MS,
  ADAPTIVE_FEE_TTL_MAX_MS,
  ADAPTIVE_FEE_TTL_INTERMEDIATE_MS,
  FEE_HISTORY_MAX_ENTRIES,
} from "./transaction/estimateFee";
export {
  findSwapPath,
  buildPathPaymentTransaction,
  describeRouterSwapFailure,
  discoverPaymentPaths,
  DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
} from "./transaction/pathPayment";
export type {
  SwapRoute,
  SwapRouteAsset,
  FindSwapPathOptions,
  BuildPathPaymentParams,
  DiscoveredPathHop,
  DiscoveredPaymentPath,
  DiscoverPaymentPathsResult,
} from "./transaction/pathPayment";
export { streamTransactions } from "./transaction/streamTransactions";
export {
  buildPathPayment,
  checkTrustlines,
  buildBulkTrustlines,
} from "./transaction/index";
export {
  validateTrustline,
  getBulkTrustlines,
  buildBulkTrustlineTransaction,
} from "./transaction/trustlineManagement";
export type {
  TrustlineState,
  BulkTrustlinesResult,
  BulkTrustlineOperation,
  BuildBulkTrustlineTransactionParams,
} from "./transaction/trustlineManagement";
export { compareFeeAcrossNetworks } from "./transaction/index";
export type { NetworkFeeResult } from "./transaction/index";
export type {
  TransactionPage,
  TransactionStreamConfig,
} from "./transaction/streamTransactions";
export {
  TRANSACTION_CONTEXT_TTL_MS,
  createTransactionContext,
} from "./transaction/transactionContext";
export type {
  TransactionBuilderContext,
  SequenceValidationResult,
} from "./transaction/transactionContext";
export { buildAccountMerge, validateMemoPolicy } from "./transaction";
export type { AccountMergeOptions } from "./transaction";

// ─── Fee-bump transactions (#398) ─────────────────────────────────────────────
export { buildFeeBumpTransaction } from "./transaction/feeBumpTransaction";

// ─── Webhook support (#395) ───────────────────────────────────────────────────
export {
  registerWebhook,
  unregisterWebhook,
  listWebhooks,
  clearWebhooks,
  triggerWebhooks,
  dispatchTransactionEvent,
  verifySignature,
} from "./transaction/webhooks";
export type {
  WebhookEventType,
  TransactionWebhookEvent,
  LegacyWebhookEventType,
  WebhookRegistration,
  WebhookPayload,
  WebhookEventDetails,
} from "./transaction/webhooks";
export {
  exportTransactionHistory,
  queryTransactionHistory,
  formatTransactionsToCsv,
  formatTransactionsToJson,
} from "./transaction";
export type {
  ExportFormat,
  ExportedTransaction,
  ExportTransactionHistoryOptions,
} from "./transaction";
export type {
  TransactionHistorySortField,
  TransactionHistorySort,
  TransactionHistoryQuery,
  TransactionHistoryResult,
} from "./transaction/queryTransactionHistory";
export type {
  AccountCreateParams,
  AtomicSwapParams,
  MemoType,
  MemoParams,
  MemoValidationRule,
  MemoValidationConfig,
  PathPaymentMode,
  PathPaymentParams,
  PaymentParams,
  ReverseTransactionParams,
  TransactionResult,
  TransactionStatus,
  TrustlineParams,
} from "./transaction/types";

// ─── Asset pair trading logic (#209, #354) ────────────────────────────────────
export {
  createAssetPair,
  getPairPrice,
  getMultiplePairPrices,
  hasSufficientLiquidity,
  getTradingPaths,
  hasExistingPair,
  resetPairRegistry,
} from "./transaction/assetPairs";
export type { AssetPair, PairPrice } from "./transaction/assetPairs";
export { validateTransaction, validateTransactionBatch } from "./transaction/validateTransaction";
export type {
  ValidationIssue,
  TransactionValidationContext,
  CustomValidationRule,
  ParsedOperation,
} from "./transaction/validateTransaction";
export { validateTransactionOffline } from "./transaction/validateTransactionOffline";
export type {
  OfflineValidationIssue,
  OfflineValidationReport,
  OfflineValidationOptions,
} from "./transaction/validateTransactionOffline";
export {
  saveTransactionTemplate,
  loadTemplate,
  listTransactionTemplates,
  deleteTransactionTemplate,
  clearTransactionTemplates,
  InMemoryTransactionTemplateStore,
} from "./transaction";
export type {
  TransactionTemplate,
  TransactionTemplateKind,
  TransactionTemplateStore,
  TemplateParamValue,
} from "./transaction";
// Standalone transaction functions for use without a client instance
export { submitTransaction } from "./transaction/submitTransaction";
export { getTransactionStatus } from "./transaction/status";

// ─── Soroban simulator (#210) ──────────────────────────────────────────────────
export { SorobanSimulator } from "./soroban/simulator";
export type {
  SimulatedMethodResult,
  SorobanSimulatorOptions,
} from "./soroban/simulator";
export { setSorobanSimulator } from "./shared/serverFactory";

// ─── Soroban types ────────────────────────────────────────────────────────────
export { simulateContractSafe } from "./soroban/simulateContractSafe";
export type {
  SafeSimulationResult,
  SimulateContractSafeOptions,
} from "./soroban/simulateContractSafe";
export {
  decodeContractValue,
  encodeContractArgs,
} from "./soroban/contractEncoding";
export { validateContractData } from "./soroban";
export type {
  ContractDataType,
  ContractDataValidationIssue,
  ContractDataValidationResult,
} from "./soroban";
export { parseContractResult } from "./soroban/parseContractResult";
export {
  getContractMethods,
  parseContractSchema,
  validateContractArgs,
} from "./soroban/contractMetadata";
export type {
  ContractSchema,
  ContractMethodSchema,
  ContractMethodParam,
} from "./soroban/contractMetadata";
// ─── Contract version detection & upgrade hook (#393) ─────────────────────────
export {
  getContractVersion,
  invalidateContractVersionCache,
  resetContractVersionTracking,
} from "./soroban/contractVersion";
export type {
  ContractVersionInfo,
  ContractUpgradeEvent,
  OnContractUpgrade,
  ContractVersionOptions,
} from "./soroban/contractVersion";
// ─── Contract error decoding (#391) ───────────────────────────────────────────
export {
  decodeContractError,
  DEFAULT_CONTRACT_ERROR_MAP,
  FACTORY_CONTRACT_ERRORS,
  ROUTER_CONTRACT_ERRORS,
  FACTORY_ERROR_CODES,
  ROUTER_ERROR_CODES,
} from "./soroban/contractErrors";
export type {
  ContractErrorInfo,
  ContractErrorMap,
  DecodedContractError,
} from "./soroban/contractErrors";
export { ContractInteractionBuilder } from "./soroban";
export type {
  ContractInteractionBuilderConfig,
  ArgumentField,
  MethodSelection,
  GeneratedCallCode,
  BuilderState,
  BuilderStateListener,
  BuilderStateUnsubscribe,
} from "./soroban";
export { invokeContract } from "./soroban/invokeContract";
export type { InvokeContractOptions } from "./soroban/invokeContract";
export { buildContractDeploy } from "./soroban/deployContract";
export {
  validateDeployConfig,
  collectDeployConfigIssues,
  formatDeployConfigIssues,
  DEPLOY_SALT_BYTES,
} from "./soroban/validateDeployConfig";
export type {
  DeployConfigInput,
  DeployConfigIssue,
  ValidatedDeployConfig,
} from "./soroban/validateDeployConfig";
export {
  decodeContractEvent,
  decodeFactoryEvent,
  decodeRouterEvent,
} from "./soroban/decodeContractEvent";
export type {
  ContractEventDecoder,
  DecodedContractEvent,
  PairCreatedEvent,
  SwapEvent,
} from "./soroban/decodeContractEvent";
export { getFactoryStatistics } from "./soroban/factoryStatistics";
export type {
  FactoryStatistics,
  FactoryStatisticsSource,
} from "./soroban/factoryStatistics";
export { createContractReadCacheKey } from "./soroban/contractCallIdentity";
export type { BuildContractDeployOptions } from "./soroban/deployContract";
export { invokeBatchContracts } from "./soroban/invokeBatchContracts";
export { subscribeContractEvents } from "./soroban/subscribeContractEvents";
export type {
  ContractEvent,
  ContractEventFilter,
  ContractEventSubscriptionOptions,
} from "./soroban/subscribeContractEvents";
export type {
  BatchContractInvocation,
  BatchContractResult,
  ContractAbi,
  ContractAbiMethod,
  ContractCallResult,
  ContractInvokeParams,
  ContractMethod,
  ContractMethodInput,
  ContractReadParams,
  ContractResultType,
  ParsedContractResult,
  PreparedContractCall,
  SimulateTransactionResult,
  SorobanPollConfig,
} from "./soroban/types";

// ─── Response system ──────────────────────────────────────────────────────────
export { SDK_VERSION } from "./shared/constants";
export type { SorokitCache } from "./shared/cache";
export { createInMemoryCache, invalidateContractState } from "./shared/cache";
export { createTracedLogger } from "./shared/logger";
export type { LogLevel, LoggerOptions, SorokitLogger } from "./shared/logger";
export {
  SorokitErrorCode,
  assertOk,
  attachTraceId,
  err,
  isErr,
  isErrorCode,
  isOk,
  ok,
} from "./shared/response";
export type { SorokitError, SorokitResult } from "./shared/response";
export { generateTraceId, TokenBucketRateLimiter } from "./shared/utils";
export type {
  EndpointRateLimitConfig,
  RateLimiterBucketMetrics,
  RateLimiterMetricEvent,
  RateLimiterMetrics,
  RateLimiterEventType,
} from "./shared/utils";

// ─── Token validation utilities (#352) ────────────────────────────────────────
export {
  validateAssetCode,
  validateAssetIssuer,
  validateTokenAsset,
  isSameAsset,
  normalizePairId,
} from "./shared/validateToken";
export type { TokenAsset } from "./shared/validateToken";

// ─── Distributed tracing (#212) ────────────────────────────────────────────
export {
  getTraceContext,
  createTraceContext,
  createTracedFetch,
  createAutoTracedFetch,
  setTraceContext,
} from "./shared/tracing";
export type { TraceContext, TraceContextOptions } from "./shared/tracing";

// ─── Metrics & performance profiling (#397) ───────────────────────────────────
export {
  clearMetrics,
  getMetrics,
  metricsCollector,
  recordMetric,
  withMetrics,
  configureProfiling,
  isProfilingEnabled,
  profileOperation,
  getPerformanceMetrics,
  exportPerformanceMetrics,
  resetPerformanceMetrics,
  DEFAULT_MAX_METRIC_ENTRIES,
} from "./shared/metrics";
export type {
  MetricEntry,
  MetricSummary,
  MetricsFilter,
  ProfilingConfig,
  PerformanceMetricsReport,
} from "./shared/metrics";
