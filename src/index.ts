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
  createLocalStorageAdapter,
  detectInstalledWallets,
  diagnoseWalletConnection,
  prioritizeWallet,
  recommendWallets,
  removeSignatureFromEnvelope,
  createSigningChallenge,
  mergeSignatures,
  signTransactionOffline,
  getWalletCapabilities,
  WALLET_CAPABILITY_IDS,
  generateDeviceFingerprint,
  evaluateDeviceTrust,
  DEFAULT_TRUST_THRESHOLD,
} from "./wallet";
export type {
  CreateSigningChallengeOptions,
  EnvelopeSignatureInput,
  MergeSignaturesResult,
  PersistenceAdapter,
  SignatureHintInput,
  SigningChallenge,
  SigningDelegationSignature,
} from "./wallet";
export {
  discoverHardwareWallets,
  getHardwareWalletPublicKey,
  signTransactionWithHardwareWallet,
} from "./wallet/hardwareWallet";
export type {
  HardwareWalletAdapter,
  HardwareWalletDevice,
  HardwareWalletCapabilities,
} from "./wallet/hardwareWallet";
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
  WalletCapability,
  WalletCapabilityId,
  WalletCapabilitySource,
  WalletCapabilities,
} from "./wallet/types";
export type { DeviceSignals, DeviceFingerprint, TrustHistoryEntry, TrustScoreOptions, TrustEvaluation } from "./wallet/deviceTrust";

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
export type {
  AssetPrice as SharedAssetPrice,
  PriceFeed as SharedPriceFeed,
  PriceFeedStatus as SharedPriceFeedStatus,
  ResolvedNetworkConfig,
} from "./shared/types";
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
export type {
  AccountBatchEntry,
  AccountBatchResult,
  GetAccountsBatchOptions,
  GetAccountsBatchWithMetadataOptions,
} from "./account/getAccountsBatch";
export type { AssetBalanceFilter } from "./account/getAssetBalances";
export { getMultipleAssetBalances } from "./account/getMultipleAssetBalances";
export type { MultipleAssetBalancesResult } from "./account/getMultipleAssetBalances";
export { streamAccount } from "./account/streamAccount";
export type { AccountStreamConfig } from "./account/streamAccount";
export { subscribeToAccountEvents } from "./account/subscriptions";
export type {
  AccountEvent,
  AccountEventSubscription,
  AccountEventTransport,
  AccountEventType,
  AccountSubscriptionOptions,
} from "./account";
export { setSponsor, removeSponsor } from "./account/sponsorship";
export { linkAccountToDid, verifyDidOwnership } from "./account/didAssociation";
export type {
  DidAssociation,
  DidDocument,
  DidOwnershipVerification,
  DidResolver,
  OwnershipProof,
} from "./account/didAssociation";
export type {
  AccountInfo,
  AccountMetadata,
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
  rotateAccountKey,
  setAccountRecovery,
  recoverAccountKeys,
  isValidStellarPublicKey,
} from "./account/keyRotation";
export type {
  RotateAccountKeyParams,
  SetAccountRecoveryParams,
  RecoverAccountKeysParams,
  RecoveryReplacementSigner,
} from "./account/keyRotation";
export {
  getAccountActivitySummary,
  clearAccountActivitySummaryCache,
  DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS,
} from "./account/getAccountActivitySummary";
export type {
  ActivityPeriod,
  AssetActivity,
  CounterpartyActivity,
  AccountActivitySummary,
  GetAccountActivitySummaryOptions,
} from "./account/getAccountActivitySummary";

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
  TransactionPriority,
  PriorityMultipliers,
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
  DEFAULT_PRIORITY_MULTIPLIERS,
} from "./transaction/estimateFee";
export {
  findSwapPath,
  buildPathPaymentTransaction,
  describeRouterSwapFailure,
  discoverPaymentPaths,
  clearPathDiscoveryCache,
  DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
  buildOptimizedSplitPaymentPlan,
} from "./transaction/pathPayment";
export type {
  SwapRoute,
  SwapRouteAsset,
  FindSwapPathOptions,
  BuildPathPaymentParams,
  DiscoveredPaymentPath,
  PaymentPathDiscoveryResult,
  DiscoverPaymentPathsOptions,
  PaymentRouteQuote,
  SplitPaymentLeg,
  SplitPaymentPlan,
  SplitPaymentOptions,
} from "./transaction/pathPayment";
export { streamTransactions } from "./transaction/streamTransactions";
export {
  buildPathPayment,
  checkTrustlines,
  buildBulkTrustlines,
  validateTrustline,
  getBulkTrustlines,
  buildBulkTrustlineTransaction,
} from "./transaction/index";
export type { TrustlineState } from "./transaction/index";
export { compareFeeAcrossNetworks } from "./transaction/index";
export type { NetworkFeeResult } from "./transaction/index";
export { compose } from "./transaction/compose";
export type { OperationStep, ComposedPipeline } from "./transaction/compose";
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
export {
  evaluateTrustlineApproval,
  buildApprovedTrustlineTransaction,
  analyzeTransactionCosts,
  summarizeTransactionCosts,
  forecastTransactionCosts,
  reverseTransaction,
  issueRefund,
} from "./transaction";
export type {
  TrustlineApprovalPolicy,
  TrustlineApprovalDecision,
  ApprovedTrustlineBuild,
  TransactionCostRecord,
  TransactionCostAnalysis,
  CostSummary,
  PlannedOperation,
  CostForecast,
  RefundParams,
  RefundDetails,
} from "./transaction";

// ─── Fee-bump transactions (#398) ─────────────────────────────────────────────
export { buildFeeBumpTransaction } from "./transaction/feeBumpTransaction";
export { buildEscrowTransaction, validateEscrow, validateEscrowAction, createEscrowRelease, createEscrowRefund, createEscrowDispute, isEscrowExpired, calculateAdaptiveFee } from "./transaction";
export type { EscrowAction, EscrowState, EscrowTiming, EscrowParams, EscrowValidation, AdaptiveFeeOptions } from "./transaction";

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
  DEFAULT_PRICE_CACHE_TTL_MS,
  exportTransactionHistory,
  getAssetPrice,
  queryTransactionHistory,
  formatTransactionsToCsv,
  formatTransactionsToJson,
  normalizeAsset,
  normalizePrice,
  StaticPriceFeed,
  subscribeToTransactionEvents,
  subscribePrices,
  WebSocketPriceProvider,
  computeBackoffDelay,
} from "./transaction";
export type {
  PriceUpdate,
  PriceSubscription,
  PriceSubscriptionProvider,
  PriceSubscriptionOptions,
  WebSocketPriceProviderOptions,
} from "./transaction";
export type {
  CostBasisLot,
  CostBasisOptions,
  ExportFormat,
  ExportedTransaction,
  ExportTransactionHistoryOptions,
  GetAssetPriceOptions,
  PriceFeed,
  PriceFeedStatus,
  TransactionEvent,
  TransactionEventSubscription,
  TransactionEventTransport,
  TransactionEventType,
  TransactionSubscriptionOptions,
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
  decodeAbiValue,
  decodeContractValue,
  encodeAbiValue,
  encodeContractArgs,
  serializeCustomType,
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
  getContractVersionHistory,
  invalidateContractVersionCache,
  resetContractVersionTracking,
} from "./soroban/contractVersion";
export type {
  ContractVersionHistoryEntry,
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
export {
  createContractReadCacheKey,
  invalidateContractReadCache,
} from "./soroban/contractCallIdentity";
export type { BuildContractDeployOptions } from "./soroban/deployContract";
export { invokeBatchContracts } from "./soroban/invokeBatchContracts";
export { simulateTransactionBatch } from "./soroban/simulateTransaction";
export type { BatchSimulationResult } from "./soroban/simulateTransaction";
export { getNftMetadata, clearNftMetadataCache } from "./soroban/nftMetadata";
export type { NftMetadata, NftMetadataOptions } from "./soroban/nftMetadata";
export {
  andEventFilters,
  calculateRate,
  countByType,
  filterContractEvents,
  groupByTime,
  orEventFilters,
  queryContractEvents,
  streamContractEvents,
  subscribeContractEvents,
  DEFAULT_RECOVERY_WINDOW_MS,
} from "./soroban/subscribeContractEvents";
export { InMemoryEventIndex, indexContractEvent, queryIndexedEvents } from "./soroban/eventIndex";
export type {
  IndexedContractEvent,
  IndexedEventFilter,
  IndexedEventPage,
  IndexedEventQueryResult,
} from "./soroban/eventIndex";
export { analyzeCallOptimization } from "./soroban/callOptimization";
export {
  captureContractState,
  snapshotContractState,
  diffContractState,
  diffSnapshots,
  inspectContractInvocation,
} from "./soroban/stateSnapshots";
export type {
  ContractStateEntry,
  ContractStateSnapshot,
  ContractStateChange,
  ContractStateDiff,
  ContractStateReader,
} from "./soroban/stateSnapshots";
export { optimizeContractArgs, analyzeArgumentEncoding } from "./soroban/optimizeArgs";
export type { ArgumentEncodingStats, OptimizedContractArgs } from "./soroban/optimizeArgs";
export {
  createClaimCommitment,
  createProofEnvelope,
  verifyProof,
  validatePrivateTransaction,
} from "./privacy/zeroKnowledge";
export type {
  ProofBytes,
  ProofStatement,
  SelectiveDisclosure,
  ZeroKnowledgeProof,
  ProofVerificationContext,
  ZeroKnowledgeVerifier,
  PrivateTransactionValidationResult,
} from "./privacy/zeroKnowledge";
export type {
  CallOptimizationReport,
  CallOptimizationSuggestion,
  OptimizationPriority,
  OptimizationSuggestionType,
} from "./soroban/callOptimization";
export type {
  ContractEvent,
  EventFilterPredicate,
  ContractEventFilter,
  ContractEventSubscriptionOptions,
} from "./soroban/subscribeContractEvents";
export type {
  BatchContractInvocation,
  BatchContractResult,
  ContractAbi,
  ContractAbiField,
  ContractAbiMethod,
  ContractAbiTypeDescriptor,
  ContractAuthorizationRequirement,
  ContractCallResult,
  ContractInvokeParams,
  ContractMethod,
  ContractMethodInput,
  ContractMethodVisibility,
  ContractReadParams,
  ContractResultType,
  ParsedContractResult,
  PreparedContractCall,
  SimulateTransactionResult,
  SorobanSimulationFeeBreakdown,
  SorobanSimulationResourceUsage,
  SorobanPollConfig,
} from "./soroban/types";

// ─── Response system ──────────────────────────────────────────────────────────

// ─── Transaction scheduler (#453) ────────────────────────────────────────────
export {
  scheduleTransaction,
  cancelSchedule,
  getSchedule,
  listSchedules,
  processDueSchedules,
  InMemoryScheduleStore,
} from "./transaction/scheduler";
export type {
  TransactionSchedule,
  ScheduleStatus,
  ScheduleStore,
  SchedulerConfig,
  ScheduleResult,
} from "./transaction/scheduler";

// ─── Anomaly detection (#454) ────────────────────────────────────────────────
export {
  detectAnomaly,
  createAnomalyDetector,
} from "./account/anomalyDetection";
export type {
  TransactionRecord,
  AnomalyThresholds,
  AnomalyResult,
  AnomalyFlag,
  AnomalyAlert,
  AnomalyAlertCallback,
} from "./account/anomalyDetection";

// ─── Balance reconciliation (#459) ───────────────────────────────────────────
export { reconcileBalances } from "./account/reconcileBalances";
export type {
  AccountBalance,
  ExchangeRate,
  ReconciliationResult,
  AccountPosition,
  Discrepancy,
  ReconcileOptions,
} from "./account/reconcileBalances";
export { SDK_VERSION } from "./shared/constants";
export { createI18n, translateMessage, localizeError, DEFAULT_LOCALE, EN_TRANSLATIONS, ES_TRANSLATIONS } from "./shared/i18n";
export type { I18n, I18nConfig, MessageKey, TranslationCatalog, TranslationMap, LocalizedError, SupportedLocale } from "./shared/i18n";
export type { SorokitCache } from "./shared/cache";
export { createInMemoryCache, invalidateContractState } from "./shared/cache";
export { createTracedLogger } from "./shared/logger";
export type { LogLevel, LoggerOptions, SorokitLogger } from "./shared/logger";
export {
  SorokitErrorCategory,
  SorokitErrorCode,
  assertOk,
  attachTraceId,
  err,
  isErr,
  isErrorCode,
  isOk,
  ok,
} from "./shared/response";
export type {
  RecoveryAttempt,
  RecoveryGuidance,
  SorokitError,
  SorokitErrorContext,
  SorokitErrorOptions,
  SorokitResult,
} from "./shared/response";
export {
  AssetMappingRegistry,
  assetMappingRegistry,
  unwrapAssetFromSoroban,
  wrapAssetForSoroban,
} from "./soroban/assetBridge";
export type {
  AssetBridgeAdapter,
  AssetBridgeOperationOptions,
  AssetIdentifier,
  AssetMapping,
} from "./soroban/assetBridge";
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

// ─── Governance voting utilities (#456) ───────────────────────────────────────
export {
  getVotingPower,
  delegateVote,
  castVote,
  getVotingHistory,
} from "./governance";
export type {
  VotingPowerParams,
  VotingPowerResult,
  DelegationParams,
  DelegationResult,
  CastVoteParams,
  CastVoteResult,
  VotingHistoryEntry,
  GetVotingHistoryParams,
} from "./governance";

// ─── Transaction bundles (#457) ───────────────────────────────────────────────
export {
  createTransactionBundle,
  resolveExecutionOrder,
  areDependenciesMet,
  findNextExecutableStep,
  updateStepStatus,
  recalculateBundleStatus,
  recoverBundle,
} from "./transaction/bundles";
export type {
  BundleStep,
  BundleStepStatus,
  BundleStatus,
  TransactionBundle,
  CreateBundleOptions,
} from "./transaction/bundles";

// ─── Forecasting, storage analysis, and congestion monitoring ──────────────────
export { forecastBalance, forecastAccountBalance } from "./account/balanceForecast";
export type {
  BalanceForecastTransaction,
  BalanceForecastOptions,
  BalanceForecastPoint,
  BalanceForecastResult,
} from "./account/balanceForecast";
export { analyzeContractStorage } from "./soroban/storageAnalysis";
export type {
  ContractStorageEntry,
  StorageAnalysisOptions,
  StorageEntryReport,
  StorageRecommendation,
  StorageAnalysisReport,
} from "./soroban/storageAnalysis";
export { CongestionMonitor, createCongestionMonitor } from "./network/congestionMonitor";
export type {
  CongestionSample,
  CongestionMonitorOptions,
  CongestionLevel,
  CongestionSnapshot,
} from "./network/congestionMonitor";
export { SpendingPolicyEngine, createSpendingPolicyEngine } from "./transaction/spendingPolicy";
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
} from "./transaction/spendingPolicy";
export {
  ContractStateHistory,
  createContractStateHistory,
  fingerprintState,
} from "./soroban/contractStateHistory";
export type {
  ContractStateSnapshotRecord,
  CaptureSnapshotInput,
  ContractStatePin,
  StateEntryChangeKind,
  StateEntryChange,
  ContractStateComparison,
  SnapshotIntegrityReport,
  SnapshotQuery,
} from "./soroban/contractStateHistory";
export {
  MultiSigContractExecution,
  createMultiSigContractExecution,
} from "./soroban/multiSigExecution";
export type {
  ContractExecutionSigner,
  CreateSigningRequestInput,
  CollectedSignature,
  SigningRequestStatus,
  ContractSigningRequest,
  SigningRequestState,
} from "./soroban/multiSigExecution";
export { auditWalletSecurity, isHighRiskConnection } from "./wallet/securityAudit";
export type {
  RiskSeverity,
  RiskConfidence,
  RiskFactor,
  WalletVulnerability,
  VulnerabilitySource,
  WalletConnectionContext,
  WalletSecurityAuditOptions,
  RiskLevel,
  WalletSecurityReport,
} from "./wallet/securityAudit";

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
} from "./transaction/feeForecast";
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
} from "./transaction/feeForecast";

// ─── Transaction dependency ordering (#526) ───────────────────────────────────
export {
  validateDependencies,
  planTransactionExecution,
  resolveTransactionOrder,
  findParallelizableTransactions,
  DependencyGraphError,
} from "./transaction/dependencyGraph";
export type {
  TransactionNode,
  DependencyError,
  DependencyErrorCode,
  DependencyValidation,
  ExecutionPlan,
  DependencyPlanResult,
} from "./transaction/dependencyGraph";

// ─── Multi-wallet portfolio aggregation (#525) ────────────────────────────────
export {
  aggregatePortfolio,
  assetIdentifier,
} from "./account/portfolioAggregation";
export type {
  PortfolioWalletSource,
  PortfolioAssetPrice,
  PortfolioHolding,
  PortfolioAggregation,
  PortfolioValuationCoverage,
  PortfolioConcentration,
  WalletAttribution,
  DuplicateSource,
  AggregatePortfolioOptions,
} from "./account/portfolioAggregation";

// ─── SDK health checks & diagnostics (#527) ───────────────────────────────────
export {
  checkSdkHealth,
  runDiagnostics,
  checkHorizonConnectivity,
  checkSorobanRpcConnectivity,
  checkWalletAdapterStatus,
  checkNetworkConfiguration,
  checkEnvironment,
  combineHealthStatuses,
  DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
  DEFAULT_SLOW_LATENCY_MS,
} from "./shared/diagnostics";
export type {
  DiagnosticHealthStatus,
  DiagnosticCheckId,
  DiagnosticCheckResult,
  SdkHealthReport,
  DiagnosticsReport,
  SdkHealthOptions,
  EndpointCheckOptions,
} from "./shared/diagnostics";
