/**
 * High-level trustline management utilities (issue #402).
 *
 * Builds on the existing account balance/trustline representation and
 * transaction builders rather than duplicating asset parsing or trustline
 * serialization.
 *
 * Note: this module loads the raw Horizon account directly
 * (`createHorizonServer(...).loadAccount(...)`) rather than going through
 * `account/getAccount.ts`. As of this writing `getAccount()` has a
 * pre-existing bug unrelated to this issue — it does not correctly unwrap
 * the `SorokitResult` its internal circuit-breaker call returns, so it
 * throws on every call (`Cannot read properties of undefined (reading
 * 'balances')`) — so this module intentionally avoids depending on it
 * until that is fixed separately. The raw account response Horizon returns
 * already carries everything trustline validation needs (including the
 * trustline `limit`, which `getAccount()`'s `AssetBalance` mapping doesn't
 * expose at all), so this isn't a loss of functionality.
 */

import { Asset, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared/errors";
import { validateTokenAsset } from "../shared/validateToken";
import type { TokenAsset } from "../shared/validateToken";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { createHorizonServer } from "../shared/serverFactory";
import { MAX_OPERATIONS_PER_TRANSACTION } from "./validateTransaction";
import { isNotFoundError } from "../shared/errors";

/** State of a single trustline for an account. */
export interface TrustlineState {
  asset: TokenAsset;
  /** True if the account currently has a trustline for this asset. */
  exists: boolean;
  /** Current balance on the trustline, or `null` if no trustline exists. */
  balance: string | null;
  /** Trustline limit, or `null` if no trustline exists. */
  limit: string | null;
}

function assetKey(asset: TokenAsset): string {
  return `${asset.code}:${asset.issuer ?? "native"}`;
}

function toStellarAsset(asset: TokenAsset): Asset {
  return asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native();
}

interface RawBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}

/** Load the raw Horizon account response, wrapped as a SorokitResult. */
async function loadRawAccount(
  horizonUrl: string,
  publicKey: string,
): Promise<SorokitResult<{ balances: RawBalanceLine[] }>> {
  try {
    const server = createHorizonServer(horizonUrl);
    const account = await server.loadAccount(publicKey);
    return ok({ balances: account.balances as unknown as RawBalanceLine[] });
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

function trustlineStateFromBalances(
  asset: TokenAsset,
  balances: RawBalanceLine[],
): TrustlineState {
  if (asset.issuer === null) {
    return { asset, exists: true, balance: null, limit: null };
  }
  const match = balances.find(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  if (!match) {
    return { asset, exists: false, balance: null, limit: null };
  }
  return {
    asset,
    exists: true,
    balance: match.balance,
    limit: match.limit ?? null,
  };
}

/**
 * Check whether `publicKey` currently has a trustline for `asset`.
 *
 * Native XLM (`issuer: null`) is always considered trusted — every funded
 * Stellar account inherently "trusts" XLM, there is no explicit trustline
 * for it.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey Account G-address to check
 * @param asset Asset to validate (code + issuer; `issuer: null` means XLM)
 * @returns `ok(TrustlineState)` describing whether the trustline exists,
 *   its balance, and its limit — or an error if the account or asset input
 *   is invalid, or the account could not be fetched.
 *
 * @example
 * const result = await validateTrustline(horizonUrl, publicKey, {
 *   code: "USDC",
 *   issuer: usdcIssuer,
 * });
 * if (result.status === "ok" && result.data.exists) {
 *   console.log(`Balance: ${result.data.balance}`);
 * }
 */
export async function validateTrustline(
  horizonUrl: string,
  publicKey: string,
  asset: TokenAsset,
): Promise<SorokitResult<TrustlineState>> {
  const assetValidation = validateTokenAsset(asset);
  if (assetValidation.status === "error") return assetValidation;

  if (asset.issuer === null) {
    return ok(trustlineStateFromBalances(asset, []));
  }

  const accountResult = await loadRawAccount(horizonUrl, publicKey);
  if (accountResult.status === "error") return accountResult;

  return ok(trustlineStateFromBalances(asset, accountResult.data.balances));
}

/**
 * Result of a bulk trustline-state query. Each asset key
 * (`"CODE:issuer"`) maps to its own `SorokitResult` so callers can handle
 * partial failures without losing successful results.
 */
export type BulkTrustlinesResult = Record<string, SorokitResult<TrustlineState>>;

/**
 * Fetch trustline state for multiple assets on one account, concurrently.
 *
 * A single Horizon account load is reused for every asset — the lookups
 * run in parallel over that shared account data rather than issuing one
 * Horizon request per asset, so this scales with asset count, not with
 * network round trips.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey Account G-address to check
 * @param assets Assets to check (duplicates are deduplicated)
 * @returns A map from asset key to its `TrustlineState` result. A failure
 *   fetching the account itself is reflected as an error result for every
 *   requested asset (there is nothing else to report); malformed individual
 *   asset entries fail only that entry.
 *
 * @example
 * const results = await getBulkTrustlines(horizonUrl, publicKey, [
 *   { code: "USDC", issuer: usdcIssuer },
 *   { code: "EURC", issuer: eurcIssuer },
 * ]);
 * for (const [key, result] of Object.entries(results)) {
 *   if (result.status === "ok") console.log(key, result.data.exists);
 * }
 */
export async function getBulkTrustlines(
  horizonUrl: string,
  publicKey: string,
  assets: TokenAsset[],
): Promise<BulkTrustlinesResult> {
  const uniqueAssets = new Map<string, TokenAsset>();
  for (const asset of assets) {
    uniqueAssets.set(assetKey(asset), asset);
  }

  // One account load serves every requested asset — the per-asset work
  // below is synchronous lookups against that shared result, so it still
  // resolves them all concurrently (via Promise.all) without issuing a
  // Horizon request per asset.
  const accountResult = await loadRawAccount(horizonUrl, publicKey);

  const output: BulkTrustlinesResult = {};

  await Promise.all(
    Array.from(uniqueAssets.entries()).map(async ([key, asset]) => {
      const assetValidation = validateTokenAsset(asset);
      if (assetValidation.status === "error") {
        output[key] = assetValidation;
        return;
      }

      if (asset.issuer === null) {
        output[key] = ok(trustlineStateFromBalances(asset, []));
        return;
      }

      if (accountResult.status === "error") {
        output[key] = accountResult;
        return;
      }

      output[key] = ok(
        trustlineStateFromBalances(asset, accountResult.data.balances),
      );
    }),
  );

  return output;
}

/** A single trustline operation to include in a bulk transaction. */
export interface BulkTrustlineOperation {
  asset: TokenAsset;
  /** Trust limit; omit for the maximum allowed limit. Pass `"0"` to remove an existing trustline. */
  limit?: string;
}

/**
 * Parameters for building a bulk trustline transaction.
 */
export interface BuildBulkTrustlineTransactionParams {
  sourcePublicKey: string;
  operations: BulkTrustlineOperation[];
  /** Pre-fetched sequence number; when provided, no Horizon call is made. */
  sequenceNumber?: string;
  /** Fee in stroops; defaults to BASE_FEE. */
  estimatedFee?: string;
}

/**
 * Build a transaction containing multiple `changeTrust` operations —
 * establishing (or removing, via `limit: "0"`) trustlines for several
 * assets in a single transaction.
 *
 * Validates every asset and deduplicates operations for the same asset
 * (keeping the last one) before construction, and rejects the request
 * outright if it would exceed Stellar's 100-operations-per-transaction
 * limit rather than silently truncating the operation list.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Source account, the trustline operations to include, and
 *   optional offline sequence/fee overrides.
 * @returns `ok(transactionXdr)` — an unsigned transaction ready for signing
 *   — or an error if inputs are invalid or the operation limit is exceeded.
 *
 * @example
 * const result = await buildBulkTrustlineTransaction(horizonUrl, networkConfig, {
 *   sourcePublicKey: publicKey,
 *   operations: [
 *     { asset: { code: "USDC", issuer: usdcIssuer } },
 *     { asset: { code: "EURC", issuer: eurcIssuer } },
 *   ],
 * });
 */
export async function buildBulkTrustlineTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: BuildBulkTrustlineTransactionParams,
): Promise<SorokitResult<string>> {
  const { sourcePublicKey, operations, sequenceNumber, estimatedFee } = params;

  if (!operations || operations.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "buildBulkTrustlineTransaction: at least one trustline operation is required.",
    );
  }

  // Deduplicate by asset, keeping the last entry for a given asset so a
  // caller can safely pass an operation list built by merging multiple
  // sources without accidentally emitting two changeTrust ops for the same
  // asset (which Stellar would apply in sequence, wastefully).
  const deduped = new Map<string, BulkTrustlineOperation>();
  for (const operation of operations) {
    const validation = validateTokenAsset(operation.asset);
    if (validation.status === "error") return validation;
    if (operation.asset.issuer === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "buildBulkTrustlineTransaction: native XLM does not use trustlines and cannot be included.",
      );
    }
    deduped.set(assetKey(operation.asset), operation);
  }

  const dedupedOperations = Array.from(deduped.values());

  if (dedupedOperations.length > MAX_OPERATIONS_PER_TRANSACTION) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildBulkTrustlineTransaction: ${dedupedOperations.length} trustline operations exceed the maximum of ${MAX_OPERATIONS_PER_TRANSACTION} operations per transaction.`,
    );
  }

  let sourceAccount;
  if (sequenceNumber !== undefined) {
    const { Account } = await import("@stellar/stellar-sdk");
    sourceAccount = new Account(sourcePublicKey, sequenceNumber);
  } else {
    try {
      const server = createHorizonServer(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    } catch (cause) {
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `buildBulkTrustlineTransaction: failed to load account ${sourcePublicKey}: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee: estimatedFee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const operation of dedupedOperations) {
      builder.addOperation(
        Operation.changeTrust({
          asset: toStellarAsset(operation.asset),
          ...(operation.limit !== undefined && { limit: operation.limit }),
        }),
      );
    }

    const tx = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildBulkTrustlineTransaction: failed to build transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}
