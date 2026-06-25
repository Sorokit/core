import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

import { validateIssuer } from "../shared/validateIssuer";
import { isNetworkConnectivityError, isTimeoutError, toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type {
  MemoParams,
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  PaymentWithTrustlineParams,
  SwapTransactionParams,
} from "./types";

// ─── Sequence cache (shared across builders for autoFetchSequence) ────────────

const SEQUENCE_CACHE_TTL_MS = 5_000;
const _sequenceCache = new Map<string, { sequence: string; cachedAt: number }>();

function getSequenceCacheEntry(publicKey: string): Account | null {
  const entry = _sequenceCache.get(publicKey);
  if (!entry || Date.now() - entry.cachedAt > SEQUENCE_CACHE_TTL_MS) {
    _sequenceCache.delete(publicKey);
    return null;
  }
  return new Account(publicKey, entry.sequence);
}

function updateSequenceCache(publicKey: string, postBuildSequence: string): void {
  const existing = _sequenceCache.get(publicKey);
  _sequenceCache.set(publicKey, {
    sequence: postBuildSequence,
    cachedAt: existing?.cachedAt ?? Date.now(),
  });
}

/** Clear the module-level sequence cache. Useful for test isolation. */
export function clearSequenceCache(): void {
  _sequenceCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────

function describeTransactionBuildFailure(action: string, cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Failed to build ${action} transaction because Horizon timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Failed to build ${action} transaction due to network connectivity: ${toMessage(cause)}`;
  }
  return `Failed to build ${action} transaction: ${toMessage(cause)}`;
}

/**
 * Resolve an asset from code + optional issuer.
 * Returns SorokitResult<Asset> — never throws.
 */
function resolveAsset(
  assetCode?: string,
  assetIssuer?: string,
): SorokitResult<Asset> {
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

function validateMemoParams(params: MemoParams): SorokitResult<Memo | undefined> {
  if (!params.memo) {
    if (params.requireMemo) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Memo is required for this transaction",
      );
    }
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

/**
 * Build a payment transaction XDR.
 * Returns the unsigned XDR string ready for signing.
 */
export async function buildPaymentTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PaymentParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  const assetResult = resolveAsset(params.assetCode, params.assetIssuer);
  if (assetResult.status === "error") return assetResult;

  // Validate issuer against whitelist if configured and not native
  if (
    params.assetCode &&
    params.assetCode.toUpperCase() !== "XLM" &&
    params.assetIssuer &&
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      validateIssuer(params.assetIssuer, trustedIssuers);
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount: Account | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: params.destination,
          asset: assetResult.data,
          amount: params.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("payment", cause),
      cause,
    );
  }
}

/**
 * Build a create account transaction XDR.
 */
export async function buildCreateAccountTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: AccountCreateParams,
): Promise<SorokitResult<string>> {
  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount: Account | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: params.destination,
          startingBalance: params.startingBalance,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("create account", cause),
      cause,
    );
  }
}

/**
 * Build a change trust (trustline) transaction XDR.
 */
export async function buildTrustlineTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: TrustlineParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  // Validate issuer against whitelist if configured
  if (
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      validateIssuer(params.assetIssuer, trustedIssuers);
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount: Account | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const asset = new Asset(params.assetCode, params.assetIssuer);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          ...(params.limit !== undefined && { limit: params.limit }),
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("trustline", cause),
      cause,
    );
  }
}

/**
 * Build a payment transaction with trustline setup.
 * Establishes trust for the asset before sending payment.
 */
export async function buildPaymentWithTrustline(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PaymentWithTrustlineParams,
): Promise<SorokitResult<string>> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const trustlineAssetResult = resolveAsset(
      params.trustline.assetCode,
      params.trustline.assetIssuer,
    );
    if (trustlineAssetResult.status === "error") return trustlineAssetResult;

    const paymentAssetResult = resolveAsset(
      params.payment.assetCode,
      params.payment.assetIssuer,
    );
    if (paymentAssetResult.status === "error") return paymentAssetResult;

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: trustlineAssetResult.data,
          ...(params.trustline.limit !== undefined && {
            limit: params.trustline.limit,
          }),
        }),
      )
      .addOperation(
        Operation.payment({
          destination: params.payment.destination,
          asset: paymentAssetResult.data,
          amount: params.payment.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (params.payment.memo) {
      builder.addMemo(Memo.text(params.payment.memo));
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("payment with trustline", cause),
      cause,
    );
  }
}

/**
 * Build a swap transaction with two payments.
 * Used for atomic swaps where two payments must succeed together.
 */
export async function buildSwapTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: SwapTransactionParams,
): Promise<SorokitResult<string>> {
  const assetAResult = resolveAsset(
    params.paymentA.assetCode,
    params.paymentA.assetIssuer,
  );
  if (assetAResult.status === "error") return assetAResult;

  const assetBResult = resolveAsset(
    params.paymentB.assetCode,
    params.paymentB.assetIssuer,
  );
  if (assetBResult.status === "error") return assetBResult;

  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: params.paymentA.destination,
          asset: assetAResult.data,
          amount: params.paymentA.amount,
        }),
      )
      .addOperation(
        Operation.payment({
          destination: params.paymentB.destination,
          asset: assetBResult.data,
          amount: params.paymentB.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (params.paymentA.memo) {
      builder.addMemo(Memo.text(params.paymentA.memo));
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("swap", cause),
      cause,
    );
  }
}
