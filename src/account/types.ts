/**
 * Account module public types.
 * No other module imports these directly — they go through this file.
 */

export interface AccountInfo {
  publicKey: string;
  /** Shortened display format e.g. GABCD...WXYZ */
  displayAddress: string;
  sequence: string;
  subentryCount: number;
  balances: AssetBalance[];
}

export interface AccountMetadata {
  publicKey: string;
  sequence: string;
  subentryCount: number;
  lastModifiedLedger?: number;
  homeDomain?: string;
  thresholds?: {
    lowThreshold?: number;
    medThreshold?: number;
    highThreshold?: number;
  };
}

export interface AssetBalance {
  assetType:
    | "native"
    | "credit_alphanum4"
    | "credit_alphanum12"
    | "liquidity_pool_shares";
  assetCode: string;
  assetIssuer: string | null;
  balance: string;
  /**
   * Parsed float for convenience (using `parseFloat`).
   *
   * **Precision warning**: JavaScript `number` (IEEE-754 double) can represent
   * integers up to `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991) without
   * loss. Stellar balances carry 7 decimal places, so the maximum safe balance
   * value is ~900,719,925,474 XLM — well above any realistic account balance.
   * However, balances exceeding ~900 trillion XLM (or ~90 trillion for assets
   * with more decimals) **will silently lose precision**. For cryptographic
   * accuracy in those edge cases, use the string-typed `balance` field instead.
   */
  balanceFloat: number;
  /**
   * The Horizon liquidity pool ID for `liquidity_pool_shares` balances.
   * Populated from the `liquidity_pool_id` field returned by the Horizon API.
   * Undefined for all other asset types.
   */
  liquidityPoolId?: string;
}

/**
 * Condition evaluated by a {@link BalanceAlertRule}.
 * - `below` — fire when the balance drops below the threshold.
 * - `above` — fire when the balance rises above the threshold.
 * - `change_percent` — fire when the absolute % change between polls meets the threshold.
 * - `min_reserve` — fire when the balance approaches or drops below the calculated minimum reserve.
 */
export type BalanceAlertCondition = "below" | "above" | "change_percent" | "min_reserve";

/**
 * Account structure input used for calculating minimum reserve requirements.
 */
export interface AccountReserveStructure {
  subentryCount?: number;
  numSubentries?: number;
  trustlines?: number | unknown[];
  signers?: number | unknown[];
  offers?: number | unknown[];
  dataEntries?: number | unknown[];
}

/**
 * A rule describing a balance condition worth alerting on.
 * Used by `streamAccount` to emit {@link BalanceAlert}s as balances change.
 */
export interface BalanceAlertRule {
  /** Asset code to watch, e.g. "XLM" or "USDC". For "min_reserve", watches native "XLM". */
  assetCode: string;
  /**
   * Optional issuer to disambiguate assets that share a code.
   * Omit to match the asset by code alone; pass `null` to match the native asset.
   */
  assetIssuer?: string | null;
  /** Condition to evaluate against the balance. */
  condition: BalanceAlertCondition;
  /**
   * Threshold value.
   * - For `below`/`above`: an absolute balance threshold.
   * - For `change_percent`: a percentage magnitude (e.g. `10` means 10%).
   * - For `min_reserve`: buffer in XLM above the minimum reserve to warn early (defaults to 0).
   */
  threshold: number;
  /** Optional buffer in XLM above the reserve for min_reserve alerts. */
  bufferXlm?: number;
  /** Optional identifier echoed back on every alert produced by this rule. */
  id?: string;
}

/**
 * The string type identifier returned by Horizon for each operation.
 * Matches `HorizonApi.OperationResponseType` values.
 */
export type OperationType =
  | "create_account"
  | "payment"
  | "path_payment_strict_receive"
  | "path_payment_strict_send"
  | "manage_sell_offer"
  | "manage_buy_offer"
  | "create_passive_sell_offer"
  | "set_options"
  | "change_trust"
  | "allow_trust"
  | "account_merge"
  | "inflation"
  | "manage_data"
  | "bump_sequence"
  | "create_claimable_balance"
  | "claim_claimable_balance"
  | "begin_sponsoring_future_reserves"
  | "end_sponsoring_future_reserves"
  | "revoke_sponsorship"
  | "clawback"
  | "clawback_claimable_balance"
  | "set_trust_line_flags"
  | "liquidity_pool_deposit"
  | "liquidity_pool_withdraw"
  | "invoke_host_function"
  | "bump_footprint_expiration"
  | "restore_footprint";

/**
 * A normalised representation of a single Stellar operation returned by Horizon.
 * All core fields from `BaseOperationResponse` are always present.
 * Type-specific fields (amount, asset, destination, etc.) are carried in `raw`
 * for consumers that need them without us having to enumerate every variant.
 */
export interface OperationInfo {
  /** Horizon-assigned operation ID (string to avoid BigInt issues). */
  id: string;
  /** Cursor token for pagination — pass as `cursor` to resume from this record. */
  pagingToken: string;
  /** G-address of the account that submitted this operation. */
  sourceAccount: string;
  /** Human-readable operation type string (e.g. "payment", "create_account"). */
  type: OperationType;
  /** ISO 8601 timestamp when the operation was included in a ledger. */
  createdAt: string;
  /** Hash of the transaction that contains this operation. */
  transactionHash: string;
  /** Whether the parent transaction succeeded. */
  transactionSuccessful: boolean;
  /**
   * The raw Horizon record, typed as `Record<string, unknown>` for access to
   * operation-specific fields (amount, asset_code, destination, etc.) without
   * requiring a switch on `type`.
   */
  raw: Record<string, unknown>;
}

/**
 * Options for `getOperations()`.
 */
export interface GetOperationsOptions {
  /**
   * Filter to operations of this type only. Client-side filter applied after
   * Horizon returns results (Horizon's `forAccount` does not support type
   * filtering natively).
   */
  type?: OperationType;
  /**
   * Only return operations whose `source_account` matches this G-address.
   * Client-side filter.
   */
  sourceAccount?: string;
  /**
   * Only return operations created on or after this ISO 8601 date-time string.
   * Client-side filter.
   */
  after?: string;
  /**
   * Only return operations created before this ISO 8601 date-time string.
   * Client-side filter.
   */
  before?: string;
  /**
   * Cursor for pagination. Pass the `pagingToken` of the last record from the
   * previous page to fetch the next page.
   */
  cursor?: string;
  /**
   * Maximum number of records to return per page. Defaults to 20, max 200.
   */
  limit?: number;
  /**
   * Sort order. Defaults to "desc" (newest first).
   */
  order?: "asc" | "desc";
  /**
   * Whether to include operations from failed transactions. Defaults to false.
   */
  includeFailed?: boolean;
}

/**
 * Paginated result returned by `getOperations()`.
 */
export interface OperationsPage {
  /** The operations on this page, after any client-side filters are applied. */
  operations: OperationInfo[];
  /**
   * Paging token of the last record on this page. Pass as `cursor` to fetch
   * the next page. `null` when the page is empty.
   */
  nextCursor: string | null;
}

/**
 * An alert emitted when a {@link BalanceAlertRule} condition is crossed.
 */
export interface BalanceAlert {
  /** The rule that produced this alert. */
  rule: BalanceAlertRule;
  /** Asset code the alert concerns. */
  assetCode: string;
  /** Asset issuer the alert concerns (null for the native asset). */
  assetIssuer: string | null;
  /** Balance at the previous poll (equal to `newBalance` when no baseline existed). */
  oldBalance: string;
  /** Balance at the current poll. */
  newBalance: string;
  /** Signed percentage change since the previous poll, or null when not computable. */
  changePercent: number | null;
  /** Calculated minimum reserve in XLM when evaluating min_reserve rules. */
  minimumReserve?: number;
  /** Minimum reserve in stroops (1 XLM = 10,000,000 stroops). */
  minimumReserveStroops?: bigint;
  /** True when the balance has dropped below the calculated minimum reserve. */
  isSubReserve?: boolean;
}

export type { SponsorshipResult } from "./sponsorship";
