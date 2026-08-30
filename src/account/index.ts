export { getAccount } from "./getAccount";
export { getAccountsBatch } from "./getAccountsBatch";
export type {
  AccountBatchEntry,
  AccountBatchResult,
  GetAccountsBatchOptions,
  GetAccountsBatchWithMetadataOptions,
} from "./getAccountsBatch";
export { getBalances } from "./getBalances";
export { getAssetBalances } from "./getAssetBalances";
export { getMultipleAssetBalances } from "./getMultipleAssetBalances";
export { streamAccount } from "./streamAccount";
export { subscribeToAccountEvents } from "./subscriptions";
export { evaluateBalanceAlerts } from "./balanceAlerts";
export { createBalanceAlert } from "./createBalanceAlert";
export {
  rotateAccountKey,
  setAccountRecovery,
  recoverAccountKeys,
  isValidStellarPublicKey,
} from "./keyRotation";
export {
  recordKeyRotation,
  getKeyRotationHistory,
  detectSuspiciousRotationPattern,
  clearKeyRotationAuditLog,
} from "./keyRotationAudit";
export type {
  KeyRotationAuditEntry,
  KeyRotationStatus,
  GetKeyRotationHistoryOptions,
} from "./keyRotationAudit";
export {
  getAccountActivitySummary,
  clearAccountActivitySummaryCache,
  DEFAULT_ACTIVITY_SUMMARY_CACHE_TTL_MS,
} from "./getAccountActivitySummary";
export type {
  ActivityPeriod,
  AssetActivity,
  CounterpartyActivity,
  AccountActivitySummary,
  GetAccountActivitySummaryOptions,
} from "./getAccountActivitySummary";
export type {
  RotateAccountKeyParams,
  SetAccountRecoveryParams,
  RecoverAccountKeysParams,
  RecoveryReplacementSigner,
} from "./keyRotation";
export {
  registerRecoveryContacts,
  configureGuardians,
  initiateRecovery,
  approveRecovery,
  cancelRecovery,
  executeRecovery,
  isRecoveryReady,
} from "./recoveryWorkflow";
export type {
  RecoveryPermission,
  RecoveryContact,
  RecoveryConfig,
  RecoveryRequest,
  RecoveryExecutionPlan,
} from "./recoveryWorkflow";
export type {
  AccountInfo,
  AccountMetadata,
  AssetBalance,
  BalanceAlert,
  BalanceAlertRule,
  BalanceAlertCondition,
  SponsorshipResult,
} from "./types";
export type { AssetBalanceFilter } from "./getAssetBalances";
export type { MultipleAssetBalancesResult } from "./getMultipleAssetBalances";
export type { AccountStreamConfig } from "./streamAccount";
export type {
  AccountEvent,
  AccountEventTransport,
  AccountEventType,
  AccountSubscriptionOptions,
  EventSubscription as AccountEventSubscription,
} from "./subscriptions";
export type { BalanceAlertConfig } from "./createBalanceAlert";


export { forecastBalance, forecastAccountBalance } from "./balanceForecast";
export type {
  BalanceForecastTransaction,
  BalanceForecastOptions,
  BalanceForecastPoint,
  BalanceForecastResult,
} from "./balanceForecast";

// ─── Batch account operations (#514) ─────────────────────────────────────────
export {
  bulkCreateTrustlines,
  bulkSendPayments,
  bulkRotateKeys,
  runBatchOperations,
} from "./batchOperations";
export type {
  BatchOperation,
  BatchRunner,
  BatchOperationResult,
  BatchOperationStatus,
  BatchProgress,
  BatchExecutorConfig,
  BatchExecutionReport,
  BulkTrustlineResult,
  BulkCreateTrustlineOp,
  BulkCreateTrustlinesInput,
  BulkPaymentOp,
  BulkSendPaymentsInput,
  BulkPaymentResult,
  BulkRotateKeyOp,
  BulkRotateKeysInput,
  BulkRotateKeyResult,
} from "./batchOperations";

// ─── Multi-wallet portfolio aggregation (#525) ────────────────────────────────
export { aggregatePortfolio, assetIdentifier } from "./portfolioAggregation";
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
} from "./portfolioAggregation";
