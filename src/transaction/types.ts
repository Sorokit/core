/**
 * Transaction module public types.
 */

export type TransactionStatus = "pending" | "success" | "failed" | "not_found";

export interface TransactionResult {
  hash: string;
  status: TransactionStatus;
  ledger?: number;
  createdAt?: string;
  fee?: string;
  /** Raw envelope XDR for debugging */
  envelopeXdr?: string;
  /** Result XDR */
  resultXdr?: string;
  /** Operation types parsed from envelopeXdr, e.g. ["payment", "changeTrust"] */
  operationTypes?: string[];
}

export type MemoType = "text" | "id" | "hash" | "return";

export interface MemoParams {
  /** Optional memo value. If omitted, no memo is attached. */
  memo?: string;
  /** Optional memo type. Defaults to text for string memo values. */
  memoType?: MemoType;
  /** Require a memo to be present. If true and no memo is provided, transaction build fails. */
  requireMemo?: boolean;
  /**
   * Optional custom validation callback applied before the memo is attached.
   * Receives the raw memo string and must return SorokitResult<void>.
   * A returned error result surfaces as TX_BUILD_FAILED and aborts the build.
   */
  memoValidator?: (memo: string) => import("../shared/response").SorokitResult<void>;
  /**
   * When true, simulate the transaction and return a fee estimate instead of
   * the final signed XDR. Requires `rpcUrl` to be provided.
   */
  preview?: boolean;
  /**
   * Soroban RPC URL used for simulation when `preview` is true.
   */
  rpcUrl?: string;
}

export interface PaymentParams extends MemoParams {
  destination: string;
  amount: string;
  /** Defaults to XLM (native) */
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  /** When true, reuses a 30-second shared sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface TrustlineParams extends MemoParams {
  assetCode: string;
  assetIssuer: string;
  /** Defaults to max limit */
  limit?: string;
  /** When true, reuses a 30-second shared sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface AccountCreateParams extends MemoParams {
  destination: string;
  /** Starting balance in XLM — minimum 1 XLM */
  startingBalance: string;
  /** When true, reuses a 30-second shared sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface PaymentWithTrustlineParams {
  /** Trustline parameters to establish before payment */
  trustline: TrustlineParams;
  /** Payment parameters to execute after trustline */
  payment: PaymentParams;
}

export interface SwapTransactionParams {
  /** First payment (send asset A) */
  paymentA: PaymentParams;
  /** Second payment (receive asset B) */
  paymentB: PaymentParams;
}

export interface ReverseTransactionParams {
  /** Override fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

export type PathPaymentMode = "strict-send" | "strict-receive";

export interface PathPaymentParams extends MemoParams {
  destination: string;
  sendAssetCode?: string;
  sendAssetIssuer?: string;
  destAssetCode?: string;
  destAssetIssuer?: string;
  /** "strict-send": exact send amount; "strict-receive": exact dest amount */
  mode: PathPaymentMode;
  /** Amount to send (strict-send) or receive (strict-receive) */
  amount: string;
  /** Slippage bound: min dest (strict-send) or max send (strict-receive). If omitted, dynamic path discovery is used to compute it. */
  slippageAmount?: string;
  /** Intermediate assets in the payment path. If omitted, dynamically discovered. */
  path?: Array<{ assetCode?: string; assetIssuer?: string }>;
  autoFetchSequence?: boolean;
}

export interface AtomicSwapParams extends MemoParams {
  /** First leg of the swap */
  legA: PathPaymentParams;
  /** Second leg of the swap */
  legB: PathPaymentParams;
}

export type { FeeEstimate, FeeEstimateOptions } from "./estimateFee";
