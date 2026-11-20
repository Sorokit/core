/**
 * Fluent transaction builders for account configuration and DEX offers.
 *
 * Both builders validate inputs as methods are called and defer account
 * resolution and transaction assembly until `build()`. Supplying a
 * `sequenceNumber` keeps `build()` fully offline; otherwise the source account
 * is loaded from Horizon through the shared build helper.
 */

import { Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Account, Asset, Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { validatePublicKey } from "../shared/validation";
import { validateAmount } from "../shared/validation";
import { MIN_ACCOUNT_BALANCE_XLM } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  resolveAssetInput,
  resolveFee,
  resolveSourceAccount,
} from "./buildHelpers";
import { getOfferPriceRatio } from "./offerPrice";
import {
  validateHomeDomain,
  validateSetOptionsByte,
} from "./setOptions";
import type { MultiSigSigner } from "./types";

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

/** Create a chainable create account builder (issue #935). */
export function buildCreateAccount(context: FluentBuilderContext): CreateAccountBuilder {
  return new CreateAccountBuilder(context);
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
 * Chainable builder for `Operation.createAccount`.
 *
 * Creates and funds a new account. The destination must be a valid Stellar
 * public key and the starting balance must meet the minimum account balance
 * (`MIN_ACCOUNT_BALANCE_XLM`, currently 1 XLM) required to keep the new
 * account funded on the network. The minimum balance is not looked up from
 * the network; it is enforced locally against the shared constant.
 */
export class CreateAccountBuilder {
  private destinationValue: string | undefined;
  private startingBalanceValue: string | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /** Set the public key of the account to create. */
  destination(publicKey: string): this {
    this.destinationValue = publicKey;
    return this;
  }

  /** Set the initial funding amount in XLM (must meet the minimum balance). */
  startingBalance(amount: string | number): this {
    this.startingBalanceValue = String(amount);
    return this;
  }

  /** Validate inputs and return the unsigned transaction. */
  async build(): Promise<SorokitResult<Transaction>> {
    if (this.destinationValue === undefined) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "CreateAccountBuilder requires a destination before build()",
      );
    }
    const destinationResult = validatePublicKey(this.destinationValue);
    if (destinationResult.status === "error") return destinationResult;

    if (this.startingBalanceValue === undefined) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "CreateAccountBuilder requires a starting balance before build()",
      );
    }
    const amountResult = validateAmount(this.startingBalanceValue);
    if (amountResult.status === "error") return amountResult;
    if (Number(this.startingBalanceValue) < MIN_ACCOUNT_BALANCE_XLM) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Starting balance must be at least ${MIN_ACCOUNT_BALANCE_XLM} XLM`,
      );
    }

    let operation: ReturnType<typeof Operation.createAccount>;
    try {
      operation = Operation.createAccount({
        destination: this.destinationValue,
        startingBalance: this.startingBalanceValue,
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build create account operation: ${toMessage(cause)}`,
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
