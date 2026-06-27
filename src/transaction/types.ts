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
}

export type MemoType = "text" | "id" | "hash" | "return";

export interface MemoParams {
  /** Optional memo value. If omitted, no memo is attached. */
  memo?: string;
  /** Optional memo type. Defaults to text for string memo values. */
  memoType?: MemoType;
  /** Require a memo to be present. If true and no memo is provided, transaction build fails. */
  requireMemo?: boolean;
}

export interface PaymentParams extends MemoParams {
  destination: string;
  amount: string;
  /** Defaults to XLM (native) */
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface TrustlineParams extends MemoParams {
  assetCode: string;
  assetIssuer: string;
  /** Defaults to max limit */
  limit?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface AccountCreateParams extends MemoParams {
  destination: string;
  /** Starting balance in XLM — minimum 1 XLM */
  startingBalance: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
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
  /** Slippage bound: min dest (strict-send) or max send (strict-receive) */
  slippageAmount: string;
  /** Intermediate assets in the payment path */
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
