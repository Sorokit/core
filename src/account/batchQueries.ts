/**
 * Batch Account Operations (#957).
 *
 * Provides parallel batch queries for fetching multiple accounts and balances
 * in one operation using Promise.allSettled to minimize network roundtrips.
 *
 * In accordance with specifications:
 * - Parallelized requests
 * - No results caching
 * - Graceful partial failure handling
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { getAccount } from "./getAccount";
import { getBalances } from "./getBalances";
import type { AccountInfo, AssetBalance } from "./types";
import { NETWORK_DEFAULTS } from "../network/config";

export interface BatchQueryOptions {
  signal?: AbortSignal;
  /**
   * When true (default), partial failures are omitted from the returned list
   * and the call still succeeds with all successfully fetched accounts/balances.
   * When false, any failure causes the whole batch operation to return an error.
   */
  allowPartial?: boolean;
}

/**
 * Fetch full account details for multiple accounts in parallel from Horizon without caching.
 *
 * @param publicKeys - Array of Stellar account public keys.
 * @param options - Batch options (signal, allowPartial).
 * @returns SorokitResult<AccountInfo[]>
 */
export async function getAccountsBatch(
  publicKeys: string[],
  options?: BatchQueryOptions,
): Promise<SorokitResult<AccountInfo[]>>;
export async function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
  options?: BatchQueryOptions,
): Promise<SorokitResult<AccountInfo[]>>;
export async function getAccountsBatch(
  arg1: string | string[],
  arg2?: string[] | BatchQueryOptions,
  arg3?: BatchQueryOptions,
): Promise<SorokitResult<AccountInfo[]>> {
  let horizonUrl: string;
  let publicKeys: string[];
  let options: BatchQueryOptions | undefined;

  if (typeof arg1 === "string") {
    horizonUrl = arg1;
    publicKeys = Array.isArray(arg2) ? arg2 : [];
    options = arg3;
  } else {
    horizonUrl = NETWORK_DEFAULTS.testnet.horizonUrl;
    publicKeys = Array.isArray(arg1) ? arg1 : [];
    options = arg2 as BatchQueryOptions | undefined;
  }

  if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
    return ok([]);
  }

  try {
    const promises = publicKeys.map((publicKey) =>
      getAccount(horizonUrl, publicKey, { signal: options?.signal }),
    );

    const settled = await Promise.allSettled(promises);
    const accounts: AccountInfo[] = [];
    const errors: string[] = [];

    settled.forEach((result, idx) => {
      const key = publicKeys[idx];
      if (result.status === "fulfilled") {
        if (result.value.status === "ok") {
          accounts.push(result.value.data);
        } else {
          errors.push(`${key}: ${result.value.error.message}`);
        }
      } else {
        errors.push(`${key}: ${toMessage(result.reason)}`);
      }
    });

    if (
      accounts.length === 0 &&
      errors.length > 0 &&
      options?.allowPartial === false
    ) {
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Failed to fetch batch accounts: ${errors.join("; ")}`,
      );
    }

    return ok(accounts);
  } catch (cause) {
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Unexpected error in getAccountsBatch: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Fetch balances for multiple accounts in parallel from Horizon without caching.
 *
 * @param publicKeys - Array of Stellar account public keys.
 * @param options - Batch options (signal, allowPartial).
 * @returns SorokitResult<AssetBalance[][]>
 */
export async function getBalancesBatch(
  publicKeys: string[],
  options?: BatchQueryOptions,
): Promise<SorokitResult<AssetBalance[][]>>;
export async function getBalancesBatch(
  horizonUrl: string,
  publicKeys: string[],
  options?: BatchQueryOptions,
): Promise<SorokitResult<AssetBalance[][]>>;
export async function getBalancesBatch(
  arg1: string | string[],
  arg2?: string[] | BatchQueryOptions,
  arg3?: BatchQueryOptions,
): Promise<SorokitResult<AssetBalance[][]>> {
  let horizonUrl: string;
  let publicKeys: string[];
  let options: BatchQueryOptions | undefined;

  if (typeof arg1 === "string") {
    horizonUrl = arg1;
    publicKeys = Array.isArray(arg2) ? arg2 : [];
    options = arg3;
  } else {
    horizonUrl = NETWORK_DEFAULTS.testnet.horizonUrl;
    publicKeys = Array.isArray(arg1) ? arg1 : [];
    options = arg2 as BatchQueryOptions | undefined;
  }

  if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
    return ok([]);
  }

  try {
    const promises = publicKeys.map((publicKey) =>
      getBalances(horizonUrl, publicKey, { signal: options?.signal }),
    );

    const settled = await Promise.allSettled(promises);
    const balancesList: AssetBalance[][] = [];
    const errors: string[] = [];

    settled.forEach((result, idx) => {
      const key = publicKeys[idx];
      if (result.status === "fulfilled") {
        if (result.value.status === "ok") {
          balancesList.push(result.value.data);
        } else {
          errors.push(`${key}: ${result.value.error.message}`);
        }
      } else {
        errors.push(`${key}: ${toMessage(result.reason)}`);
      }
    });

    if (
      balancesList.length === 0 &&
      errors.length > 0 &&
      options?.allowPartial === false
    ) {
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Failed to fetch batch balances: ${errors.join("; ")}`,
      );
    }

    return ok(balancesList);
  } catch (cause) {
    return err(
      SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      `Unexpected error in getBalancesBatch: ${toMessage(cause)}`,
      cause,
    );
  }
}
