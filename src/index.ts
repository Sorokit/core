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
export { collectMultiSignatures, diagnoseWalletConnection } from "./wallet";

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
} from "./transaction/types";
export type { FeeEstimate, FeeEstimateInput, FeeEstimateOptions } from "./transaction/estimateFee";
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
} from "./soroban/types";
export { subscribeContractEvents } from "./soroban/subscribeContractEvents";
export { buildContractDeploy } from "./soroban/deployContract";
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
