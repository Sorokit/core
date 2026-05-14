import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { AssetBalance } from "./types";
import { getAccount } from "./getAccount";

/**
 * Filter criteria for getAssetBalances().
 * All fields are optional — omitting all returns every balance.
 */
export interface AssetBalanceFilter {
  /**
   * Return only balances matching this asset code.
   * Case-insensitive. Use "XLM" for native.
   */
  assetCode?: string;
  /**
   * Return only balances matching this issuer.
   * Ignored for native (XLM) balances.
   */
  assetIssuer?: string;
  /**
   * Return only balances of the given asset type(s).
   */
  assetType?: AssetBalance["assetType"] | AssetBalance["assetType"][];
  /**
   * Exclude zero balances. Default: false.
   */
  excludeZero?: boolean;
}

/**
 * Fetch balances for an account, with optional filtering by asset code,
 * issuer, type, or zero-balance exclusion.
 *
 * Returns the full AssetBalance shape — same as getBalances() but filterable.
 *
 * @example
 * // All non-zero balances
 * getAssetBalances(horizonUrl, publicKey, { excludeZero: true })
 *
 * @example
 * // A specific issued asset
 * getAssetBalances(horizonUrl, publicKey, { assetCode: "USDC", assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" })
 */
export async function getAssetBalances(
  horizonUrl: string,
  publicKey: string,
  filter?: AssetBalanceFilter,
): Promise<SorokitResult<AssetBalance[]>> {
  const result = await getAccount(horizonUrl, publicKey);
  if (result.status === "error") return result;

  let balances = result.data.balances;

  if (!filter) return ok(balances);

  const { assetCode, assetIssuer, assetType, excludeZero } = filter;

  if (assetCode !== undefined) {
    const code = assetCode.toUpperCase();
    balances = balances.filter((b) => b.assetCode.toUpperCase() === code);
  }

  if (assetIssuer !== undefined) {
    balances = balances.filter(
      (b) => b.assetIssuer !== null && b.assetIssuer === assetIssuer,
    );
  }

  if (assetType !== undefined) {
    const types = Array.isArray(assetType) ? assetType : [assetType];
    balances = balances.filter((b) => types.includes(b.assetType));
  }

  if (excludeZero) {
    balances = balances.filter((b) => b.balanceFloat > 0);
  }

  return ok(balances);
}
