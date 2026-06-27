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
  ReverseTransactionParams,
  PathPaymentParams,
  AtomicSwapParams,
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
 * Build an unsigned payment transaction XDR.
 *
 * Fetches the current sequence number from Horizon unless `autoFetchSequence`
 * is `true` and a cached sequence is available (TTL: 5 s). Validates the asset
 * issuer against `trustedIssuers` when provided.
 *
 * @param horizonUrl     - Base URL of the Horizon server.
 * @param networkConfig  - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the transaction source account.
 * @param params          - Payment parameters: destination, amount, asset, memo.
 * @param trustedIssuers  - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any build error.
 *
 * @example
 * const result = await buildPaymentTransaction(horizonUrl, networkConfig, sourceKey, {
 *   destination: "GDEST...",
 *   amount: "10",
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZS...",
 * });
 * if (result.status === "ok") {
 *   const signed = await signTransaction(adapter, { transactionXdr: result.data, networkPassphrase });
 * }
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
 * Build an unsigned create-account transaction XDR.
 *
 * Creates the target account on the Stellar network and funds it with
 * `startingBalance` XLM. The source account must hold sufficient XLM to
 * cover both the starting balance and transaction fee.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration.
 * @param sourcePublicKey - G-address of the funding account.
 * @param params          - Destination address, starting balance in XLM, and optional memo.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildCreateAccountTransaction(horizonUrl, networkConfig, sourceKey, {
 *   destination: "GDEST...",
 *   startingBalance: "1",
 * });
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
 * Build an unsigned change-trust (trustline) transaction XDR.
 *
 * Adds or removes a trustline for a non-native asset. Setting `limit` to `"0"`
 * removes the trustline. Validates the issuer against `trustedIssuers` when provided.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account establishing the trustline.
 * @param params          - Asset code, issuer, optional limit, and optional memo.
 * @param trustedIssuers  - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildTrustlineTransaction(horizonUrl, networkConfig, sourceKey, {
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZS...",
 * });
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

/**
 * Build a reverse transaction XDR for the given original transaction XDR.
 * Supports reversing: payments, trustlines (removes the trust), and account creations (merges the account).
 * Returns the unsigned reverse XDR ready for signing.
 */
export async function buildReverseTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  originalXdr: string,
  params?: ReverseTransactionParams,
): Promise<SorokitResult<string>> {
  try {
    const originalTx = TransactionBuilder.fromXDR(
      originalXdr,
      networkConfig.networkPassphrase,
    );

    const operations = originalTx.operations;
    if (operations.length === 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Original transaction has no operations to reverse",
      );
    }

    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: params?.fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const op of operations) {
      switch (op.type) {
        case "payment": {
          const payOp = op as Operation.Payment;
          builder.addOperation(
            Operation.payment({
              destination: payOp.source ?? sourcePublicKey,
              asset: payOp.asset,
              amount: payOp.amount,
              source: payOp.destination,
            }),
          );
          break;
        }
        case "changeTrust": {
          const trustOp = op as Operation.ChangeTrust;
          builder.addOperation(
            Operation.changeTrust({
              asset: trustOp.line as Asset,
              limit: "0",
            }),
          );
          break;
        }
        case "createAccount": {
          const createOp = op as Operation.CreateAccount;
          builder.addOperation(
            Operation.accountMerge({
              destination: createOp.source ?? sourcePublicKey,
              source: createOp.destination,
            }),
          );
          break;
        }
        default:
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Cannot reverse operation type: ${op.type}`,
          );
      }
    }

    const tx = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("reverse", cause),
      cause,
    );
  }
}

function resolvePathAssets(
  path?: PathPaymentParams["path"],
): SorokitResult<Asset[]> {
  const assets: Asset[] = [];
  for (const hop of path ?? []) {
    const result = resolveAsset(hop.assetCode, hop.assetIssuer);
    if (result.status === "error") return result;
    assets.push(result.data);
  }
  return ok(assets);
}

/**
 * Build a path payment transaction XDR.
 * Use mode "strict-send" to send an exact amount, or "strict-receive" to receive an exact amount.
 * Returns the unsigned XDR ready for signing.
 */
export async function buildPathPayment(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PathPaymentParams,
): Promise<SorokitResult<string>> {
  const sendAssetResult = resolveAsset(params.sendAssetCode, params.sendAssetIssuer);
  if (sendAssetResult.status === "error") return sendAssetResult;

  const destAssetResult = resolveAsset(params.destAssetCode, params.destAssetIssuer);
  if (destAssetResult.status === "error") return destAssetResult;

  const pathResult = resolvePathAssets(params.path);
  if (pathResult.status === "error") return pathResult;

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
    });

    if (params.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetResult.data,
          sendAmount: params.amount,
          destination: params.destination,
          destAsset: destAssetResult.data,
          destMin: params.slippageAmount,
          path: pathResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetResult.data,
          sendMax: params.slippageAmount,
          destination: params.destination,
          destAsset: destAssetResult.data,
          destAmount: params.amount,
          path: pathResult.data,
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

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
      describeTransactionBuildFailure("path payment", cause),
      cause,
    );
  }
}

/**
 * Build an atomic swap transaction XDR containing two path payment legs.
 * Both legs execute atomically — if either fails, neither applies.
 * Returns the unsigned XDR ready for signing.
 */
export async function buildAtomicSwap(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: AtomicSwapParams,
): Promise<SorokitResult<string>> {
  const sendAssetAResult = resolveAsset(params.legA.sendAssetCode, params.legA.sendAssetIssuer);
  if (sendAssetAResult.status === "error") return sendAssetAResult;

  const destAssetAResult = resolveAsset(params.legA.destAssetCode, params.legA.destAssetIssuer);
  if (destAssetAResult.status === "error") return destAssetAResult;

  const pathAResult = resolvePathAssets(params.legA.path);
  if (pathAResult.status === "error") return pathAResult;

  const sendAssetBResult = resolveAsset(params.legB.sendAssetCode, params.legB.sendAssetIssuer);
  if (sendAssetBResult.status === "error") return sendAssetBResult;

  const destAssetBResult = resolveAsset(params.legB.destAssetCode, params.legB.destAssetIssuer);
  if (destAssetBResult.status === "error") return destAssetBResult;

  const pathBResult = resolvePathAssets(params.legB.path);
  if (pathBResult.status === "error") return pathBResult;

  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    if (params.legA.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetAResult.data,
          sendAmount: params.legA.amount,
          destination: params.legA.destination,
          destAsset: destAssetAResult.data,
          destMin: params.legA.slippageAmount,
          path: pathAResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetAResult.data,
          sendMax: params.legA.slippageAmount,
          destination: params.legA.destination,
          destAsset: destAssetAResult.data,
          destAmount: params.legA.amount,
          path: pathAResult.data,
        }),
      );
    }

    if (params.legB.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetBResult.data,
          sendAmount: params.legB.amount,
          destination: params.legB.destination,
          destAsset: destAssetBResult.data,
          destMin: params.legB.slippageAmount,
          path: pathBResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetBResult.data,
          sendMax: params.legB.slippageAmount,
          destination: params.legB.destination,
          destAsset: destAssetBResult.data,
          destAmount: params.legB.amount,
          path: pathBResult.data,
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("atomic swap", cause),
      cause,
    );
  }
}
