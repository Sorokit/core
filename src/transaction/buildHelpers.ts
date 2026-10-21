/**
 * Shared helpers for transaction builders.
 *
 * Used by the claimable balance, bump sequence, and fluent compose builders so
 * they stay consistent with `buildTransaction.ts` while avoiding duplicated
 * account-resolution, memo, asset, and fee logic.
 */

import { Account, Asset, Memo, BASE_FEE } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode, sourceAccountNotFoundError } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage, isNotFoundError } from "../shared";
import { createHorizonServer } from "../shared/serverFactory";
import { validateMemoPolicy } from "./buildTransaction";
import type { MemoParams } from "./types";

const SEQUENCE_CACHE_TTL_MS = 5_000;
const _sequenceCache = new Map<
  string,
  { sequence: string; cachedAt: number }
>();

/**
 * Resolve the source account for transaction building.
 *
 * - If `sequenceNumber` is provided, creates a local `Account` instance
 *   (offline mode — no network calls).
 * - Otherwise, fetches from Horizon (with an optional 5-second module-level
 *   sequence cache when `autoFetchSequence` is true).
 *
 * @returns `ok(Account)` or `error(TX_BUILD_FAILED)`.
 */
export async function resolveSourceAccount(
  horizonUrl: string,
  sourcePublicKey: string,
  sequenceNumber?: string,
  autoFetchSequence?: boolean,
): Promise<SorokitResult<Account>> {
  if (sequenceNumber !== undefined) {
    return ok(new Account(sourcePublicKey, sequenceNumber));
  }

  try {
    if (autoFetchSequence === true) {
      const cached = _sequenceCache.get(sourcePublicKey);
      if (cached && Date.now() - cached.cachedAt <= SEQUENCE_CACHE_TTL_MS) {
        return ok(new Account(sourcePublicKey, cached.sequence));
      }
      _sequenceCache.delete(sourcePublicKey);
    }
    const server = createHorizonServer(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);
    return ok(sourceAccount);
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return sourceAccountNotFoundError(sourcePublicKey, {
        cause,
        operation: "resolveSourceAccount",
      });
    }
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to load source account: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Record the post-build sequence in the module-level cache for the source
 * account. Only meaningful when `autoFetchSequence` is enabled.
 */
export function updateSequenceCache(
  sourcePublicKey: string,
  sequenceNumber: string,
): void {
  const existing = _sequenceCache.get(sourcePublicKey);
  _sequenceCache.set(sourcePublicKey, {
    sequence: sequenceNumber,
    cachedAt: existing?.cachedAt ?? Date.now(),
  });
}

/** Clear the module-level sequence cache. Useful for test isolation. */
export function clearBuildSequenceCache(): void {
  _sequenceCache.clear();
}

/**
 * Resolve the fee for a transaction: the provided `estimatedFee` or `BASE_FEE`.
 */
export function resolveFee(estimatedFee?: string): string {
  return estimatedFee ?? BASE_FEE;
}

/**
 * Resolve an `Asset` from either an `Asset` instance or `assetCode`/`assetIssuer`
 * strings. Missing issuer for a non-native code returns an error; "XLM" resolves
 * to the native asset.
 *
 * When an `Asset` instance is provided it is never forwarded to the SDK
 * directly: its code and issuer are extracted and a fresh `Asset` is built.
 * This keeps the result consistent with the bundled SDK class even when the
 * caller constructs their asset from a separate copy of `@stellar/stellar-sdk`.
 */
export function resolveAssetInput(
  asset?: Asset,
  assetCode?: string,
  assetIssuer?: string,
): SorokitResult<Asset> {
  if (asset instanceof Asset) {
    return resolveAssetInput(undefined, asset.getCode(), asset.getIssuer());
  }
  if (
    asset !== undefined &&
    asset !== null &&
    typeof (asset as { getCode?: () => string }).getCode === "function"
  ) {
    const external = asset as unknown as {
      getCode: () => string;
      getIssuer: () => string;
    };
    return resolveAssetInput(
      undefined,
      external.getCode(),
      external.getIssuer(),
    );
  }
  if (!assetCode || assetCode.toUpperCase() === "XLM") {
    return ok(Asset.native());
  }
  if (!assetIssuer) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Asset issuer is required for non-native asset: ${assetCode}`,
    );
  }
  return ok(new Asset(assetCode, assetIssuer));
}

/**
 * Validate memo policy and serialize the memo value (text/id/hash/return) into
 * a stellar-sdk `Memo`. Returns `undefined` when no memo is set.
 */
export function resolveMemo(
  params: MemoParams,
): SorokitResult<Memo | undefined> {
  const policyResult = validateMemoPolicy(params);
  if (policyResult.status === "error") return policyResult;

  if (!params.memo) {
    return ok(undefined);
  }

  const memoType = params.memoType ?? "text";

  try {
    switch (memoType) {
      case "text":
        return ok(Memo.text(params.memo));
      case "id":
        return ok(Memo.id(params.memo));
      case "hash":
        return ok(Memo.hash(params.memo));
      case "return":
        return ok(Memo["return"](params.memo));
      default:
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Unsupported memo type: ${memoType}. Supported memo types are text, id, hash, return.`,
        );
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid memo for type ${memoType}: ${toMessage(cause)}`,
      cause,
    );
  }
}