import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage, retryWithBackoff } from "../shared";
import { cacheSequence, getCachedSequence } from "../shared/sequenceCache";

/**
 * Prefetch and cache the sequence number for an account.
 * 
 * Fetches the current sequence number from Horizon and caches it for 30 seconds.
 * Transaction builders can use this cached sequence to avoid extra Horizon calls
 * when building transactions.
 *
 * @param horizonUrl - Base URL of the Horizon server (e.g. `"https://horizon-testnet.stellar.org"`).
 * @param publicKey  - Stellar G-address of the account to prefetch sequence for.
 * @returns `ok(sequence)` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * const result = await prefetchSequence(horizonUrl, publicKey);
 * if (result.status === "ok") {
 *   console.log("Prefetched sequence:", result.data);
 * }
 */
export async function prefetchSequence(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<string>> {
  // Check if already cached
  const cached = getCachedSequence(publicKey);
  if (cached) {
    return ok(cached);
  }

  try {
    const account = await retryWithBackoff(async () => {
      const server = new Horizon.Server(horizonUrl);
      return await server.loadAccount(publicKey);
    });

    const sequence = account.sequence;
    
    // Cache the sequence for 30 seconds
    cacheSequence(publicKey, sequence);

    return ok(sequence);
  } catch (cause) {
    return err(
      isNotFoundError(cause)
        ? SorokitErrorCode.ACCOUNT_NOT_FOUND
        : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : `Failed to fetch sequence: ${toMessage(cause)}`,
      cause,
    );
  }
}
