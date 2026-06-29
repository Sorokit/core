import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  LiquidityPoolAsset,
  Memo,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { estimateFee } from "./estimateFee";
import type { FeeEstimate } from "./estimateFee";

import { validateIssuer } from "../shared/validateIssuer";
import { isNetworkConnectivityError, isTimeoutError, isXdrInvalidError, toMessage, isNotFoundError, retryWithBackoff } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import { getCachedSequence, cacheSequence, clearSequenceCache as clearSharedSequenceCache } from "../shared/sequenceCache";
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

// ─── Sequence cache helpers (using shared 30s cache) ───────────────────────────

function getSequenceCacheEntry(publicKey: string): Account | null {
  const sequence = getCachedSequence(publicKey);
  if (!sequence) {
    return null;
  }
  return new Account(publicKey, sequence);
}

function updateSequenceCache(publicKey: string, postBuildSequence: string): void {
  cacheSequence(publicKey, postBuildSequence);
}

/** Clear the shared sequence cache. Useful for test isolation. */
export function clearSequenceCache(): void {
  clearSharedSequenceCache();
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

  if (params.memoValidator) {
    const validationResult = params.memoValidator(params.memo);
    if (validationResult.status === "error") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        validationResult.error.message,
        validationResult.error.cause,
      );
    }
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
): Promise<SorokitResult<string | FeeEstimate>> {
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

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    const xdr = tx.toXDR();

    if (params.preview === true) {
      if (!params.rpcUrl) {
        return err(
          SorokitErrorCode.TX_SIMULATE_FAILED,
          "preview mode requires rpcUrl to be set in params",
        );
      }
      return estimateFee(params.rpcUrl, horizonUrl, networkConfig, {
        kind: "xdr",
        transactionXdr: xdr,
      });
    }

    return ok(xdr);
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
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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

    if (memoResult.data) {
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

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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

    if (memoResult.data) {
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
  if (isXdrInvalidError(originalXdr)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Cannot build reverse transaction: the provided XDR is malformed.",
      originalXdr,
    );
  }

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
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  const sendAssetResult = resolveAsset(params.sendAssetCode, params.sendAssetIssuer);
  if (sendAssetResult.status === "error") return sendAssetResult;

  const destAssetResult = resolveAsset(params.destAssetCode, params.destAssetIssuer);
  if (destAssetResult.status === "error") return destAssetResult;

  if (trustedIssuers !== null && trustedIssuers !== undefined && trustedIssuers.length > 0) {
    try {
      if (params.sendAssetCode && params.sendAssetCode.toUpperCase() !== "XLM" && params.sendAssetIssuer) {
        validateIssuer(params.sendAssetIssuer, trustedIssuers);
      }
      if (params.destAssetCode && params.destAssetCode.toUpperCase() !== "XLM" && params.destAssetIssuer) {
        validateIssuer(params.destAssetIssuer, trustedIssuers);
      }
      for (const hop of params.path ?? []) {
        if (hop.assetCode && hop.assetCode.toUpperCase() !== "XLM" && hop.assetIssuer) {
          validateIssuer(hop.assetIssuer, trustedIssuers);
        }
      }
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  try {
    const server = new Horizon.Server(horizonUrl);

    let finalPath = params.path;
    let finalSlippageAmount = params.slippageAmount;

    if (!finalPath || finalPath.length === 0 || !finalSlippageAmount) {
      if (params.mode === "strict-send") {
        const response = await server.strictSendPaths(sendAssetResult.data, params.amount, [destAssetResult.data]).call();
        if (response.records.length === 0) {
          return err(SorokitErrorCode.TX_BUILD_FAILED, "No path found for strict-send payment.");
        }
        const bestPath = response.records.reduce((prev, curr) => 
          Number(curr.destination_amount) > Number(prev.destination_amount) ? curr : prev
        );
        if (!finalPath || finalPath.length === 0) {
          finalPath = bestPath.path.map(a => ({ assetCode: a.asset_code, assetIssuer: a.asset_issuer }));
        }
        if (!finalSlippageAmount) {
          finalSlippageAmount = bestPath.destination_amount;
        }
      } else {
        const response = await server.strictReceivePaths([sendAssetResult.data], destAssetResult.data, params.amount).call();
        if (response.records.length === 0) {
          return err(SorokitErrorCode.TX_BUILD_FAILED, "No path found for strict-receive payment.");
        }
        const bestPath = response.records.reduce((prev, curr) => 
          Number(curr.source_amount) < Number(prev.source_amount) ? curr : prev
        );
        if (!finalPath || finalPath.length === 0) {
          finalPath = bestPath.path.map(a => ({ assetCode: a.asset_code, assetIssuer: a.asset_issuer }));
        }
        if (!finalSlippageAmount) {
          finalSlippageAmount = bestPath.source_amount;
        }
      }
    }

    const pathResult = resolvePathAssets(finalPath);
    if (pathResult.status === "error") return pathResult;

    const useCache = params.autoFetchSequence === true;
    let sourceAccount: Account | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
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
          destMin: finalSlippageAmount,
          path: pathResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetResult.data,
          sendMax: finalSlippageAmount,
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

    const slippageA = params.legA.slippageAmount;
    const slippageB = params.legB.slippageAmount;

    if (!slippageA || !slippageB) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "slippageAmount is required for both legs of an atomic swap.");
    }

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
            destMin: slippageA,
            path: pathAResult.data,
          }),
        );
      } else {
        builder.addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: sendAssetAResult.data,
            sendMax: slippageA,
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
            destMin: slippageB,
            path: pathBResult.data,
          }),
      );
      } else {
        builder.addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: sendAssetBResult.data,
            sendMax: slippageB,
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

export interface AccountMergeOptions {
  autoFetchSequence?: boolean;
  checkExists?: boolean;
  memo?: string;
  memoType?: "text" | "id" | "hash" | "return";
  requireMemo?: boolean;
  memoValidator?: (memo: string) => SorokitResult<void>;
}

/**
 * Build an unsigned account merge transaction XDR.
 *
 * Merges the source account into the destination account. The source account
 * will be deleted from the ledger, and all its remaining XLM will be transferred
 * to the destination account.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account to be merged (deleted).
 * @param destinationPublicKey - G-address of the account to receive the remaining XLM.
 * @param options - Optional parameters: memo, autoFetchSequence, checkExists.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error`.
 */
export async function buildAccountMerge(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  destinationPublicKey: string,
  options?: AccountMergeOptions,
): Promise<SorokitResult<string>> {
  if (options?.checkExists) {
    try {
      const server = new Horizon.Server(horizonUrl);
      await retryWithBackoff(() => server.loadAccount(destinationPublicKey));
    } catch (cause) {
      if (isNotFoundError(cause)) {
        return err(
          SorokitErrorCode.ACCOUNT_NOT_FOUND,
          `Destination account ${destinationPublicKey} does not exist.`,
          cause,
        );
      }
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Failed to verify destination account existence: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  const memoResult = options ? validateMemoParams(options) : ok(undefined);
  if (memoResult.status === "error") return memoResult;

  try {
    const useCache = options?.autoFetchSequence === true;
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
        Operation.accountMerge({
          destination: destinationPublicKey,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
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
      describeTransactionBuildFailure("account merge", cause),
      cause,
    );
  }
}

export interface CreateLiquidityPoolParams extends MemoParams {
  /** Asset A in the liquidity pool (first asset) */
  assetA: { assetCode?: string; assetIssuer?: string };
  /** Asset B in the liquidity pool (second asset) */
  assetB: { assetCode?: string; assetIssuer?: string };
  /** Fee basis points (e.g., 30 for 0.3% fee) */
  fee: number;
  autoFetchSequence?: boolean;
}

export interface DepositLiquidityPoolParams extends MemoParams {
  /** Liquidity pool ID */
  liquidityPoolId: string;
  /** Maximum amount of asset A to deposit */
  maxAmountA: string;
  /** Maximum amount of asset B to deposit */
  maxAmountB: string;
  /** Minimum price (depositA/depositB) */
  minPrice: string;
  /** Maximum price (depositA/depositB) */
  maxPrice: string;
  autoFetchSequence?: boolean;
}

export interface WithdrawLiquidityPoolParams extends MemoParams {
  /** Liquidity pool ID */
  liquidityPoolId: string;
  /** Amount of pool shares to withdraw */
  amount: string;
  /** Minimum amount of asset A to receive */
  minAmountA: string;
  /** Minimum amount of asset B to receive */
  minAmountB: string;
  autoFetchSequence?: boolean;
}

/**
 * Build an unsigned transaction to create a liquidity pool.
 *
 * Creates a trustline to a liquidity pool, enabling the account to deposit
 * assets and receive pool shares. The pool is identified by its asset pair
 * and fee rate.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account creating the pool trustline.
 * @param params - Pool parameters: assets, fee, optional memo.
 * @param trustedIssuers - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildCreateLiquidityPool(horizonUrl, networkConfig, sourceKey, {
 *   assetA: { assetCode: "USDC", assetIssuer: "GA5ZS..." },
 *   assetB: { assetCode: "XLM" },
 *   fee: 30,
 * });
 */
export async function buildCreateLiquidityPool(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: CreateLiquidityPoolParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  // Validate assets
  const assetAResult = resolveAsset(params.assetA.assetCode, params.assetA.assetIssuer);
  if (assetAResult.status === "error") return assetAResult;

  const assetBResult = resolveAsset(params.assetB.assetCode, params.assetB.assetIssuer);
  if (assetBResult.status === "error") return assetBResult;

  // Validate fee
  if (params.fee < 0 || params.fee > 10000 || !Number.isInteger(params.fee)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Liquidity pool fee must be an integer between 0 and 10000 basis points",
    );
  }

  // Validate issuers against whitelist if configured
  if (trustedIssuers !== null && trustedIssuers !== undefined && trustedIssuers.length > 0) {
    try {
      if (params.assetA.assetCode && params.assetA.assetCode.toUpperCase() !== "XLM" && params.assetA.assetIssuer) {
        validateIssuer(params.assetA.assetIssuer, trustedIssuers);
      }
      if (params.assetB.assetCode && params.assetB.assetCode.toUpperCase() !== "XLM" && params.assetB.assetIssuer) {
        validateIssuer(params.assetB.assetIssuer, trustedIssuers);
      }
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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

    // Create liquidity pool asset
    const liquidityPoolAsset = new LiquidityPoolAsset(
      assetAResult.data,
      assetBResult.data,
      params.fee,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: liquidityPoolAsset,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
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
      describeTransactionBuildFailure("create liquidity pool", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned transaction to deposit assets into a liquidity pool.
 *
 * Deposits assets into an existing liquidity pool in exchange for pool shares.
 * The actual amounts deposited depend on the current pool reserves. Use minPrice
 * and maxPrice to control slippage.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account depositing assets.
 * @param params - Deposit parameters: pool ID, amounts, price bounds, optional memo.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildDepositLiquidityPool(horizonUrl, networkConfig, sourceKey, {
 *   liquidityPoolId: "abc123...",
 *   maxAmountA: "100",
 *   maxAmountB: "200",
 *   minPrice: "0.45",
 *   maxPrice: "0.55",
 * });
 */
export async function buildDepositLiquidityPool(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: DepositLiquidityPoolParams,
): Promise<SorokitResult<string>> {
  // Validate amounts
  if (!params.maxAmountA || !params.maxAmountB) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Both maxAmountA and maxAmountB are required for liquidity pool deposit",
    );
  }

  if (parseFloat(params.maxAmountA) <= 0 || parseFloat(params.maxAmountB) <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Deposit amounts must be positive numbers",
    );
  }

  // Validate price bounds
  if (!params.minPrice || !params.maxPrice) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Both minPrice and maxPrice are required for liquidity pool deposit",
    );
  }

  if (parseFloat(params.minPrice) <= 0 || parseFloat(params.maxPrice) <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Price bounds must be positive numbers",
    );
  }

  if (parseFloat(params.minPrice) > parseFloat(params.maxPrice)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "minPrice must be less than or equal to maxPrice",
    );
  }

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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
        Operation.liquidityPoolDeposit({
          liquidityPoolId: params.liquidityPoolId,
          maxAmountA: params.maxAmountA,
          maxAmountB: params.maxAmountB,
          minPrice: params.minPrice,
          maxPrice: params.maxPrice,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
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
      describeTransactionBuildFailure("liquidity pool deposit", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned transaction to withdraw assets from a liquidity pool.
 *
 * Redeems pool shares to withdraw a proportional amount of the underlying assets.
 * Use minAmountA and minAmountB to protect against slippage.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account withdrawing assets.
 * @param params - Withdrawal parameters: pool ID, share amount, minimum amounts, optional memo.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildWithdrawLiquidityPool(horizonUrl, networkConfig, sourceKey, {
 *   liquidityPoolId: "abc123...",
 *   amount: "50",
 *   minAmountA: "90",
 *   minAmountB: "180",
 * });
 */
export async function buildWithdrawLiquidityPool(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: WithdrawLiquidityPoolParams,
): Promise<SorokitResult<string>> {
  // Validate amounts
  if (!params.amount) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Amount of pool shares to withdraw is required",
    );
  }

  if (parseFloat(params.amount) <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Withdrawal amount must be a positive number",
    );
  }

  if (!params.minAmountA || !params.minAmountB) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Both minAmountA and minAmountB are required for liquidity pool withdrawal",
    );
  }

  if (parseFloat(params.minAmountA) < 0 || parseFloat(params.minAmountB) < 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Minimum amounts must be non-negative numbers",
    );
  }

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

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
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: params.liquidityPoolId,
          amount: params.amount,
          minAmountA: params.minAmountA,
          minAmountB: params.minAmountB,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
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
      describeTransactionBuildFailure("liquidity pool withdrawal", cause),
      cause,
    );
  }
}

