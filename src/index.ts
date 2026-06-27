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
export { FreighterAdapter } from "./wallet/adapters/freighter";
export { XBullAdapter } from "./wallet/adapters/xbull";
export { LobstrAdapter } from "./wallet/adapters/lobstr";
export {
  collectMultiSignatures,
  diagnoseWalletConnection,
  detectInstalledWallets,
  recommendWallets,
} from "./wallet";

// ─── Wallet types ─────────────────────────────────────────────────────────────
export type {
  WalletAdapter,
  WalletState,
  SignTransactionInput,
  SWKInstance,
  DiagnosticStatus,
  DiagnosticCheck,
  WalletDiagnosticReport,
  WalletDiagnosticOptions,
  DetectedWallet,
  RecommendationCriteria,
  WalletFeature,
} from "./wallet/types";
export { WalletType } from "./wallet/types";

// ─── Network ──────────────────────────────────────────────────────────────────
export { resolveNetwork } from "./network/resolveNetwork";
export type { NetworkOverrides } from "./network/resolveNetwork";
export type { NetworkType } from "./network/config";
export { NETWORK_DEFAULTS } from "./network/config";
export type { ResolvedNetworkConfig } from "./shared/types";

// ─── Account types ────────────────────────────────────────────────────────────
export type {
  AccountInfo,
  AssetBalance,
  BalanceAlert,
  BalanceAlertRule,
  BalanceAlertCondition,
} from "./account/types";
export { evaluateBalanceAlerts } from "./account/balanceAlerts";
export type { AssetBalanceFilter } from "./account/getAssetBalances";
export type { AccountStreamConfig } from "./account/streamAccount";

// ─── Transaction types ────────────────────────────────────────────────────────
export type {
  TransactionResult,
  TransactionStatus,
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  ReverseTransactionParams,
  PathPaymentParams,
  PathPaymentMode,
  AtomicSwapParams,
} from "./transaction/types";
export type { FeeEstimate, FeeEstimateInput, FeeEstimateOptions } from "./transaction/estimateFee";
export { createTransactionContext, TRANSACTION_CONTEXT_TTL_MS } from "./transaction/transactionContext";
export type { TransactionBuilderContext } from "./transaction/transactionContext";
export type {
  TransactionStreamConfig,
  TransactionPage,
} from "./transaction/streamTransactions";

// ─── Soroban types ────────────────────────────────────────────────────────────
export type {
  ContractMethod,
  ContractMethodInput,
  ContractAbi,
  ContractAbiMethod,
  ContractInvokeParams,
  ContractReadParams,
  ContractCallResult,
  PreparedContractCall,
  SorobanPollConfig,
  SimulateTransactionResult,
  BatchContractInvocation,
  BatchContractResult,
} from "./soroban/types";
export { subscribeContractEvents } from "./soroban/subscribeContractEvents";
export { buildContractDeploy } from "./soroban/deployContract";
export { invokeBatchContracts } from "./soroban/invokeBatchContracts";
export type { BuildContractDeployOptions } from "./soroban/deployContract";
export type {
  ContractEvent,
  ContractEventFilter,
  ContractEventSubscriptionOptions,
} from "./soroban/subscribeContractEvents";

// ─── Response system ──────────────────────────────────────────────────────────
export type { SorokitResult, SorokitError } from "./shared/response";
export { SorokitErrorCode, ok, err, isOk, isErr, isErrorCode, assertOk, attachTraceId } from "./shared/response";
export { generateTraceId } from "./shared/utils";
export type { SorokitLogger, LogLevel, LoggerConfig } from "./shared/logger";
export { createTracedLogger } from "./shared/logger";
export type { SorokitCache } from "./shared/cache";

// ─── Metrics ──────────────────────────────────────────────────────────────────
export type { MetricEntry, MetricSummary, MetricsFilter } from "./shared/metrics";
export { recordMetric, getMetrics, clearMetrics, withMetrics, metricsCollector } from "./shared/metrics";
