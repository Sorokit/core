/**
 * Fluent transaction builders.
 *
 * Account configuration and DEX offer builders (#908, #905) validate inputs
 * as methods are called and defer account resolution and transaction assembly
 * until `build()`. Single-operation builders (#909, #910, #911) expose a short
 * chain of setters and a terminal `build()` returning a
 * `SorokitResult<Transaction>`. All of them honour an explicit
 * `sequenceNumber` so callers can build offline.
 */

import { Asset, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { validatePublicKey } from "../shared/validation";
import { isValidPublicKey } from "../shared/utils";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  resolveAssetInput,
  resolveFee,
  resolveMemo,
  resolveSourceAccount,
  updateSequenceCache,
} from "./buildHelpers";
import { getOfferPriceRatio } from "./offerPrice";
import {
  validateHomeDomain,
  validateSetOptionsByte,
} from "./setOptions";
import type { MemoParams, MultiSigSigner } from "./types";
import { validateBumpSequenceValue } from "./bumpSequence";
import {
  validateClawbackAmount,
  validateClawbackAssetCode,
} from "./buildTransaction";

/** Context shared by every fluent transaction builder. */
export interface FluentBuilderContext {
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  sourcePublicKey: string;
  /** Skip the Horizon lookup and build offline. */
  sequenceNumber?: string;
  /** Fee in stroops. Defaults to the protocol base fee. */
  estimatedFee?: string;
  /** Transaction timeout in seconds. Defaults to 0 (no timebound). */
  timeoutSeconds?: number;
}

/** Numeric flag bitmask accepted by the SetOptions builder. */
export type SetOptionsFlags = number;

/** Create a chainable SetOptions builder (issue #908). */
export function buildSetOptions(context: FluentBuilderContext): SetOptionsBuilder {
  return new SetOptionsBuilder(context);
}

/** Create a chainable manage offer builder (issue #905). */
export function buildManageOffer(context: FluentBuilderContext): ManageOfferBuilder {
  return new ManageOfferBuilder(context);
}

type SetOptionsOperation = NonNullable<
  Parameters<typeof Operation.setOptions>[0]
>;

function validateFlags(name: string, flags: number | undefined): SorokitResult<void> {
  if (flags === undefined) return ok(undefined);
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${name} must be an integer between 0 and 4294967295`,
    );
  }
  return ok(undefined);
}

function validateOfferAmount(amount: string): SorokitResult<void> {
  if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Offer amount must be a non-negative decimal with at most 7 decimal places",
    );
  }
  return ok(undefined);
}

function resolveBuilderAccount(context: FluentBuilderContext): Promise<SorokitResult<Account>> {
  const sourceResult = validatePublicKey(context.sourcePublicKey);
  if (sourceResult.status === "error") {
    return Promise.resolve(sourceResult);
  }
  return resolveSourceAccount(
    context.horizonUrl,
    context.sourcePublicKey,
    context.sequenceNumber,
  );
}

function buildTransaction(
  account: Account,
  context: FluentBuilderContext,
  operations: Parameters<TransactionBuilder["addOperation"]>[0][],
): SorokitResult<Transaction> {
  try {
    const builder = new TransactionBuilder(account, {
      fee: resolveFee(context.estimatedFee),
      networkPassphrase: context.networkConfig.networkPassphrase,
    });
    for (const operation of operations) {
      builder.addOperation(operation);
    }
    return ok(builder.setTimeout(context.timeoutSeconds ?? 0).build());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Chainable builder for `Operation.setOptions`.
 *
 * Thresholds are validated both individually (0 to 255) and as an ordered
 * triple (`low <= med <= high`). A signer with weight 0 removes that signer.
 */
export class SetOptionsBuilder {
  private masterWeightValue: number | undefined;
  private lowThresholdValue: number | undefined;
  private medThresholdValue: number | undefined;
  private highThresholdValue: number | undefined;
  private signersValue: MultiSigSigner[] = [];
  private setFlagsValue: number | undefined;
  private clearFlagsValue: number | undefined;
  private homeDomainValue: string | null | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  masterWeight(weight: number): this {
    this.masterWeightValue = weight;
    return this;
  }

  lowThreshold(threshold: number): this {
    this.lowThresholdValue = threshold;
    return this;
  }

  medThreshold(threshold: number): this {
    this.medThresholdValue = threshold;
    return this;
  }

  highThreshold(threshold: number): this {
    this.highThresholdValue = threshold;
    return this;
  }

  /** Add or update a signer with the given weight (0 removes it). */
  signer(key: string, weight: number): this {
    this.signersValue.push({ publicKey: key, weight });
    return this;
  }

  /** Remove a signer by assigning weight 0. */
  removeSigner(key: string): this {
    return this.signer(key, 0);
  }

  /** Set authentication flags. Use the Stellar SDK flag constants. */
  setFlags(flags: SetOptionsFlags): this {
    this.setFlagsValue = flags;
    return this;
  }

  /** Clear authentication flags. Use the Stellar SDK flag constants. */
  clearFlags(flags: SetOptionsFlags): this {
    this.clearFlagsValue = flags;
    return this;
  }

  homeDomain(domain: string | null): this {
    this.homeDomainValue = domain;
    return this;
  }

  /** Validate all options and return the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    for (const [name, value] of [
      ["masterWeight", this.masterWeightValue],
      ["lowThreshold", this.lowThresholdValue],
      ["medThreshold", this.medThresholdValue],
      ["highThreshold", this.highThresholdValue],
    ] as const) {
      const result = validateSetOptionsByte(name, value);
      if (result.status === "error") return result;
    }
    if (
      this.lowThresholdValue !== undefined &&
      this.medThresholdValue !== undefined &&
      this.lowThresholdValue > this.medThresholdValue
    ) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "lowThreshold must be less than or equal to medThreshold",
      );
    }
    if (
      this.medThresholdValue !== undefined &&
      this.highThresholdValue !== undefined &&
      this.medThresholdValue > this.highThresholdValue
    ) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "medThreshold must be less than or equal to highThreshold",
      );
    }
    const domainResult = validateHomeDomain(this.homeDomainValue);
    if (domainResult.status === "error") return domainResult;
    const setFlagsResult = validateFlags("setFlags", this.setFlagsValue);
    if (setFlagsResult.status === "error") return setFlagsResult;
    const clearFlagsResult = validateFlags("clearFlags", this.clearFlagsValue);
    if (clearFlagsResult.status === "error") return clearFlagsResult;

    const operations: Parameters<TransactionBuilder["addOperation"]>[0][] = [];
    const settings: SetOptionsOperation = {
      ...(this.masterWeightValue !== undefined && {
        masterWeight: this.masterWeightValue,
      }),
      ...(this.lowThresholdValue !== undefined && {
        lowThreshold: this.lowThresholdValue,
      }),
      ...(this.medThresholdValue !== undefined && {
        medThreshold: this.medThresholdValue,
      }),
      ...(this.highThresholdValue !== undefined && {
        highThreshold: this.highThresholdValue,
      }),
      ...(this.homeDomainValue !== undefined && {
        homeDomain: this.homeDomainValue ?? "",
      }),
      ...(this.setFlagsValue !== undefined && {
        setFlags: this.setFlagsValue as NonNullable<SetOptionsOperation["setFlags"]>,
      }),
      ...(this.clearFlagsValue !== undefined && {
        clearFlags: this.clearFlagsValue as NonNullable<SetOptionsOperation["clearFlags"]>,
      }),
    };
    if (Object.keys(settings).length > 0) {
      operations.push(Operation.setOptions(settings));
    }

    for (const signer of this.signersValue) {
      const keyResult = validatePublicKey(signer.publicKey);
      if (keyResult.status === "error") return keyResult;
      const weightResult = validateSetOptionsByte("signer weight", signer.weight);
      if (weightResult.status === "error") return weightResult;
      operations.push(
        Operation.setOptions({
          signer: { ed25519PublicKey: signer.publicKey, weight: signer.weight },
        }),
      );
    }
    if (operations.length === 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "SetOptionsBuilder requires at least one option before build()",
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, operations);
  }
}

/** Offer price as accepted by `ManageOfferBuilder.price()`. */
export type ManageOfferPrice = string | number;

/** Raw asset input captured by the chainable methods. */
type BuilderAssetInput =
  | { kind: "asset"; asset: Asset }
  | { kind: "code"; code: string; issuer: string | undefined };

/**
 * Chainable builder for `Operation.manageSellOffer`.
 *
 * An amount of `0` cancels the offer identified by `offerId`. Prices are
 * validated with the shared DEX price parser so string and numeric inputs
 * behave identically.
 */
export class ManageOfferBuilder {
  private sellingAssetValue: BuilderAssetInput | undefined;
  private buyingAssetValue: BuilderAssetInput | undefined;
  private amountValue: string | undefined;
  private priceValue: string | undefined;
  private offerIdValue: string | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /** Set the offer ID for updates and cancellations. */
  offerId(id: string | number): this {
    const normalized = String(id);
    if (!/^\d+$/.test(normalized)) {
      this.offerIdValue = "invalid";
      return this;
    }
    this.offerIdValue = normalized;
    return this;
  }

  /** Provide an `Asset`, or an asset code with an optional issuer. */
  sellingAsset(asset: Asset | string, issuer?: string): this {
    this.sellingAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /** Provide an `Asset`, or an asset code with an optional issuer. */
  buyingAsset(asset: Asset | string, issuer?: string): this {
    this.buyingAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  amount(amount: string | number): this {
    this.amountValue = String(amount);
    return this;
  }

  price(price: ManageOfferPrice): this {
    this.priceValue = typeof price === "number" ? String(price) : price;
    return this;
  }

  async build(): Promise<SorokitResult<Transaction>> {
    const sellingResult = resolveOfferAsset(this.sellingAssetValue, "sellingAsset");
    if (sellingResult.status === "error") return sellingResult;
    const buyingResult = resolveOfferAsset(this.buyingAssetValue, "buyingAsset");
    if (buyingResult.status === "error") return buyingResult;

    if (this.amountValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Offer amount is required");
    }
    const amountResult = validateOfferAmount(this.amountValue);
    if (amountResult.status === "error") return amountResult;

    if (this.priceValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Offer price is required");
    }
    const priceRatio = getOfferPriceRatio(this.priceValue);
    if (priceRatio === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid offer price "${this.priceValue}": expected a positive number`,
      );
    }

    if (
      this.offerIdValue !== undefined &&
      (this.offerIdValue === "invalid" ||
        !/^\d+$/.test(this.offerIdValue))
    ) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Offer ID must be a non-negative integer",
      );
    }

    let operation: ReturnType<typeof Operation.manageSellOffer>;
    try {
      operation = Operation.manageSellOffer({
        selling: sellingResult.data,
        buying: buyingResult.data,
        amount: this.amountValue,
        price: this.priceValue,
        ...(this.offerIdValue !== undefined && { offerId: this.offerIdValue }),
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build manage offer operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }
}

/**
 * Capture asset input without resolving it. Errors are surfaced at `build()`
 * so chainable methods never throw.
 */
function toAssetInput(
  asset: Asset | string,
  issuer: string | undefined,
): BuilderAssetInput {
  return typeof asset === "string"
    ? { kind: "code", code: asset, issuer }
    : { kind: "asset", asset };
}

function resolveOfferAsset(
  input: BuilderAssetInput | undefined,
  name: string,
): SorokitResult<Asset> {
  if (input === undefined) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${name} is required`,
    );
  }
  const result =
    input.kind === "code"
      ? resolveAssetInput(undefined, input.code, input.issuer)
      : resolveAssetInput(input.asset);
  if (result.status === "error") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${name}: ${result.error.message}`,
      result.error.cause,
    );
  }
  return result;
}

/** Options shared by all three single-operation builders. */
export interface TransactionBuilderOptions extends MemoParams {
  /**
   * Pre-fetched sequence number for the source account. When supplied, no
   * Horizon `loadAccount` call is made and the transaction is built offline.
   * For `BumpSequenceBuilder` this also supplies the "current sequence" used
   * by the `bumpTo > current` validation.
   */
  sequenceNumber?: string;
  /** When true, reuse the shared five-second sequence cache. */
  autoFetchSequence?: boolean;
  /** Fee in stroops. Defaults to the network base fee. */
  estimatedFee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeout?: number;
}

interface BuilderContext {
  sourcePublicKey: string;
  networkConfig: ResolvedNetworkConfig;
  options: TransactionBuilderOptions;
}

type SequenceInput = string | bigint | number;

/** Normalise a caller-supplied sequence to the string form the SDK expects. */
function normalizeSequence(value: SequenceInput): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value.toString() : null;
  }
  if (typeof value === "string") return value.trim();
  return null;
}

/** Resolve the source account and assemble a one-operation transaction. */
async function finalizeBuild(
  context: BuilderContext,
  operation: xdr.Operation,
): Promise<SorokitResult<Transaction>> {
  const sourceResult = await resolveSourceAccount(
    context.networkConfig.horizonUrl,
    context.sourcePublicKey,
    context.options.sequenceNumber,
    context.options.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;

  const memoResult = resolveMemo(context.options);
  if (memoResult.status === "error") return memoResult;

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee: resolveFee(context.options.estimatedFee),
      networkPassphrase: context.networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(context.options.timeout ?? DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const transaction = builder.build();

    if (
      context.options.autoFetchSequence === true &&
      context.options.sequenceNumber === undefined
    ) {
      updateSequenceCache(context.sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(transaction);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Build an `ACCOUNT_MERGE` operation that transfers the entire balance of the
 * source account to a destination and removes the source from the ledger.
 *
 * ⚠ **DATA LOSS:** account merge is irreversible. The source account is
 * deleted, along with its signers, trustlines, offers and data entries. Only
 * its native XLM balance is transferred; assets held in trustlines must be
 * moved out beforehand or they are lost. Never merge an account you may need
 * to recover.
 *
 * The destination is validated as a well-formed Stellar G-address and must not
 * be the source itself. This builder deliberately does not check whether the
 * destination exists on the ledger (#911 Out of Scope).
 *
 * @example
 * const result = await new AccountMergeBuilder(source, networkConfig)
 *   .destination(destination)
 *   .build();
 */
export class AccountMergeBuilder {
  private _destination?: string;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the account that will receive the source account's XLM balance. */
  destination(publicKey: string): this {
    this._destination = publicKey;
    return this;
  }

  /** Validate the destination and build the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    if (
      typeof this._destination !== "string" ||
      !isValidPublicKey(this._destination)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Account merge destination must be a valid Stellar G-address, got: "${String(this._destination)}".`,
      );
    }

    if (this._destination === this.sourcePublicKey) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Account merge destination must not be the source account: merging an account into itself is not allowed.",
      );
    }

    return finalizeBuild(
      this.context(),
      Operation.accountMerge({ destination: this._destination }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}

/**
 * Build a `BUMP_SEQUENCE` operation that moves the source account's sequence
 * number forward, invalidating every transaction signed with an older
 * sequence. This is the standard way to cancel pending (pre-authorized)
 * transactions that have not yet been submitted.
 *
 * The target must be a stringified unsigned 64-bit integer and, when the
 * caller supplies `sequenceNumber`, strictly greater than the current
 * sequence. This builder never fetches the current sequence from Horizon
 * (#910 Out of Scope); supply it through `options.sequenceNumber` to enable
 * the comparison, or use the offline `resolveSourceAccount` path.
 *
 * @example
 * // Cancel every pending transaction whose sequence is below 1000.
 * const result = await new BumpSequenceBuilder(source, networkConfig, {
 *   sequenceNumber: "999",
 * })
 *   .bumpTo(1000n)
 *   .build();
 */
export class BumpSequenceBuilder {
  private bumpToValue?: SequenceInput;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the new sequence number to bump to. */
  bumpTo(sequence: SequenceInput): this {
    this.bumpToValue = sequence;
    return this;
  }

  /** Validate the target sequence and build the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    if (this.bumpToValue === undefined) {
      return err(
        SorokitErrorCode.VALIDATION,
        "A bump-to sequence is required. Call .bumpTo(sequence) before .build().",
      );
    }

    const bumpTo = normalizeSequence(this.bumpToValue);
    if (bumpTo === null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Bump-to sequence must be a string, bigint, or safe integer.",
      );
    }

    const valueResult = validateBumpSequenceValue(bumpTo);
    if (valueResult.status === "error") return valueResult;

    const current = this.options.sequenceNumber;
    if (current !== undefined) {
      const currentResult = validateBumpSequenceValue(current);
      if (currentResult.status === "error") return currentResult;

      if (BigInt(bumpTo) <= BigInt(current)) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Bump-to sequence "${bumpTo}" must be greater than the current sequence "${current}".`,
        );
      }
    }

    return finalizeBuild(
      this.context(),
      Operation.bumpSequence({ bumpTo }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}

/** An issued asset supplied to `ClawbackBuilder.asset()`. */
export interface ClawbackAssetInput {
  assetCode: string;
  assetIssuer: string;
}

/**
 * Build a `CLAWBACK` operation with which an issuer reclaims tokens from a
 * token holder, for example to reverse a mis-sent payment or satisfy a
 * compliance action.
 *
 * The asset must be issued (native XLM is rejected) and the amount must be a
 * positive decimal string with at most seven decimal places. This builder
 * validates the *structure* of the asset and issuer, but does not query the
 * ledger to confirm the issuer's clawback flag is enabled (#909 Out of Scope).
 *
 * @example
 * const result = await new ClawbackBuilder(issuer, networkConfig)
 *   .asset({ assetCode: "USDC", assetIssuer: issuer })
 *   .from(holder)
 *   .amount("25.5")
 *   .build();
 */
export class ClawbackBuilder {
  private assetCode?: string;
  private assetIssuer?: string;
  private fromAddress?: string;
  private clawbackAmount?: string;

  constructor(
    private readonly sourcePublicKey: string,
    private readonly networkConfig: ResolvedNetworkConfig,
    private readonly options: TransactionBuilderOptions = {},
  ) {}

  /** Set the issued asset to reclaim. Native XLM is not supported. */
  asset(asset: Asset | ClawbackAssetInput): this {
    if (asset instanceof Asset) {
      this.assetCode = asset.getCode();
      this.assetIssuer = asset.getIssuer();
    } else {
      this.assetCode = asset?.assetCode;
      this.assetIssuer = asset?.assetIssuer;
    }
    return this;
  }

  /** Set the holder account from which the asset is reclaimed. */
  from(publicKey: string): this {
    this.fromAddress = publicKey;
    return this;
  }

  /** Set the positive amount to reclaim, as a decimal string. */
  amount(amount: string): this {
    this.clawbackAmount = amount;
    return this;
  }

  /** Validate the asset, holder and amount, then build the transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    const codeResult = validateClawbackAssetCode(this.assetCode as string);
    if (codeResult.status === "error") return codeResult;

    if (
      typeof this.assetIssuer !== "string" ||
      !isValidPublicKey(this.assetIssuer)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Clawback asset issuer must be a valid Stellar G-address, got: "${String(this.assetIssuer)}".`,
      );
    }

    if (
      typeof this.fromAddress !== "string" ||
      !isValidPublicKey(this.fromAddress)
    ) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `Clawback source holder must be a valid Stellar G-address, got: "${String(this.fromAddress)}".`,
      );
    }

    const amountResult = validateClawbackAmount(this.clawbackAmount as string);
    if (amountResult.status === "error") return amountResult;

    return finalizeBuild(
      this.context(),
      Operation.clawback({
        asset: new Asset(this.assetCode as string, this.assetIssuer),
        from: this.fromAddress,
        amount: this.clawbackAmount as string,
      }),
    );
  }

  private context(): BuilderContext {
    return {
      sourcePublicKey: this.sourcePublicKey,
      networkConfig: this.networkConfig,
      options: this.options,
    };
  }
}
