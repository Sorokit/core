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
