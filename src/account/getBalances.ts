import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { AssetBalance } from "./types";
import { getAccount } from "./getAccount";

/**
 * Fetch only the balances for an account.
 * Lighter call when full account metadata is not needed.
 */
export async function getBalances(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<AssetBalance[]>> {
  const result = await getAccount(horizonUrl, publicKey);
  if (result.status === "error") return result;
  return ok(result.data.balances);
}
