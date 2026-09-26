/**
 * Fluent multi-operation transaction builder (#542).
 *
 * `compose()` returns a chainable builder that automatically manages the source
 * account sequence, fee estimation, and operation validation. Each `.addX()`
 * method validates the supplied parameters and defers serialisation until
 * `.build()`, which returns an unsigned transaction XDR ready for signing.
 *
 * @example
 * const tx = await compose(publicKey, networkConfig)
 *   .addPayment({ destination: "GD...", amount: "10" })
 *   .addTrustline({ asset: { assetCode: "EURC", assetIssuer: "GB..." } })
 *   .addManageOffer({ selling: nativeAsset(), buying: eurcAsset(), amount: "50", price: "1.5" })
 *   .estimateFee({ mode: "high" })
 *   .build();
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import { resolveNetwork } from "../network/resolveNetwork";
import type { NetworkType } from "../network/config";
import {
  resolveSourceAccount,
  updateSequenceCache,
  resolveFee,
  resolveMemo,
  resolveAssetInput,
} from "./buildHelpers";
import {
  buildBumpSequenceOperation,
  validateBumpSequenceValue,
} from "./bumpSequence";
import {
  buildClaimClaimableBalanceOperation,
  buildCreateClaimableBalanceOperation,
  validateClaimableBalanceId,
} from "./claimableBalance";
import { estimateFee } from "./estimateFee";
import type { FeeEstimate } from "./estimateFee";
import type { MemoType, SetOptionsParams } from "./types";
import type { ClaimPredicateInput } from "./types";

export type ComposeNetwork = ResolvedNetworkConfig | NetworkType;

/** Asset provided either as an `Asset` instance or `assetCode`/`assetIssuer`. */
export type ComposeAssetInput =
  | Asset
  | { assetCode?: string; assetIssuer?: string };

/** Fee selection modes for `.estimateFee()`. */
export type FeeEstimateMode =
  | "base"
  | "economy"
  | "low"
  | "standard"
  | "medium"
  | "fast"
  | "high";

export interface ComposeOptions {
  /**
   * Pre-fetched sequence number for the source account. When provided, no
   * Horizon `loadAccount` call is made — the transaction is built offline.
   */
  sequenceNumber?: string;
  /** Pre-fetched fee in stroops. When provided, replaces BASE_FEE and skips fee estimation. */
  estimatedFee?: string;
  /** When true, reuses a 5-second module-level sequence cache. */
  autoFetchSequence?: boolean;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeout?: number;
  /** Optional transaction memo attached to the built transaction. */
  memo?: string;
  memoType?: MemoType;
  /** Override the Horizon URL for a network-type `network`. */
  horizonUrl?: string;
  /** Override the RPC URL for a network-type `network`. */
  rpcUrl?: string;
}

export interface ComposePaymentParams {
  destination: string;
  amount: string;
  asset?: ComposeAssetInput;
}

export interface ComposeTrustlineParams {
  asset: ComposeAssetInput;
  limit?: string;
}

export interface ComposeCreateAccountParams {
  destination: string;
  startingBalance: string;
}

export interface ComposeOfferParams {
  selling: ComposeAssetInput;
  buying: ComposeAssetInput;
  /** Total amount to sell. If 0, deletes the offer. */
  amount: string;
  /**
   * Price of 1 unit of `selling` in terms of `buying`: a decimal string
   * (e.g. `"1.5"`) or a rational `{ n, d }`.
   */
  price: string | { n: number; d: number };
}

export interface ComposePathPaymentBase {
  destination: string;
  sendAsset: ComposeAssetInput;
  destAsset: ComposeAssetInput;
  path?: ComposeAssetInput[];
}

export type ComposePathPaymentParams =
  | (ComposePathPaymentBase & {
      mode: "strict-send";
      sendAmount: string;
      destMin: string;
    })
  | (ComposePathPaymentBase & {
      mode: "strict-receive";
      sendMax: string;
      destAmount: string;
    });

export interface ComposeClaimableBalanceParams {
  asset?: ComposeAssetInput;
  amount: string;
  claimant: string;
  predicate: ClaimPredicateInput;
}

export interface PendingComposeOperation {
  /** Human-readable kind for diagnostics (e.g. "payment", "manageOffer"). */
  kind: string;
  /** Serialise this operation to XDR. Errors are surfaced as `SorokitResult`. */
  build: () => SorokitResult<xdr.Operation>;
}

export interface ComposeBuilder {
  addPayment(params: ComposePaymentParams): ComposeBuilder;
  addTrustline(params: ComposeTrustlineParams): ComposeBuilder;
  addCreateAccount(params: ComposeCreateAccountParams): ComposeBuilder;
  addAccountMerge(destination: string): ComposeBuilder;
  addManageOffer(params: ComposeOfferParams): ComposeBuilder;
  addManageBuyOffer(params: ComposeOfferParams): ComposeBuilder;
  addPathPayment(params: ComposePathPaymentParams): ComposeBuilder;
  addClaimableBalance(params: ComposeClaimableBalanceParams): ComposeBuilder;
  addClaimClaimableBalance(balanceId: string): ComposeBuilder;
  addBumpSequence(bumpToSequence: string): ComposeBuilder;
  addSetOptions(params: SetOptionsParams): ComposeBuilder;
  addMemo(memo: string, memoType?: MemoType): ComposeBuilder;
  /** Enable automatic fee estimation; `{ mode: "high" }` prefers the fast tier. */
  estimateFee(mode: FeeEstimateMode): ComposeBuilder;
  setSequenceNumber(sequenceNumber: string): ComposeBuilder;
  setTimeout(seconds: number): ComposeBuilder;
  /** Number of pending operations in this builder. */
  count(): number;
  /** Remove all pending operations and reset memo / sequence state. */
  clear(): ComposeBuilder;
  /**
   * Validate every pending operation, resolve the source account sequence and
   * optional fee estimate, then serialise the transaction.
   */
  build(): Promise<SorokitResult<string>>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAssetLike(value: unknown): value is { getCode: () => string; getIssuer: () => string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getCode?: () => string }).getCode === "function"
  );
}

function resolveComposeAsset(input?: ComposeAssetInput): SorokitResult<Asset> {
  if (input === undefined) return ok(Asset.native());
  if (isAssetLike(input)) {
    return resolveAssetInput(undefined, input.getCode(), input.getIssuer());
  }
  return resolveAssetInput(undefined, input.assetCode, input.assetIssuer);
}

function resolvePathAssets(
  path: ComposeAssetInput[] | undefined,
): SorokitResult<Asset[]> {
  const assets: Asset[] = [];
  for (const hop of path ?? []) {
    const result = resolveComposeAsset(hop);
    if (result.status === "error") return result;
    assets.push(result.data);
  }
  return ok(assets);
}

/**
 * Lift a non-operation `SorokitResult` into the operation-result type. Only the
 * error branch is ever returned through this path (resolution already failed),
 * so the data payload is `null` and the cast is a pure type-level adjustment.
 */
function asOperationError<T>(result: SorokitResult<T>): SorokitResult<xdr.Operation> {
  return result as unknown as SorokitResult<xdr.Operation>;
}

/** Validate a manage-offer price: decimal string or rational { n, d }. */
function validateOfferPrice(price: unknown): SorokitResult<string | { n: number; d: number }> {
  if (typeof price === "string") {
    if (!/^\d+(\.\d+)?$/.test(price)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid offer price "${price}": must be a decimal string or a rational { n, d }.`,
      );
    }
    return ok(price);
  }
  if (
    typeof price === "object" &&
    price !== null &&
    Number.isFinite((price as { n: number }).n) &&
    Number.isFinite((price as { d: number }).d)
  ) {
    return ok(price as { n: number; d: number });
  }
  return err(
    SorokitErrorCode.TX_BUILD_FAILED,
    "Invalid offer price: must be a decimal string or a rational { n, d }.",
  );
}

function selectEstimatedFee(
  mode: FeeEstimateMode,
  estimate?: FeeEstimate,
): string {
  if (mode === "base") return BASE_FEE;
  const tier =
    mode === "economy" || mode === "low"
      ? "economy"
      : mode === "standard" || mode === "medium"
        ? "standard"
        : "fast";
  return estimate?.tiers?.[tier] ?? estimate?.fee ?? BASE_FEE;
}

// ─── compose() ────────────────────────────────────────────────────────────────

/**
 * Start a fluent multi-operation transaction builder.
 *
 * @param sourcePublicKey - G-address of the transaction source account.
 * @param network         - Resolved network config or a network type string.
 * @param options         - Optional sequence/fee/timeout/memo configuration.
 * @returns A chainable `ComposeBuilder`.
 *
 * @example
 * const tx = await compose(publicKey, "testnet")
 *   .addPayment({ destination: "GD...", amount: "10" })
 *   .addTrustline({ asset: eurcAsset() })
 *   .addBumpSequence("1000")
 *   .build();
 */
export function compose(
  sourcePublicKey: string,
  network: ComposeNetwork,
  options: ComposeOptions = {},
): ComposeBuilder {
  let networkConfig: ResolvedNetworkConfig | null = null;
  let networkError: SorokitResult<string> | null = null;

  if (typeof network === "string") {
    const resolved = resolveNetwork(network, {
      horizonUrl: options.horizonUrl,
      rpcUrl: options.rpcUrl,
    });
    if (resolved.status === "error") {
      networkError = resolved;
    } else if (resolved.status === "ok") {
      networkConfig = resolved.data;
    }
  } else {
    networkConfig = {
      ...network,
      ...(options.horizonUrl !== undefined && {
        horizonUrl: options.horizonUrl,
      }),
      ...(options.rpcUrl !== undefined && { rpcUrl: options.rpcUrl }),
    };
  }

  const pendingOps: PendingComposeOperation[] = [];
  let feeMode: FeeEstimateMode | null = null;
  let feeOverride = options.estimatedFee;
  let sequenceOverride = options.sequenceNumber;
  let timeoutSeconds = options.timeout ?? DEFAULT_TX_TIMEOUT_SECONDS;
  let memoState: { memo: string; memoType?: MemoType } | undefined;

  const push = (op: PendingComposeOperation): void => {
    pendingOps.push(op);
  };

  const builder: ComposeBuilder = {
    addPayment(params) {
      const assetResult = resolveComposeAsset(params.asset);
      if (assetResult.status === "error") {
        push({ kind: "payment", build: () => assetResult });
        return builder;
      }
      push({
        kind: "payment",
        build: () => {
          try {
            return ok(
              Operation.payment({
                destination: params.destination,
                asset: assetResult.data,
                amount: params.amount,
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build payment operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addTrustline(params) {
      const assetResult = resolveComposeAsset(params.asset);
      if (assetResult.status === "error") {
        push({ kind: "trustline", build: () => assetResult });
        return builder;
      }
      push({
        kind: "trustline",
        build: () => {
          try {
            return ok(
              Operation.changeTrust({
                asset: assetResult.data,
                ...(params.limit !== undefined && { limit: params.limit }),
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build trustline operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addCreateAccount(params) {
      push({
        kind: "createAccount",
        build: () => {
          try {
            return ok(
              Operation.createAccount({
                destination: params.destination,
                startingBalance: params.startingBalance,
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build create account operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addAccountMerge(destination) {
      push({
        kind: "accountMerge",
        build: () => {
          try {
            return ok(Operation.accountMerge({ destination }));
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build account merge operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addManageOffer(params) {
      const sellingResult = resolveComposeAsset(params.selling);
      const buyingResult = resolveComposeAsset(params.buying);
      const priceResult = validateOfferPrice(params.price);
      if (
        sellingResult.status === "error" ||
        buyingResult.status === "error" ||
        priceResult.status === "error"
      ) {
        const failure =
          sellingResult.status === "error"
            ? sellingResult
            : buyingResult.status === "error"
              ? buyingResult
              : priceResult;
        push({
          kind: "manageOffer",
          build: () => asOperationError(failure),
        });
        return builder;
      }
      push({
        kind: "manageOffer",
        build: () => {
          try {
            return ok(
              Operation.manageSellOffer({
                selling: sellingResult.data,
                buying: buyingResult.data,
                amount: params.amount,
                price: priceResult.data,
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build manage offer operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addManageBuyOffer(params) {
      const sellingResult = resolveComposeAsset(params.selling);
      const buyingResult = resolveComposeAsset(params.buying);
      const priceResult = validateOfferPrice(params.price);
      if (
        sellingResult.status === "error" ||
        buyingResult.status === "error" ||
        priceResult.status === "error"
      ) {
        const failure =
          sellingResult.status === "error"
            ? sellingResult
            : buyingResult.status === "error"
              ? buyingResult
              : priceResult;
        push({
          kind: "manageBuyOffer",
          build: () => asOperationError(failure),
        });
        return builder;
      }
      push({
        kind: "manageBuyOffer",
        build: () => {
          try {
            return ok(
              Operation.manageBuyOffer({
                selling: sellingResult.data,
                buying: buyingResult.data,
                buyAmount: params.amount,
                price: priceResult.data,
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build manage buy offer operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addPathPayment(params) {
      const sendResult = resolveComposeAsset(params.sendAsset);
      const destResult = resolveComposeAsset(params.destAsset);
      const pathResult = resolvePathAssets(params.path);
      if (
        sendResult.status === "error" ||
        destResult.status === "error" ||
        pathResult.status === "error"
      ) {
        const failure =
          sendResult.status === "error"
            ? sendResult
            : destResult.status === "error"
              ? destResult
              : pathResult;
        push({
          kind: "pathPayment",
          build: () => asOperationError(failure),
        });
        return builder;
      }
      push({
        kind: "pathPayment",
        build: () => {
          try {
            if (params.mode === "strict-send") {
              return ok(
                Operation.pathPaymentStrictSend({
                  sendAsset: sendResult.data,
                  sendAmount: params.sendAmount,
                  destination: params.destination,
                  destAsset: destResult.data,
                  destMin: params.destMin,
                  path: pathResult.data,
                }),
              );
            }
            return ok(
              Operation.pathPaymentStrictReceive({
                sendAsset: sendResult.data,
                sendMax: params.sendMax,
                destination: params.destination,
                destAsset: destResult.data,
                destAmount: params.destAmount,
                path: pathResult.data,
              }),
            );
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Failed to build path payment operation: ${toMessage(cause)}`,
              cause,
            );
          }
        },
      });
      return builder;
    },

    addClaimableBalance(params) {
      const assetResult = resolveComposeAsset(params.asset);
      if (assetResult.status === "error") {
        push({ kind: "claimableBalance", build: () => assetResult });
        return builder;
      }
      push({
        kind: "claimableBalance",
        build: () =>
          buildCreateClaimableBalanceOperation({
            amount: params.amount,
            claimant: params.claimant,
            predicate: params.predicate,
            ...(params.asset !== undefined ? { asset: assetResult.data } : {}),
          }),
      });
      return builder;
    },

    addClaimClaimableBalance(balanceId) {
      const validation = validateClaimableBalanceId(balanceId);
      if (validation.status === "error") {
        push({ kind: "claimClaimableBalance", build: () => validation });
        return builder;
      }
      push({
        kind: "claimClaimableBalance",
        build: () => buildClaimClaimableBalanceOperation(balanceId),
      });
      return builder;
    },

    addBumpSequence(bumpToSequence) {
      const validation = validateBumpSequenceValue(bumpToSequence);
      if (validation.status === "error") {
        push({ kind: "bumpSequence", build: () => validation });
        return builder;
      }
      push({
        kind: "bumpSequence",
        build: () => buildBumpSequenceOperation(bumpToSequence),
      });
      return builder;
    },

    addSetOptions(params) {
      const setOptions = {
        ...(params.masterWeight !== undefined && { masterWeight: params.masterWeight }),
        ...(params.lowThreshold !== undefined && { lowThreshold: params.lowThreshold }),
        ...(params.medThreshold !== undefined && { medThreshold: params.medThreshold }),
        ...(params.highThreshold !== undefined && { highThreshold: params.highThreshold }),
        ...(params.homeDomain !== undefined && { homeDomain: params.homeDomain ?? "" }),
        ...(params.inflationDest != null && { inflationDest: params.inflationDest }),
        ...(params.clearFlags !== undefined && { clearFlags: params.clearFlags as NonNullable<Parameters<typeof Operation.setOptions>[0]["clearFlags"]> }),
      };
      push({
        kind: "setOptions",
        build: () => {
          try {
            return ok(Operation.setOptions(setOptions));
          } catch (cause) {
            return err(SorokitErrorCode.TX_BUILD_FAILED, `Failed to build set options operation: ${toMessage(cause)}`, cause);
          }
        },
      });
      for (const signer of params.signers ?? []) {
        push({
          kind: "setOptionsSigner",
          build: () => ok(Operation.setOptions({ signer: { ed25519PublicKey: signer.publicKey, weight: signer.weight } })),
        });
      }
      return builder;
    },

    addMemo(memo, memoType) {
      memoState = { memo, ...(memoType !== undefined && { memoType }) };
      return builder;
    },

    estimateFee(mode) {
      feeMode = mode;
      return builder;
    },

    setSequenceNumber(sequenceNumber) {
      sequenceOverride = sequenceNumber;
      return builder;
    },

    setTimeout(seconds) {
      timeoutSeconds = seconds;
      return builder;
    },

    count() {
      return pendingOps.length;
    },

    clear() {
      pendingOps.length = 0;
      feeMode = null;
      feeOverride = options.estimatedFee;
      sequenceOverride = options.sequenceNumber;
      timeoutSeconds = options.timeout ?? DEFAULT_TX_TIMEOUT_SECONDS;
      memoState = undefined;
      return builder;
    },

    async build() {
      if (networkError) {
        return networkError;
      }
      if (!networkConfig) {
        return err(
          SorokitErrorCode.INVALID_NETWORK,
          "Failed to resolve network configuration for compose().",
        );
      }

      // 1. Resolve source account (offline when sequenceNumber is provided).
      const sourceResult = await resolveSourceAccount(
        networkConfig.horizonUrl,
        sourcePublicKey,
        sequenceOverride,
        options.autoFetchSequence,
      );
      if (sourceResult.status === "error") return sourceResult;
      const sourceAccount = sourceResult.data;

      // 2. Resolve memo once.
      const { memo, memoType } = memoState ?? options;
      const memoParams =
        memo !== undefined
          ? { memo, ...(memoType !== undefined && { memoType }) }
          : undefined;
      const memoResult = memoParams
        ? resolveMemo(memoParams)
        : ok(undefined);
      if (memoResult.status === "error") return memoResult;

      // 3. Validate and serialise every pending operation, bailing on the first error.
      const operations: xdr.Operation[] = [];
      for (const pending of pendingOps) {
        const opResult = pending.build();
        if (opResult.status === "error") return opResult;
        operations.push(opResult.data);
      }
      if (operations.length === 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Cannot build a transaction with zero operations.",
        );
      }

      // 4. Resolve the fee: explicit override, fee estimation, or BASE_FEE.
      let fee = resolveFee(feeOverride);
      if (feeMode !== null && feeOverride === undefined) {
        const preliminary = await buildPreliminary(
          sourceAccount,
          networkConfig.networkPassphrase,
          operations,
          memoResult.data,
          timeoutSeconds,
        );
        if (preliminary.status === "error") return preliminary;
        const estimateResult = await estimateFee(
          networkConfig.rpcUrl,
          networkConfig.horizonUrl,
          networkConfig,
          { kind: "xdr", transactionXdr: preliminary.data },
          undefined,
          undefined,
          { includeTiers: feeMode !== "base" },
        );
        if (estimateResult.status === "ok") {
          fee = selectEstimatedFee(feeMode, estimateResult.data);
        }
      }

      // 5. Build the final transaction XDR.
      try {
        const transactionBuilder = new TransactionBuilder(sourceAccount, {
          fee,
          networkPassphrase: networkConfig.networkPassphrase,
        });
        for (const operation of operations) {
          transactionBuilder.addOperation(operation);
        }
        if (memoResult.data) {
          transactionBuilder.addMemo(memoResult.data);
        }
        const tx = transactionBuilder.setTimeout(timeoutSeconds).build();

        if (
          options.autoFetchSequence === true &&
          sequenceOverride === undefined
        ) {
          updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
        }

        return ok(tx.toXDR());
      } catch (cause) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Failed to build multi-operation transaction: ${toMessage(cause)}`,
          cause,
        );
      }
    },
  };

  return builder;
}

/** Build a preliminary transaction XDR used only for fee estimation. */
async function buildPreliminary(
  sourceAccount: Account,
  networkPassphrase: string,
  operations: xdr.Operation[],
  memo: Memo | undefined,
  timeoutSeconds: number,
): Promise<SorokitResult<string>> {
  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    });
    for (const operation of operations) {
      builder.addOperation(operation);
    }
    if (memo) {
      builder.addMemo(memo);
    }
    const tx = builder.setTimeout(timeoutSeconds).build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build preliminary transaction for fee estimation: ${toMessage(cause)}`,
      cause,
    );
  }
}
