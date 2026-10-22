/**
 * Transaction module public types.
 */

export type TransactionStatus = "pending" | "success" | "failed" | "not_found";

export interface TransactionResult {
  hash: string;
  status: TransactionStatus;
  /**
   * Ledger sequence number the transaction was included in.
   * `undefined` when `status` is `"pending"` — Horizon reports `ledger_attr`
   * as `0` (or omits it) for transactions that have been submitted but not
   * yet confirmed in a ledger, so that value is never surfaced here.
   */
  ledger?: number;
  createdAt?: string;
  fee?: string;
  /** Raw envelope XDR for debugging */
  envelopeXdr?: string;
  /** Result XDR */
  resultXdr?: string;
}

export type MemoType = "text" | "id" | "hash" | "return";

export type MemoValidationRule = "required" | "prohibit" | "require_format";

export interface MemoValidationConfig {
  /** The memo enforcement policy rule: "required", "prohibit", or "require_format". */
  rule: MemoValidationRule;
  /**
   * Expected format pattern when rule is "require_format".
   * Can be a RegExp pattern, a regex string, or a custom predicate function `(memo: string) => boolean`.
   */
  format?: RegExp | string | ((memo: string) => boolean);
  /** Optional custom error message to return on validation failure */
  errorMessage?: string;
  /**
   * When true, allows empty strings or whitespace-only memos.
   * Defaults to false (empty and whitespace-only memos are rejected by default).
   */
  allowEmpty?: boolean;
}

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
   * Optional memo enforcement policy configuration.
   * Supports "required", "prohibit", and "require_format" with custom format patterns.
   */
  memoValidation?: MemoValidationConfig | MemoValidationRule;
  /**
   * When true, opt in to allowing empty strings or whitespace-only memos (#846).
   * Defaults to false (empty and whitespace-only memos are rejected by default).
   */
  allowEmptyMemo?: boolean;
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
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made — the transaction is
   * built entirely offline. Use with caution: sequence numbers can become stale
   * if the account submits other transactions before this one is submitted,
   * resulting in a `tx_bad_seq` error on submission.
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE. Useful when
   * building transactions offline alongside {@link sequenceNumber}.
   */
  estimatedFee?: string;
}

export interface TrustlineParams extends MemoParams {
  assetCode: string;
  assetIssuer: string;
  /** Defaults to max limit */
  limit?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made — the transaction is
   * built entirely offline. Use with caution: sequence numbers can become stale.
   * @see PaymentParams.sequenceNumber
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE.
   */
  estimatedFee?: string;
}

export interface AccountCreateParams extends MemoParams {
  destination: string;
  /** Starting balance in XLM — minimum 1 XLM */
  startingBalance: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made — the transaction is
   * built entirely offline. Use with caution: sequence numbers can become stale.
   * @see PaymentParams.sequenceNumber
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE.
   */
  estimatedFee?: string;
}

export interface ManageOfferParams extends MemoParams {
  sellingAssetCode: string;
  sellingAssetIssuer?: string;
  buyingAssetCode: string;
  buyingAssetIssuer?: string;
  amount: string;
  price: string;
  /**
   * Suppress warnings when `price` is outside the typical range
   * (below 0.001 or above 1000 buying units per selling unit).
   */
  suppressPriceWarnings?: boolean;
  /** Override the default offer-price warning bounds (0.001–1000). */
  priceWarningRange?: { min?: number; max?: number };
  offerId?: string;
  autoFetchSequence?: boolean;
}

export interface ClawbackParams extends MemoParams {
  assetCode: string;
  assetIssuer: string;
  from: string;
  amount: string;
  autoFetchSequence?: boolean;
}

export interface LiquidityPoolDepositParams extends MemoParams {
  liquidityPoolId: string;
  maxAmountA: string;
  maxAmountB: string;
  minPrice: string;
  maxPrice: string;
  autoFetchSequence?: boolean;
}

export interface LiquidityPoolWithdrawParams extends MemoParams {
  liquidityPoolId: string;
  amount: string;
  minAmountA: string;
  minAmountB: string;
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
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made.
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops. Overrides the `fee` field.
   * When provided alongside `sequenceNumber`, the transaction is built entirely offline.
   */
  estimatedFee?: string;
}

export type PathPaymentMode = "strict-send" | "strict-receive";

export interface PathPaymentParams extends MemoParams {
  destination: string;
  /** How to handle destination equal to the source account. Defaults to "warn". */
  selfPaymentBehavior?: "warn" | "error" | "allow";
  /** Explicit opt-in for intentional self-payments. */
  allowSelfPayment?: boolean;
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
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made — the transaction is
   * built entirely offline. Use with caution: sequence numbers can become stale.
   * @see PaymentParams.sequenceNumber
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE.
   */
  estimatedFee?: string;
}

export interface AtomicSwapParams extends MemoParams {
  /** First leg of the swap */
  legA: PathPaymentParams;
  /** Second leg of the swap */
  legB: PathPaymentParams;
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made.
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE.
   */
  estimatedFee?: string;
}

// ─── Multi-signature types ────────────────────────────────────────────────────

/**
 * A signer entry for a multi-sig envelope.
 * Maps a public key to its signing weight.
 */
export interface MultiSigSigner {
  /** Stellar public key (G...) of this signer. */
  publicKey: string;
  /** Signing weight this key contributes. Must be >= 1. */
  weight: number;
}

export interface SetOptionsParams {
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  signers?: MultiSigSigner[];
  homeDomain?: string | null;
  inflationDest?: string | null;
  clearFlags?: number;
  sequenceNumber?: string;
  estimatedFee?: string;
}

/**
 * Parameters for building a multi-sig transaction envelope.
 */
export interface MultiSigEnvelopeParams extends MemoParams {
  /** Operations to include — same as a normal payment/trustline/etc. The XDR of an already-built transaction. */
  transactionXdr: string;
  /** Signers expected to co-sign this envelope. */
  signers: MultiSigSigner[];
  /**
   * Minimum cumulative weight required to authorise the transaction.
   * Submission is blocked until collected signature weights meet this threshold.
   */
  threshold: number;
}

/**
 * A partially- or fully-signed multi-sig envelope ready for incremental signature collection.
 */
export interface MultiSigEnvelope {
  /** Current envelope XDR (base64). Updated by collectSignature(). */
  envelopeXdr: string;
  /** Signers declared at envelope creation. */
  signers: MultiSigSigner[];
  /** Required cumulative weight to authorise submission. */
  threshold: number;
  /** Public keys whose signatures have been collected so far. */
  collectedSigners: string[];
  /** Cumulative weight of collected signatures. */
  collectedWeight: number;
  /** True when collectedWeight >= threshold. */
  thresholdMet: boolean;
}

// ─── Claimable balances (#543) ────────────────────────────────────────────────

export type ClaimPredicateType =
  | "unconditional"
  | "beforeAbsoluteTime"
  | "afterAbsoluteTime"
  | "beforeRelativeTime"
  | "afterRelativeTime"
  | "and"
  | "or"
  | "not";

/**
 * A claim predicate controlling when a claimable balance can be claimed.
 *
 * - `unconditional` — claimable at any time.
 * - `beforeAbsoluteTime` — claimable until the given Unix timestamp (seconds).
 * - `afterAbsoluteTime` — claimable after the given Unix timestamp (seconds).
 * - `beforeRelativeTime` — claimable until `seconds` after balance creation.
 * - `afterRelativeTime` — claimable `seconds` after balance creation.
 * - `and`/`or` — combine at least two child predicates.
 * - `not` — negates a single child predicate.
 *
 * @example // Claimable between 2023-11-01 and 2023-12-01 (unilateral window)
 * { type: "and", predicates: [
 *   { type: "afterAbsoluteTime", timestamp: 1698796800 },
 *   { type: "beforeAbsoluteTime", timestamp: 1701392400 },
 * ] }
 */
export interface ClaimPredicateInput {
  type: ClaimPredicateType;
  /** Unix timestamp (seconds) required by absolute-time predicates. */
  timestamp?: string | number;
  /** Relative seconds required by relative-time predicates. */
  seconds?: string | number;
  /** Children for `and` / `or` predicates (at least two). */
  predicates?: ClaimPredicateInput[];
  /** Child for the `not` predicate. */
  predicate?: ClaimPredicateInput;
}

export interface CreateClaimableBalanceParams extends MemoParams {
  /** Asset to lock. Either an `Asset` instance or `assetCode`/`assetIssuer`. */
  asset?: import("@stellar/stellar-sdk").Asset;
  assetCode?: string;
  assetIssuer?: string;
  /** Amount to lock: positive, at most 7 decimal places. */
  amount: string;
  /** Account allowed to claim. Stellar (G...) or muxed (M...) address. */
  claimant: string;
  /** Claim predicate controlling when the balance may be claimed. */
  predicate: ClaimPredicateInput;
  /** When true, reuses a 5-second module-level sequence cache. */
  autoFetchSequence?: boolean;
  /**
   * Pre-fetched sequence number for the source account. When provided, no
   * Horizon `loadAccount` call is made — the transaction is built offline.
   */
  sequenceNumber?: string;
  /** Pre-fetched fee in stroops. When provided, replaces BASE_FEE. */
  estimatedFee?: string;
}

export interface ClaimClaimableBalanceParams extends MemoParams {
  /**
   * Claimable balance ID as hex (8-byte discriminant + 32-byte hash),
   * e.g. `"000000007f18e80..."`.
   */
  balanceId: string;
  /** When true, reuses a 5-second module-level sequence cache. */
  autoFetchSequence?: boolean;
  /**
   * Pre-fetched sequence number for the source account. When provided, no
   * Horizon `loadAccount` call is made — the transaction is built offline.
   */
  sequenceNumber?: string;
  /** Pre-fetched fee in stroops. When provided, replaces BASE_FEE. */
  estimatedFee?: string;
}

// ─── Bump sequence (#554) ─────────────────────────────────────────────────────

export interface BumpSequenceParams extends MemoParams {
  /**
   * Sequence number to bump to. Must be a stringified integer greater than the
   * source account's current sequence and at most `2^64 - 1`.
   */
  bumpToSequence: string;
  /** When true, reuses a 5-second module-level sequence cache. */
  autoFetchSequence?: boolean;
  /**
   * Pre-fetched sequence number for the source account. When provided, no
   * Horizon `loadAccount` call is made — the transaction is built offline.
   */
  sequenceNumber?: string;
  /** Pre-fetched fee in stroops. When provided, replaces BASE_FEE. */
  estimatedFee?: string;
}

export type { FeeEstimate, FeeEstimateOptions } from "./estimateFee";
export type {
  CostBasisLot,
  CostBasisOptions,
  ExportFormat,
  ExportedTransaction,
  ExportTransactionHistoryOptions,
} from "./exportTransactionHistory";
