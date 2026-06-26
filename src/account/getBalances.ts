import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { AssetBalance } from "./types";
import { getAccount } from "./getAccount";

/**
 * Fetch only the asset balances for an account, omitting other account metadata.
 *
 * Lighter alternative to `getAccount` when sequence number, subentry count,
 * and display address are not required.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account to query.
 * @returns `ok(AssetBalance[])` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * const result = await getBalances(horizonUrl, publicKey);
 * if (result.status === "ok") {
 *   const xlm = result.data.find(b => b.assetCode === "XLM");
 *   console.log("XLM balance:", xlm?.balance);
 * }
 */
export async function getBalances(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<AssetBalance[]>> {
  const result = await getAccount(horizonUrl, publicKey);
  if (result.status === "error") return result;
  return ok(result.data.balances);
}
