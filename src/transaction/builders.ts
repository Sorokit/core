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
import { validatePublicKey, validateStellarAddress } from "../shared/validation";
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

/** Create a chainable payment builder (issue #932). */
export function buildPayment(context: FluentBuilderContext): PaymentBuilder {
  return new PaymentBuilder(context);
}

/** Create a chainable change trust builder (issue #933). */
export function buildChangeTrust(context: FluentBuilderContext): ChangeTrustBuilder {
  return new ChangeTrustBuilder(context);
}

/** Create a chainable strict-send payment builder (issue #934). */
export function buildPaymentStrictSend(context: FluentBuilderContext): PaymentStrictSendBuilder {
  return new PaymentStrictSendBuilder(context);
}

/** Create a chainable strict-receive payment builder (issue #934). */
export function buildPaymentStrictReceive(context: FluentBuilderContext): PaymentStrictReceiveBuilder {
  return new PaymentStrictReceiveBuilder(context);
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

/**
 * Chainable builder for payment operations with muxed address and path payment support (issue #932).
 *
 * Supports:
 * - Regular payments (Operation.payment)
 * - Payments to muxed addresses (M-prefixed)
 * - Path payments with intermediate assets (Operation.pathPaymentStrictSend or pathPaymentStrictReceive)
 *
 * @example
 * ```ts
 * // Regular payment
 * const tx = await buildPayment(context)
 *   .destination("GDEST...")
 *   .amount("100")
 *   .asset("USDC", "GISSUER...")
 *   .build();
 *
 * // Path payment with intermediate assets
 * const tx = await buildPayment(context)
 *   .destination("GDEST...")
 *   .sendAmount("100")
 *   .sendAsset("USDC", "GISSUER...")
 *   .destAsset("EURC", "GISSUER2...")
 *   .path(["XLM"], ["BTC", "GBTCISSUER..."])
 *   .build();
 * ```
 */
export class PaymentBuilder {
  private destinationValue: string | undefined;
  private amountValue: string | undefined;
  private sendAmountValue: string | undefined;
  private destAmountValue: string | undefined;
  private assetValue: BuilderAssetInput | undefined;
  private sendAssetValue: BuilderAssetInput | undefined;
  private destAssetValue: BuilderAssetInput | undefined;
  private pathValue: BuilderAssetInput[] | undefined;
  private modeValue: "strict-send" | "strict-receive" | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /**
   * Set destination address. Accepts both regular (G...) and muxed (M...) addresses.
   */
  destination(address: string): this {
    this.destinationValue = address;
    return this;
  }

  /**
   * Set payment amount for simple payments.
   * Use sendAmount() or destAmount() for path payments instead.
   */
  amount(amount: string | number): this {
    this.amountValue = String(amount);
    return this;
  }

  /**
   * Set the exact amount to send (strict-send path payment).
   * Mutually exclusive with destAmount().
   */
  sendAmount(amount: string | number): this {
    this.sendAmountValue = String(amount);
    this.modeValue = "strict-send";
    return this;
  }

  /**
   * Set the exact amount destination receives (strict-receive path payment).
   * Mutually exclusive with sendAmount().
   */
  destAmount(amount: string | number): this {
    this.destAmountValue = String(amount);
    this.modeValue = "strict-receive";
    return this;
  }

  /**
   * Set asset for simple payment.
   * Provide an Asset instance, or an asset code with optional issuer.
   * Defaults to XLM (native) if not called.
   */
  asset(asset: Asset | string, issuer?: string): this {
    this.assetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set the sending asset for path payments.
   * Provide an Asset instance, or an asset code with optional issuer.
   */
  sendAsset(asset: Asset | string, issuer?: string): this {
    this.sendAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set the destination asset for path payments.
   * Provide an Asset instance, or an asset code with optional issuer.
   */
  destAsset(asset: Asset | string, issuer?: string): this {
    this.destAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set intermediate assets for path payment.
   *
   * Each path asset can be:
   * - An Asset instance: .path(assetInstance1, assetInstance2)
   * - A code string for XLM: .path("XLM")
   * - A code and issuer: .path(["USDC", "GISSUER..."], ["EURC", "GISSUER2..."])
   *
   * @example
   * .path("XLM") // Single intermediate asset
   * .path(["USDC", "GISSUER..."], ["EURC", "GISSUER2..."]) // Multiple
   */
  path(...assets: Array<Asset | string | [string, string]>): this {
    this.pathValue = assets.map((asset) => {
      if (Array.isArray(asset)) {
        return toAssetInput(asset[0], asset[1]);
      }
      return toAssetInput(asset, undefined);
    });
    return this;
  }

  async build(): Promise<SorokitResult<Transaction>> {
    // Validate destination
    if (this.destinationValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Payment destination is required");
    }
    const destResult = validateStellarAddress(this.destinationValue);
    if (destResult.status === "error") return destResult;

    // Determine payment mode: simple payment or path payment
    const isPathPayment = 
      this.sendAmountValue !== undefined ||
      this.destAmountValue !== undefined ||
      this.sendAssetValue !== undefined ||
      this.destAssetValue !== undefined ||
      this.pathValue !== undefined;

    if (isPathPayment) {
      return this.buildPathPayment();
    } else {
      return this.buildSimplePayment();
    }
  }

  private async buildSimplePayment(): Promise<SorokitResult<Transaction>> {
    // Validate amount
    if (this.amountValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Payment amount is required");
    }
    const amountResult = validateOfferAmount(this.amountValue);
    if (amountResult.status === "error") return amountResult;

    // Resolve asset (defaults to native XLM)
    let asset: Asset;
    if (this.assetValue === undefined) {
      asset = Asset.native();
    } else {
      const assetResult = resolveOfferAsset(this.assetValue, "asset");
      if (assetResult.status === "error") return assetResult;
      asset = assetResult.data;
    }

    // Build payment operation
    let operation: ReturnType<typeof Operation.payment>;
    try {
      operation = Operation.payment({
        destination: this.destinationValue!,
        asset,
        amount: this.amountValue,
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build payment operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }

  private async buildPathPayment(): Promise<SorokitResult<Transaction>> {
    // Validate mode and amounts
    if (this.modeValue === undefined) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Path payment mode is required: use sendAmount() for strict-send or destAmount() for strict-receive",
      );
    }

    if (this.sendAmountValue !== undefined && this.destAmountValue !== undefined) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Cannot specify both sendAmount and destAmount: use one for strict-send or strict-receive mode",
      );
    }

    const amount = this.sendAmountValue ?? this.destAmountValue;
    if (amount === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Path payment amount is required");
    }
    const amountResult = validateOfferAmount(amount);
    if (amountResult.status === "error") return amountResult;

    // Resolve send asset (defaults to native XLM)
    let sendAsset: Asset;
    if (this.sendAssetValue === undefined) {
      sendAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.sendAssetValue, "sendAsset");
      if (result.status === "error") return result;
      sendAsset = result.data;
    }

    // Resolve dest asset (defaults to native XLM)
    let destAsset: Asset;
    if (this.destAssetValue === undefined) {
      destAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.destAssetValue, "destAsset");
      if (result.status === "error") return result;
      destAsset = result.data;
    }

    // Validate path assets
    const pathAssets: Asset[] = [];
    if (this.pathValue !== undefined) {
      if (this.pathValue.length === 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path must contain at least one intermediate asset when specified",
        );
      }
      if (this.pathValue.length > 5) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path cannot contain more than 5 intermediate assets",
        );
      }
      for (let i = 0; i < this.pathValue.length; i++) {
        const result = resolveOfferAsset(this.pathValue[i], `path asset ${i + 1}`);
        if (result.status === "error") return result;
        pathAssets.push(result.data);
      }
    }

    // Build path payment operation
    let operation: ReturnType<typeof Operation.pathPaymentStrictSend | typeof Operation.pathPaymentStrictReceive>;
    try {
      if (this.modeValue === "strict-send") {
        operation = Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount: amount,
          destination: this.destinationValue!,
          destAsset,
          destMin: "0.0000001", // Minimum destination amount (will be improved with slippage parameter)
          path: pathAssets,
        });
      } else {
        operation = Operation.pathPaymentStrictReceive({
          sendAsset,
          sendMax: "922337203685.4775807", // Maximum send amount (will be improved with slippage parameter)
          destination: this.destinationValue!,
          destAsset,
          destAmount: amount,
          path: pathAssets,
        });
      }
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build path payment operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }
}

/**
 * Chainable builder for trustline operations (issue #933).
 *
 * Supports:
 * - Creating trustlines for custom assets
 * - Updating trustline limits
 * - Removing trustlines (limit = "0")
 *
 * @example
 * ```ts
 * // Create trustline with default limit
 * const tx = await buildChangeTrust(context)
 *   .asset("USDC", "GISSUER...")
 *   .build();
 *
 * // Create trustline with custom limit
 * const tx = await buildChangeTrust(context)
 *   .asset("EURC", "GISSUER...")
 *   .limit("1000")
 *   .build();
 *
 * // Remove trustline
 * const tx = await buildChangeTrust(context)
 *   .asset("USDC", "GISSUER...")
 *   .limit("0")
 *   .build();
 * ```
 */
export class ChangeTrustBuilder {
  private assetValue: BuilderAssetInput | undefined;
  private limitValue: string | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /**
   * Set the asset to trust.
   * Provide an Asset instance, or an asset code with issuer.
   *
   * Note: Native XLM cannot be used with changeTrust - trustlines are only for issued assets.
   */
  asset(asset: Asset | string, issuer?: string): this {
    this.assetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set the trust limit in asset units.
   *
   * - Omit or pass no value: Maximum limit (default)
   * - Positive value: Set specific limit
   * - "0": Remove the trustline
   *
   * The limit must be a non-negative decimal with at most 7 decimal places.
   */
  limit(amount?: string | number): this {
    if (amount !== undefined) {
      this.limitValue = String(amount);
    }
    return this;
  }

  async build(): Promise<SorokitResult<Transaction>> {
    // Validate asset is provided
    if (this.assetValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Asset is required for trustline");
    }

    // Resolve asset
    const assetResult = resolveOfferAsset(this.assetValue, "asset");
    if (assetResult.status === "error") return assetResult;
    const asset = assetResult.data;

    // Validate that asset is not native
    if (asset.isNative()) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Cannot create trustline for native XLM. Trustlines are only for issued assets.",
      );
    }

    // Validate limit if provided
    if (this.limitValue !== undefined) {
      // Allow "0" for removing trustline, otherwise validate as amount
      if (this.limitValue !== "0") {
        const limitResult = validateOfferAmount(this.limitValue);
        if (limitResult.status === "error") {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Invalid trust limit: ${limitResult.error.message}`,
          );
        }
      }

      // Ensure limit is non-negative
      const limitNum = parseFloat(this.limitValue);
      if (isNaN(limitNum) || limitNum < 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Trust limit must be a non-negative number",
        );
      }
    }

    // Build changeTrust operation
    let operation: ReturnType<typeof Operation.changeTrust>;
    try {
      operation = Operation.changeTrust({
        asset,
        ...(this.limitValue !== undefined && { limit: this.limitValue }),
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build changeTrust operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }
}

/**
 * Chainable builder for strict-send path payments (issue #934).
 *
 * Guarantees the sender sends an exact amount. The destination receives
 * a variable amount based on the exchange rate along the payment path.
 *
 * Use this when you want to control exactly how much you spend, but are
 * flexible about how much the recipient gets (subject to slippage protection).
 *
 * @example
 * ```ts
 * // Send exactly 100 USDC, receive at least 95 EURC
 * const tx = await buildPaymentStrictSend(context)
 *   .destination("GDEST...")
 *   .sendAmount("100")
 *   .sendAsset("USDC", "GISSUER...")
 *   .destAsset("EURC", "GISSUER2...")
 *   .minDestAmount("95") // Slippage protection
 *   .path("XLM")
 *   .build();
 * ```
 */
export class PaymentStrictSendBuilder {
  private destinationValue: string | undefined;
  private sendAmountValue: string | undefined;
  private minDestAmountValue: string | undefined;
  private sendAssetValue: BuilderAssetInput | undefined;
  private destAssetValue: BuilderAssetInput | undefined;
  private pathValue: BuilderAssetInput[] | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /**
   * Set destination address. Accepts both regular (G...) and muxed (M...) addresses.
   */
  destination(address: string): this {
    this.destinationValue = address;
    return this;
  }

  /**
   * Set the exact amount to send (required).
   * This is the amount that will be deducted from the sender's balance.
   */
  sendAmount(amount: string | number): this {
    this.sendAmountValue = String(amount);
    return this;
  }

  /**
   * Set the minimum amount the destination must receive (slippage protection).
   * If not set, defaults to a minimal value (effectively no protection).
   * Set this based on your slippage tolerance.
   *
   * @example
   * .sendAmount("100").minDestAmount("95") // Allow up to 5% slippage
   */
  minDestAmount(amount: string | number): this {
    this.minDestAmountValue = String(amount);
    return this;
  }

  /**
   * Set the asset to send.
   * Defaults to XLM (native) if not called.
   */
  sendAsset(asset: Asset | string, issuer?: string): this {
    this.sendAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set the asset the destination will receive.
   * Defaults to XLM (native) if not called.
   */
  destAsset(asset: Asset | string, issuer?: string): this {
    this.destAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set intermediate assets for the payment path.
   * Maximum 5 assets. Required if sending and receiving different assets.
   *
   * @example
   * .path("XLM") // Single hop
   * .path(["USDC", "GISSUER..."], ["BTC", "GBTC..."]) // Multi-hop
   */
  path(...assets: Array<Asset | string | [string, string]>): this {
    this.pathValue = assets.map((asset) => {
      if (Array.isArray(asset)) {
        return toAssetInput(asset[0], asset[1]);
      }
      return toAssetInput(asset, undefined);
    });
    return this;
  }

  async build(): Promise<SorokitResult<Transaction>> {
    // Validate destination
    if (this.destinationValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Destination is required");
    }
    const destResult = validateStellarAddress(this.destinationValue);
    if (destResult.status === "error") return destResult;

    // Validate send amount
    if (this.sendAmountValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Send amount is required");
    }
    const sendAmountResult = validateOfferAmount(this.sendAmountValue);
    if (sendAmountResult.status === "error") return sendAmountResult;

    // Validate min dest amount if provided
    const minDestAmount = this.minDestAmountValue ?? "0.0000001";
    const minDestAmountResult = validateOfferAmount(minDestAmount);
    if (minDestAmountResult.status === "error") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid min destination amount: ${minDestAmountResult.error.message}`,
      );
    }

    // Resolve assets
    let sendAsset: Asset;
    if (this.sendAssetValue === undefined) {
      sendAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.sendAssetValue, "sendAsset");
      if (result.status === "error") return result;
      sendAsset = result.data;
    }

    let destAsset: Asset;
    if (this.destAssetValue === undefined) {
      destAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.destAssetValue, "destAsset");
      if (result.status === "error") return result;
      destAsset = result.data;
    }

    // Validate path
    const pathAssets: Asset[] = [];
    if (this.pathValue !== undefined) {
      if (this.pathValue.length === 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path must contain at least one intermediate asset when specified",
        );
      }
      if (this.pathValue.length > 5) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path cannot contain more than 5 intermediate assets",
        );
      }
      for (let i = 0; i < this.pathValue.length; i++) {
        const result = resolveOfferAsset(this.pathValue[i], `path asset ${i + 1}`);
        if (result.status === "error") return result;
        pathAssets.push(result.data);
      }
    }

    // Build operation
    let operation: ReturnType<typeof Operation.pathPaymentStrictSend>;
    try {
      operation = Operation.pathPaymentStrictSend({
        sendAsset,
        sendAmount: this.sendAmountValue,
        destination: this.destinationValue,
        destAsset,
        destMin: minDestAmount,
        path: pathAssets,
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build strict-send payment operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }
}

/**
 * Chainable builder for strict-receive path payments (issue #934).
 *
 * Guarantees the destination receives an exact amount. The sender pays
 * a variable amount based on the exchange rate along the payment path.
 *
 * Use this when you want to ensure the recipient gets an exact amount,
 * but are flexible about how much you spend (subject to slippage protection).
 *
 * @example
 * ```ts
 * // Recipient receives exactly 100 EURC, sender pays at most 110 USDC
 * const tx = await buildPaymentStrictReceive(context)
 *   .destination("GDEST...")
 *   .destAmount("100")
 *   .sendAsset("USDC", "GISSUER...")
 *   .destAsset("EURC", "GISSUER2...")
 *   .maxSendAmount("110") // Slippage protection
 *   .path("XLM")
 *   .build();
 * ```
 */
export class PaymentStrictReceiveBuilder {
  private destinationValue: string | undefined;
  private destAmountValue: string | undefined;
  private maxSendAmountValue: string | undefined;
  private sendAssetValue: BuilderAssetInput | undefined;
  private destAssetValue: BuilderAssetInput | undefined;
  private pathValue: BuilderAssetInput[] | undefined;

  constructor(private readonly context: FluentBuilderContext) {}

  /**
   * Set destination address. Accepts both regular (G...) and muxed (M...) addresses.
   */
  destination(address: string): this {
    this.destinationValue = address;
    return this;
  }

  /**
   * Set the exact amount the destination will receive (required).
   * This is the amount that will be credited to the recipient's balance.
   */
  destAmount(amount: string | number): this {
    this.destAmountValue = String(amount);
    return this;
  }

  /**
   * Set the maximum amount willing to send (slippage protection).
   * If not set, defaults to the protocol maximum (effectively no protection).
   * Set this based on your slippage tolerance.
   *
   * @example
   * .destAmount("100").maxSendAmount("105") // Allow up to 5% slippage
   */
  maxSendAmount(amount: string | number): this {
    this.maxSendAmountValue = String(amount);
    return this;
  }

  /**
   * Set the asset to send.
   * Defaults to XLM (native) if not called.
   */
  sendAsset(asset: Asset | string, issuer?: string): this {
    this.sendAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set the asset the destination will receive.
   * Defaults to XLM (native) if not called.
   */
  destAsset(asset: Asset | string, issuer?: string): this {
    this.destAssetValue = toAssetInput(asset, issuer);
    return this;
  }

  /**
   * Set intermediate assets for the payment path.
   * Maximum 5 assets. Required if sending and receiving different assets.
   *
   * @example
   * .path("XLM") // Single hop
   * .path(["USDC", "GISSUER..."], ["BTC", "GBTC..."]) // Multi-hop
   */
  path(...assets: Array<Asset | string | [string, string]>): this {
    this.pathValue = assets.map((asset) => {
      if (Array.isArray(asset)) {
        return toAssetInput(asset[0], asset[1]);
      }
      return toAssetInput(asset, undefined);
    });
    return this;
  }

  async build(): Promise<SorokitResult<Transaction>> {
    // Validate destination
    if (this.destinationValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Destination is required");
    }
    const destResult = validateStellarAddress(this.destinationValue);
    if (destResult.status === "error") return destResult;

    // Validate dest amount
    if (this.destAmountValue === undefined) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Destination amount is required");
    }
    const destAmountResult = validateOfferAmount(this.destAmountValue);
    if (destAmountResult.status === "error") return destAmountResult;

    // Validate max send amount if provided
    const maxSendAmount = this.maxSendAmountValue ?? "922337203685.4775807";
    const maxSendAmountResult = validateOfferAmount(maxSendAmount);
    if (maxSendAmountResult.status === "error") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid max send amount: ${maxSendAmountResult.error.message}`,
      );
    }

    // Resolve assets
    let sendAsset: Asset;
    if (this.sendAssetValue === undefined) {
      sendAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.sendAssetValue, "sendAsset");
      if (result.status === "error") return result;
      sendAsset = result.data;
    }

    let destAsset: Asset;
    if (this.destAssetValue === undefined) {
      destAsset = Asset.native();
    } else {
      const result = resolveOfferAsset(this.destAssetValue, "destAsset");
      if (result.status === "error") return result;
      destAsset = result.data;
    }

    // Validate path
    const pathAssets: Asset[] = [];
    if (this.pathValue !== undefined) {
      if (this.pathValue.length === 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path must contain at least one intermediate asset when specified",
        );
      }
      if (this.pathValue.length > 5) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Path cannot contain more than 5 intermediate assets",
        );
      }
      for (let i = 0; i < this.pathValue.length; i++) {
        const result = resolveOfferAsset(this.pathValue[i], `path asset ${i + 1}`);
        if (result.status === "error") return result;
        pathAssets.push(result.data);
      }
    }

    // Build operation
    let operation: ReturnType<typeof Operation.pathPaymentStrictReceive>;
    try {
      operation = Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax: maxSendAmount,
        destination: this.destinationValue,
        destAsset,
        destAmount: this.destAmountValue,
        path: pathAssets,
      });
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build strict-receive payment operation: ${toMessage(cause)}`,
        cause,
      );
    }

    const accountResult = await resolveBuilderAccount(this.context);
    if (accountResult.status === "error") return accountResult;
    return buildTransaction(accountResult.data, this.context, [operation]);
  }
}
