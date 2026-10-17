import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  formatAddress,
  isNotFoundError,
  toMessage,
  retryWithBackoff,
  deduplicateRequest,
  invalidateInflightRequests,
} from "../shared";
import { profileOperation } from "../shared/metrics";
import { traceAccountFetch } from "../performance/telemetry";
import type { AccountInfo, AssetBalance } from "./types";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { CircuitBreakerRegistry } from "../network/circuitBreaker";
import { mapHorizonError } from "../shared/horizonErrorMapper";

// Shared circuit breaker registry for Horizon operations
const horizonCircuitBreaker = new CircuitBreakerRegistry({
  failureThreshold: 5,
  recoveryWindowMs: 30_000,
});

const _accountMutationVersions = new Map<string, number>();

/**
 * Invalidate in-flight and deduplicated requests for an account after a transaction
 * submission or state mutation, ensuring subsequent fetches receive fresh sequence numbers (#752).
 *
 * @param publicKey  - The account public key to invalidate.
 * @param horizonUrl - Optional Horizon URL. If omitted, all endpoints for this account are invalidated.
 */
export function invalidateAccount(publicKey: string, horizonUrl?: string): void {
  if (horizonUrl) {
    const key = `${horizonUrl}:${publicKey}`;
    _accountMutationVersions.set(key, (_accountMutationVersions.get(key) ?? 0) + 1);
    invalidateInflightRequests(`getAccount:${horizonUrl}:${publicKey}`);
  } else {
    for (const [k, v] of _accountMutationVersions.entries()) {
      if (k.endsWith(`:${publicKey}`)) {
        _accountMutationVersions.set(k, v + 1);
      }
    }
    _accountMutationVersions.set(`:${publicKey}`, (_accountMutationVersions.get(`:${publicKey}`) ?? 0) + 1);
    invalidateInflightRequests(`:${publicKey}`);
  }
}

export const invalidateAccountCache = invalidateAccount;

/**
 * Refresh or set the known sequence for an account after mutation (#752).
 */
export function refreshAccountSequence(publicKey: string, horizonUrl?: string): void {
  invalidateAccount(publicKey, horizonUrl);
}

/**
 * Clear all account deduplication and mutation tracking state (for testing).
 */
export function clearAccountDeduplication(): void {
  _accountMutationVersions.clear();
  invalidateInflightRequests("getAccount:");
}

/**
 * Options for `getAccount`.
 */
export interface GetAccountOptions {
  /** Optional `signal` to abort in-flight requests on timeout (#392). */
  signal?: AbortSignal | undefined;
  /**
   * Sequence number to include in the deduplication key so that concurrent
   * fetches expecting different sequence states do not collide (#752).
   */
  sequence?: string | bigint | number | undefined;
  /**
   * Expected sequence number to include in the deduplication key (#752).
   */
  expectedSequence?: string | bigint | number | undefined;
  /**
   * Force a fresh request by bypassing and invalidating any currently in-flight deduplicated request (#752).
   */
  forceRefresh?: boolean | undefined;
}

/**
 * Fetch full account details including all balances from Horizon.
 *
 * Retries transiently with exponential back-off before surfacing an error.
 * Returns `ACCOUNT_NOT_FOUND` when the account has never been funded,
 * and `ACCOUNT_FETCH_FAILED` for all other network or server errors.
 *
 * @param horizonUrl - Base URL of the Horizon server (e.g. `"https://horizon-testnet.stellar.org"`).
 * @param publicKey  - Stellar G-address of the account to look up.
 * @param options    - Optional `signal`, `sequence`, `expectedSequence`, or `forceRefresh`.
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
  options?: GetAccountOptions,
): Promise<SorokitResult<AccountInfo>> {
  if (options?.forceRefresh) {
    invalidateAccount(publicKey, horizonUrl);
  }

  const version =
    (_accountMutationVersions.get(`${horizonUrl}:${publicKey}`) ?? 0) +
    (_accountMutationVersions.get(`:${publicKey}`) ?? 0);
  const explicitSeq = options?.sequence ?? options?.expectedSequence;
  const seqSuffix = explicitSeq !== undefined ? `:seq:${explicitSeq}` : "";
  const cacheKey = `getAccount:${horizonUrl}:${publicKey}:v${version}${seqSuffix}`;

  return traceAccountFetch(
    () =>
      profileOperation("account.get", () =>
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
        const pf = (s: string): number => {
          const v = parseFloat(s);
          if (v > Number.MAX_SAFE_INTEGER) {
            console.warn(
              `[sorokit] Balance "${s}" exceeds MAX_SAFE_INTEGER — use the string 'balance' field for full precision.`,
            );
          }
          return v;
        };

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
      const mapped = mapHorizonError(cause, {
        resource: "account",
        fallbackCode: isNotFoundError(cause)
          ? SorokitErrorCode.ACCOUNT_NOT_FOUND
          : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      });
      return err(
        mapped.code,
        mapped.code === SorokitErrorCode.ACCOUNT_NOT_FOUND
          ? `Account not found: ${publicKey}`
          : mapped.message || `Failed to fetch account: ${toMessage(cause)}`,
        cause,
        undefined,
        mapped.recovery ? { recovery: mapped.recovery } : undefined,
      );
    }
        }),
      ),
  );
}
