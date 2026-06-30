import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { AssetBalance } from "./types";
import type { AssetBalanceFilter } from "./getAssetBalances";
import { getAssetBalances } from "./getAssetBalances";

/**
 * Result of a bulk asset-balance query.
 * Each public key maps to its own SorokitResult so callers can handle partial
 * failures without losing successful results.
 */
export type MultipleAssetBalancesResult = Record<
  string,
  SorokitResult<AssetBalance[]>
>;

/**
 * Fetch asset balances for multiple accounts in parallel using
 * Promise.allSettled(), applying the same optional filter to every account.
 *
 * Accounts are fetched concurrently — the total wall-clock time is bounded by
 * the slowest single fetch rather than the sum of all fetches.
 *
 * Partial failures are isolated: a failed fetch for one key does not prevent
 * results for the others from being returned.
 *
 * @param horizonUrl    Horizon base URL
 * @param publicKeys    Stellar public keys to query (duplicates are deduplicated)
 * @param filter        Optional balance filter applied to every account
 * @param trustedIssuers  Issuer whitelist — null means no whitelist
 *
 * @example
 * const results = await getMultipleAssetBalances(
 *   "https://horizon-testnet.stellar.org",
 *   ["GAAA...", "GBBB..."],
 *   { assetCode: "USDC", excludeZero: true },
 * );
 * for (const [key, result] of Object.entries(results)) {
 *   if (result.status === "ok") console.log(key, result.data);
 * }
 */
export async function getMultipleAssetBalances(
  horizonUrl: string,
  publicKeys: string[],
  filter?: AssetBalanceFilter,
  trustedIssuers?: string[] | null,
): Promise<MultipleAssetBalancesResult> {
  const uniqueKeys = [...new Set(publicKeys)];

  const settled = await Promise.allSettled(
    uniqueKeys.map(async (publicKey) => {
      const result = await getAssetBalances(
        horizonUrl,
        publicKey,
        filter,
        trustedIssuers,
      );
      return { publicKey, result };
    }),
  );

  const output: MultipleAssetBalancesResult = {};

  for (let i = 0; i < settled.length; i++) {
    const item = settled[i]!;
    const key = uniqueKeys[i]!;

    if (item.status === "fulfilled") {
      output[item.value.publicKey] = item.value.result;
    } else {
      output[key] = err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Failed to fetch account ${key}: ${toMessage(item.reason)}`,
        item.reason,
      );
    }
  }

  return output;
}
