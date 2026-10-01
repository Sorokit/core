export { getAccount } from "./getAccount";
export { getOffers, getTrades } from "./dexActivity";
export type { DexActivityOptions, DexActivityResult, DexAsset, DexAssetAmount, OfferInfo, TradeInfo } from "./dexActivity";
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

export { getSigners, getThresholds, analyzeSigningRequirement } from "./signers";
export type { AccountSigner, AccountSigners, AccountThresholds, SigningOperation, SigningRequirement } from "./signers";
export { getPaymentHistory } from "./paymentHistory";
export type { PaymentInfo, PaymentPage, PaymentHistoryOptions } from "./paymentHistory";
export { getEffects } from "./getEffects";
export type { EffectInfo, EffectsPage, GetEffectsOptions } from "./getEffects";
export { getDataEntries } from "./dataEntries";
export type { AccountDataEntries } from "./dataEntries";

// ─── Account merge simulation & safety checks ─────────────────────────────────
export { simulateAccountMerge } from "./mergeSafety";
export type {
  MergeTrustlineInfo,
  AccountMergeSimulation,
  AccountMergeDataLoss,
  SimulateAccountMergeOptions,
} from "./mergeSafety";


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

// ─── Account attestation and credential management (#508) ─────────────────────
export {
  issueAttestation,
  verifyAttestation,
  revokeAttestation,
  isAttestationRevoked,
  clearAttestationState,
} from "./attestationCore";
export {
  getAccountAttestations,
  storeAccountAttestation,
  removeAccountAttestation,
  clearAccountAttestations,
} from "./attestationQueries";
export type {
  AccountAttestation,
  CredentialMetadata,
  GetAccountAttestationsFilter,
  AttestationVerificationResult,
  IssueAttestationOptions,
  RevocationEntry,
} from "./attestationTypes";

// ─── Account health score and risk assessment (#590) ──────────────────────────
export { getAccountHealthScore, assessAccountHealth } from "./accountHealth";
export type {
  AccountHealthInput,
  AccountHealthReport,
  AccountHealthComponents,
  AccountHealthRisk,
  AccountHealthRiskSeverity,
  AccountHealthLevel,
  AssessAccountHealthOptions,
} from "./accountHealth";
export { assessHealthScore, calculateHealthScore } from "./healthScore";
export type { HealthData, HealthRiskLevel } from "./healthScore";
export {
  addRecoverySigner,
  getRecoveryPlan,
  removeOldSigner,
  rotateKeys,
  DEFAULT_RECOVERY_WAIT_MS,
} from "./recoveryHelper";
export type { RecoveryPlan, RecoveryPlanStep } from "./recoveryHelper";

// ─── Wallet discovery and account linking (#wallet-discovery) ─────────────────
export { discoverWallet, listLinkedAccounts, linkWallet } from "../wallet/discovery";
export type { DiscoveryData, LinkedAccount } from "../wallet/discovery";

// ─── Multi-account portfolio dashboard (#592) ────────────────────────────────────────
export { getPortfolioDashboard } from "./portfolioDashboard";
export type { PortfolioDashboard } from "./portfolioDashboard";

// ─── Portfolio dashboard and asset allocation tracker (#593) ──────────────────
export {
  getPortfolio,
  getAssetAllocation,
  getPortfolioHistory,
  watchPortfolio,
} from "./portfolioDashboard";
export type {
  PortfolioAsset,
  PortfolioAllocation,
  PortfolioAllocationEntry,
  PortfolioData,
  PortfolioHistoryPoint,
  PortfolioHistory,
  PortfolioWatchOptions,
  PortfolioUpdate,
  PortfolioUpdateCallback,
} from "./portfolioDashboard";
