import {
  Account,
  Asset,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { buildAtomicSwap as buildLegacyAtomicSwap } from "./buildTransaction";
import type { AtomicSwapParams } from "./types";

const MAX_SLIPPAGE_PERCENT = 50;
const STELLAR_AMOUNT_SCALE = 10_000_000;

type AtomicSwapOptions = {
  selling: any;
  amount: string;
  buying: any;
  maxSlippage: number;
  priceFeed: any;
};

function asAsset(value: any): Asset | null {
  if (value instanceof Asset) return value;
  if (!value || typeof value !== "object") return null;

  try {
    if (typeof value.isNative === "function" && value.isNative()) {
      return Asset.native();
    }

    const code = value.code ?? value.assetCode ?? value.getCode?.();
    const issuer = value.issuer ?? value.assetIssuer ?? value.getIssuer?.();
    if (typeof code !== "string" || code.length === 0) return null;
    if ((code.toUpperCase() === "XLM" || code.toLowerCase() === "native") && !issuer) {
      return Asset.native();
    }
    if (typeof issuer !== "string" || !StrKey.isValidEd25519PublicKey(issuer)) {
      return null;
    }
    return new Asset(code, issuer);
  } catch {
    return null;
  }
}

function sameAsset(left: Asset, right: Asset): boolean {
  if (left.isNative() || right.isNative()) {
    return left.isNative() && right.isNative();
  }
  return left.getCode() === right.getCode() && left.getIssuer() === right.getIssuer();
}

function decimalAmount(value: string): number | null {
  if (typeof value !== "string" || !/^(?:\d+)(?:\.\d{1,7})?$/.test(value)) {
    return null;
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function toStellarAmount(value: number): string {
  const roundedDown = Math.floor(value * STELLAR_AMOUNT_SCALE) / STELLAR_AMOUNT_SCALE;
  return roundedDown.toFixed(7);
}

function accountDetails(trader: any): {
  account: Account;
  networkPassphrase: string;
} | null {
  try {
    const account = trader?.account ?? trader;
    const accountId =
      typeof account?.accountId === "function"
        ? account.accountId()
        : account?.publicKey ?? account?.address;
    const sequenceNumber =
      typeof account?.sequenceNumber === "function"
        ? account.sequenceNumber()
        : account?.sequenceNumber;
    const networkPassphrase =
      trader?.networkPassphrase ??
      trader?.networkConfig?.networkPassphrase ??
      Networks.PUBLIC;

    if (
      typeof accountId !== "string" ||
      !StrKey.isValidEd25519PublicKey(accountId) ||
      (typeof sequenceNumber !== "string" &&
        typeof sequenceNumber !== "number") ||
      typeof networkPassphrase !== "string" ||
      networkPassphrase.length === 0
    ) {
      return null;
    }

    return {
      account: new Account(accountId, String(sequenceNumber)),
      networkPassphrase,
    };
  } catch {
    return null;
  }
}

async function buildPriceProtectedSwap(
  trader: any,
  options: AtomicSwapOptions,
): Promise<SorokitResult<string>> {
  if (!options || typeof options !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "options must be an object containing the swap parameters.",
    );
  }

  if (
    typeof options.maxSlippage !== "number" ||
    !Number.isFinite(options.maxSlippage) ||
    options.maxSlippage < 0 ||
    options.maxSlippage > MAX_SLIPPAGE_PERCENT
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `maxSlippage must be between 0 and ${MAX_SLIPPAGE_PERCENT} percent.`,
    );
  }

  const amount = decimalAmount(options.amount);
  if (amount === null) {
    return err(
      SorokitErrorCode.VALIDATION,
      "amount must be a positive decimal with no more than 7 fractional digits.",
    );
  }

  const selling = asAsset(options.selling);
  const buying = asAsset(options.buying);
  if (!selling || !buying || sameAsset(selling, buying)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "selling and buying must be valid, distinct Stellar assets.",
    );
  }

  if (!options.priceFeed || typeof options.priceFeed.getPrice !== "function") {
    return err(
      SorokitErrorCode.VALIDATION,
      "priceFeed must provide a getPrice(asset, currency) function.",
    );
  }

  const source = accountDetails(trader);
  if (!source) {
    return err(
      SorokitErrorCode.VALIDATION,
      "trader must provide a valid Stellar account and network passphrase.",
    );
  }

  try {
    const sellingCode = selling.isNative() ? "XLM" : selling.getCode();
    const buyingCode = buying.isNative() ? "XLM" : buying.getCode();
    const [sellingQuote, buyingQuote] = await Promise.all([
      options.priceFeed.getPrice(sellingCode, "USD"),
      options.priceFeed.getPrice(buyingCode, "USD"),
    ]);

    if (
      !sellingQuote ||
      !buyingQuote ||
      (sellingQuote.status !== undefined && sellingQuote.status !== "fresh") ||
      (buyingQuote.status !== undefined && buyingQuote.status !== "fresh") ||
      typeof sellingQuote.price !== "number" ||
      !Number.isFinite(sellingQuote.price) ||
      sellingQuote.price <= 0 ||
      typeof buyingQuote.price !== "number" ||
      !Number.isFinite(buyingQuote.price) ||
      buyingQuote.price <= 0 ||
      (sellingQuote.currency && buyingQuote.currency &&
        sellingQuote.currency.toUpperCase() !== buyingQuote.currency.toUpperCase())
    ) {
      return err(
        SorokitErrorCode.SERVICE_UNAVAILABLE,
        "The price feed did not return fresh, comparable positive asset prices.",
      );
    }

    const priceImpactPercent = Math.max(
      sellingQuote.priceImpactPercent ?? 0,
      buyingQuote.priceImpactPercent ?? 0,
    );
    if (
      !Number.isFinite(priceImpactPercent) ||
      priceImpactPercent < 0 ||
      priceImpactPercent >= 100
    ) {
      return err(
        SorokitErrorCode.SERVICE_UNAVAILABLE,
        "The price feed returned an invalid price impact estimate.",
      );
    }

    const spotOutput = (amount * sellingQuote.price) / buyingQuote.price;
    const expectedOutput = spotOutput * (1 - priceImpactPercent / 100);
    const minimumOutput =
      expectedOutput * (1 - options.maxSlippage / 100);
    if (
      !Number.isFinite(expectedOutput) ||
      !Number.isFinite(minimumOutput) ||
      expectedOutput <= 0 ||
      minimumOutput <= 0
    ) {
      return err(
        SorokitErrorCode.VALIDATION,
        "The calculated swap output must be greater than zero.",
      );
    }

    const minimumOutputAmount = toStellarAmount(minimumOutput);
    if (Number(minimumOutputAmount) <= 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "The minimum swap output is below Stellar's smallest amount unit.",
      );
    }

    const transaction = new TransactionBuilder(source.account, {
      fee: "100",
      networkPassphrase: source.networkPassphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: selling,
          sendAmount: options.amount,
          destination: source.account.accountId(),
          destAsset: buying,
          destMin: minimumOutputAmount,
          path: [],
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();

    return ok(transaction.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Unable to build the price-protected atomic swap transaction.",
      cause,
    );
  }
}

export function buildAtomicSwap(
  trader: any,
  options: AtomicSwapOptions,
): Promise<SorokitResult<string>>;
export function buildAtomicSwap(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: AtomicSwapParams,
): Promise<SorokitResult<string>>;
export function buildAtomicSwap(
  traderOrHorizon: any,
  optionsOrNetwork: any,
  sourcePublicKey?: string,
  params?: AtomicSwapParams,
): Promise<SorokitResult<string>> {
  if (typeof traderOrHorizon === "string") {
    return buildLegacyAtomicSwap(
      traderOrHorizon,
      optionsOrNetwork as ResolvedNetworkConfig,
      sourcePublicKey!,
      params!,
    );
  }
  return buildPriceProtectedSwap(traderOrHorizon, optionsOrNetwork);
}