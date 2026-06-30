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

export interface AssetBalance {
  assetType:
    | "native"
    | "credit_alphanum4"
    | "credit_alphanum12"
    | "liquidity_pool_shares";
  assetCode: string;
  assetIssuer: string | null;
  balance: string;
  /** Parsed float for convenience */
  balanceFloat: number;
}

/**
 * Condition evaluated by a {@link BalanceAlertRule}.
 * - `below` — fire when the balance drops below the threshold.
 * - `above` — fire when the balance rises above the threshold.
 * - `change_percent` — fire when the absolute % change between polls meets the threshold.
 */
export type BalanceAlertCondition = "below" | "above" | "change_percent";

/**
 * A rule describing a balance condition worth alerting on.
 * Used by `streamAccount` to emit {@link BalanceAlert}s as balances change.
 */
export interface BalanceAlertRule {
  /** Asset code to watch, e.g. "XLM" or "USDC". */
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
   */
  threshold: number;
  /** Optional identifier echoed back on every alert produced by this rule. */
  id?: string;
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
}
