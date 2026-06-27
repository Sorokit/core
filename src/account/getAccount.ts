import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { formatAddress, isNotFoundError, toMessage, retryWithBackoff } from "../shared";
import type { AccountInfo, AssetBalance } from "./types";

/**
 * Fetch full account details including all balances from Horizon.
 *
 * Retries transiently with exponential back-off before surfacing an error.
 * Returns `ACCOUNT_NOT_FOUND` when the account has never been funded,
 * and `ACCOUNT_FETCH_FAILED` for all other network or server errors.
 *
 * @param horizonUrl - Base URL of the Horizon server (e.g. `"https://horizon-testnet.stellar.org"`).
 * @param publicKey  - Stellar G-address of the account to look up.
 * @returns `ok(AccountInfo)` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * const result = await getAccount(horizonUrl, publicKey);
 * if (result.status === "error") {
 *   console.error(result.error.message);
 * } else {
 *   console.log(result.data.balances);
 * }
 */
export async function getAccount(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<AccountInfo>> {
  try {
    const account = await retryWithBackoff(async () => {
      const server = new Horizon.Server(horizonUrl);
      return await server.loadAccount(publicKey);
    });

    const balances: AssetBalance[] = account.balances.map((b) => {
      if (b.asset_type === "native") {
        return {
          assetType: "native" as const,
          assetCode: "XLM",
          assetIssuer: null,
          balance: b.balance,
          balanceFloat: parseFloat(b.balance),
        };
      }

      if (
        b.asset_type === "credit_alphanum4" ||
        b.asset_type === "credit_alphanum12"
      ) {
        return {
          assetType: b.asset_type,
          assetCode: b.asset_code,
          assetIssuer: b.asset_issuer,
          balance: b.balance,
          balanceFloat: parseFloat(b.balance),
        };
      }

      return {
        assetType: "liquidity_pool_shares" as const,
        assetCode: "LP",
        assetIssuer: null,
        balance: b.balance,
        balanceFloat: parseFloat(b.balance),
      };
    });

    return ok({
      publicKey,
      displayAddress: formatAddress(publicKey),
      sequence: account.sequence,
      subentryCount: account.subentry_count,
      balances,
    });
  } catch (cause) {
    return err(
      isNotFoundError(cause)
        ? SorokitErrorCode.ACCOUNT_NOT_FOUND
        : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : `Failed to fetch account: ${toMessage(cause)}`,
      cause,
    );
  }
}
