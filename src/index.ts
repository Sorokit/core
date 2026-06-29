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
} from "./wallet";
export type {
  EnvelopeSignatureInput,
  SignatureHintInput,
} from "./wallet";
export { FreighterAdapter } from "./wallet/adapters/freighter";
export { LobstrAdapter } from "./wallet/adapters/lobstr";
export { XBullAdapter } from "./wallet/adapters/xbull";

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

// ─── Network ──────────────────────────────────────────────────────────────────
export { NETWORK_DEFAULTS } from "./network/config";
export type { NetworkType } from "./network/config";
export { resolveNetwork } from "./network/resolveNetwork";
export type { NetworkOverrides } from "./network/resolveNetwork";
export type { ResolvedNetworkConfig } from "./shared/types";
export { checkNetworkHealth } from "./network";
export type {
  CheckNetworkHealthOptions,
  NetworkEndpointHealth,
  NetworkHealthReport,
  NetworkHealthStatus,
} from "./network";

// ─── Account types ────────────────────────────────────────────────────────────
export { evaluateBalanceAlerts } from "./account/balanceAlerts";
export type { AssetBalanceFilter } from "./account/getAssetBalances";
export { getMultipleAssetBalances } from "./account/getMultipleAssetBalances";
export type { MultipleAssetBalancesResult } from "./account/getMultipleAssetBalances";
export { streamAccount } from "./account/streamAccount";
export type { AccountStreamConfig } from "./account/streamAccount";
export type {
  AccountInfo,
  AssetBalance,
  BalanceAlert,
  BalanceAlertCondition,
  BalanceAlertRule,
} from "./account/types";

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
  usdt_assetAsset,
  eurcAsset,
  ativeAsset,
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

// ─── Transaction types ────────────────────────────────────────────────────────
export type {
  FeeEstimate,
  FeeEstimateInput,
  FeeEstimateOptions,
  FeeTiers,
} from "./transaction/estimateFee";
export { calculateFeeTiers } from "./transaction/estimateFee";
export { streamTransactions } from "./transaction/streamTransactions";
export { buildPathPayment, checkTrustlines, buildBulkTrustlines } from "./transaction/index";
export type {
  TransactionPage,
  TransactionStreamConfig,
} from "./transaction/streamTransactions";
export {
  TRANSACTION_CONTEXT_TTL_MS,
  createTransactionContext,
} from "./transaction/transactionContext";
export type { TransactionBuilderContext } from "./transaction/transactionContext";
export type {
  AccountCreateParams,
  AtomicSwapParams,
  PathPaymentMode,
  PathPaymentParams,
  PaymentParams,
  ReverseTransactionParams,
  TransactionResult,
  TransactionStatus,
  TrustlineParams,
} from "./transaction/types";

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
export { getContractMethods } from "./soroban/contractMetadata";
export { buildContractDeploy } from "./soroban/deployContract";
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
  PreparedContractCall,
  SimulateTransactionResult,
  SorobanPollConfig,
} from "./soroban/types";

// ─── Response system ──────────────────────────────────────────────────────────
export type { SorokitCache } from "./shared/cache";
export { createTracedLogger } from "./shared/logger";
export type { LogLevel, LoggerConfig, SorokitLogger } from "./shared/logger";
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
export { generateTraceId } from "./shared/utils";

// ─── Metrics ──────────────────────────────────────────────────────────────────
export {
  clearMetrics,
  getMetrics,
  metricsCollector,
  recordMetric,
  withMetrics,
} from "./shared/metrics";
export type {
  MetricEntry,
  MetricSummary,
  MetricsFilter,
} from "./shared/metrics";
