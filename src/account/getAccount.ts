import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { formatAddress, isNotFoundError, toMessage, retryWithBackoff, deduplicateRequest } from "../shared";
import { profileOperation } from "../shared/metrics";
import type { AccountInfo, AssetBalance } from "./types";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { CircuitBreakerRegistry } from "../network/circuitBreaker";

// Shared circuit breaker registry for Horizon operations
const horizonCircuitBreaker = new CircuitBreakerRegistry({
  failureThreshold: 5,
  recoveryWindowMs: 30_000,
});

/**
 * Fetch full account details including all balances from Horizon.
 *
 * Retries transiently with exponential back-off before surfacing an error.
 * Returns `ACCOUNT_NOT_FOUND` when the account has never been funded,
 * and `ACCOUNT_FETCH_FAILED` for all other network or server errors.
 *
 * @param horizonUrl - Base URL of the Horizon server (e.g. `"https://horizon-testnet.stellar.org"`).
 * @param publicKey  - Stellar G-address of the account to look up.
 * @param options    - Optional `signal` to abort in-flight requests on timeout (#392).
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
export function getAccount(
  horizonUrl: string,
  publicKey: string,
  options?: { signal?: AbortSignal | undefined },
): Promise<SorokitResult<AccountInfo>> {
  const cacheKey = `getAccount:${horizonUrl}:${publicKey}`;
  return profileOperation("account.get", () =>
    deduplicateRequest(cacheKey, async () => {
    try {
      const account = await horizonCircuitBreaker.call(horizonUrl, async () => {
        return await retryWithBackoff(async () => {
          const server = createHorizonServer(horizonUrl, options);
          return await server.loadAccount(publicKey);
        });
      });

      const balances: AssetBalance[] = account.balances.map((b) => {
        // Note: parseFloat is used here for convenience/backward compatibility.
        // IEEE-754 doubles can represent integers up to ~9e15 exactly, and
        // Stellar balances are 7-decimal strings. For hypothetical balances
        // above ~900 trillion XLM, precision loss will occur — use the string
        // `balance` field for those edge cases.
        //
        // For the full precision discussion see AssetBalance.balanceFloat.
        const pf = (s: string) => parseFloat(s);

        if (b.asset_type === "native") {
          return {
            assetType: "native" as const,
            assetCode: "XLM",
            assetIssuer: null,
            balance: b.balance,
            balanceFloat: pf(b.balance),
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
            balanceFloat: pf(b.balance),
          };
        }

        const liquidityPoolId = (b as { liquidity_pool_id?: string }).liquidity_pool_id;
        return {
          assetType: "liquidity_pool_shares" as const,
          // Use the pool ID as the assetCode so callers can distinguish
          // between different liquidity pool positions. Fall back to "LP"
          // only if the field is absent (should not happen with Horizon).
          assetCode: liquidityPoolId ?? "LP",
          assetIssuer: null,
          balance: b.balance,
          balanceFloat: pf(b.balance),
          ...(liquidityPoolId !== undefined ? { liquidityPoolId } : {}),
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
    }),
  );
}
