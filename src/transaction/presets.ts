/**
 * Transaction builder presets (#982).
 *
 * Shortcuts for the most common single-purpose transactions. Each preset
 * validates its inputs up front and returns a regular {@link ComposeBuilder}
 * with the operation already added, so the result can be customised (extra
 * operations, memo, timeout, fee estimation, sequence number) before calling
 * `.build()`, which yields the unsigned transaction XDR.
 *
 * A transaction always needs a source account and a network, so presets are
 * bound to a {@link PresetContext}. Two equivalent entry points:
 *
 * ```ts
 * // 1. Bind once, then use the short signatures.
 * const p = createPresets({ source: myPublicKey, network: "testnet" });
 * const payment = p.simplePayment(destination, "10");
 *
 * // 2. One-off calls: pass the context as the last argument.
 * const payment = presets.simplePayment(destination, "10", "native", { source, network: "testnet" });
 *
 * if (payment.status === "ok") {
 *   const xdr = await payment.data.addMemo("invoice 42").setTimeout(60).build();
 * }
 * ```
 *
 * ## Preset options
 *
 * | Preset | Arguments | Operation added |
 * | ------ | --------- | --------------- |
 * | `simplePayment(destination, amount, asset?)` | `destination`: G… or M… address. `amount`: positive decimal string, ≤ 7 decimals. `asset`: `"native"`/`"XLM"` (default), an `Asset`, or `{ assetCode, assetIssuer }`. | `payment` |
 * | `swapAssets(sell, buy, price, amount)` | `sell`/`buy`: distinct assets (as above). `price`: units of `buy` per 1 `sell`, as a positive decimal string or `{ n, d }`. `amount`: amount of `sell` to offer. | `manageSellOffer` (new offer) |
 * | `setupTrustline(asset, limit?)` | `asset`: a non-native asset. `limit`: optional positive decimal string; omitted = maximum limit. | `changeTrust` |
 *
 * `PresetContext.options` is passed straight to `compose()`: use it for
 * `sequenceNumber` (offline build), `estimatedFee`, `timeout`, `memo`,
 * `horizonUrl`, and so on.
 *
 * Validation failures return a `VALIDATION` error without creating a builder.
 * Out of scope: multi-step or conditional presets.
 */
import { Asset, StrKey } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { compose } from "./compose";
import type { ComposeAssetInput, ComposeBuilder, ComposeNetwork, ComposeOptions } from "./compose";

/** Source account and network a preset builds for. */
export interface PresetContext {
  /** G… public key of the transaction source account. */
  source: string;
  /** Network type (e.g. `"testnet"`) or a resolved network config. */
  network: ComposeNetwork;
  /** Passed through to `compose()` (sequence number, fee, timeout, memo, URLs). */
  options?: ComposeOptions;
}

/** Asset argument accepted by presets. */
export type PresetAsset = ComposeAssetInput | "native" | "XLM";

/** Offer price: units of the bought asset per 1 unit of the sold asset. */
export type PresetPrice = string | { n: number; d: number };

/** Presets bound to a {@link PresetContext}, as returned by {@link createPresets}. */
export interface TransactionPresets {
  /** Send `amount` of `asset` (default XLM) to `destination`. */
  simplePayment(destination: string, amount: string, asset?: PresetAsset): SorokitResult<ComposeBuilder>;
  /** Offer to sell `amount` of `sell` for `buy` at `price` (a manage-sell-offer). */
  swapAssets(sell: PresetAsset, buy: PresetAsset, price: PresetPrice, amount: string): SorokitResult<ComposeBuilder>;
  /** Create or update a trustline to `asset`, optionally capped at `limit`. */
  setupTrustline(asset: PresetAsset, limit?: string): SorokitResult<ComposeBuilder>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Largest amount a Stellar int64 stroop value can hold. */
const MAX_AMOUNT_STROOPS = 2n ** 63n - 1n;
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

class PresetError extends Error {}

function invalid(message: string): never {
  throw new PresetError(message);
}

function checkAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !AMOUNT_RE.test(value)) {
    invalid(`${label} must be a positive decimal string with at most 7 decimal places, got ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = value.split(".");
  const stroops = BigInt(whole as string) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
  if (stroops <= 0n) invalid(`${label} must be greater than 0`);
  if (stroops > MAX_AMOUNT_STROOPS) invalid(`${label} exceeds the maximum Stellar amount 922337203685.4775807`);
  return value;
}

function checkAsset(input: unknown, label: string): Asset {
  if (input === undefined || input === "native" || input === "XLM") return Asset.native();
  try {
    if (typeof input === "object" && input !== null && typeof (input as Asset).getCode === "function") {
      const a = input as Asset;
      return a.isNative() ? Asset.native() : new Asset(a.getCode(), a.getIssuer());
    }
    if (typeof input === "object" && input !== null) {
      const { assetCode, assetIssuer } = input as { assetCode?: string; assetIssuer?: string };
      if (!assetCode || assetCode.toUpperCase() === "XLM") {
        if (assetIssuer) invalid(`${label}: XLM is native and has no issuer`);
        return Asset.native();
      }
      if (!assetIssuer || !StrKey.isValidEd25519PublicKey(assetIssuer)) {
        invalid(`${label}: "${assetCode}" needs a valid G… assetIssuer`);
      }
      return new Asset(assetCode, assetIssuer);
    }
  } catch (cause) {
    if (cause instanceof PresetError) throw cause;
    invalid(`${label}: ${(cause as Error)?.message ?? String(cause)}`);
  }
  return invalid(`${label} must be "native", an Asset, or { assetCode, assetIssuer }`);
}

function checkPrice(price: unknown): PresetPrice {
  if (typeof price === "string") {
    if (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) {
      invalid(`price must be a positive decimal string, got ${JSON.stringify(price)}`);
    }
    return price;
  }
  if (typeof price === "object" && price !== null) {
    const { n, d } = price as { n: unknown; d: unknown };
    if (Number.isInteger(n) && Number.isInteger(d) && (n as number) > 0 && (d as number) > 0 && (n as number) <= 2 ** 31 - 1 && (d as number) <= 2 ** 31 - 1) {
      return { n: n as number, d: d as number };
    }
  }
  return invalid("price must be a positive decimal string or { n, d } with positive int32 parts");
}

function checkContext(context: unknown): PresetContext {
  const ctx = context as PresetContext | undefined;
  if (!ctx || typeof ctx !== "object") invalid("a PresetContext { source, network } is required");
  if (typeof ctx.source !== "string" || !StrKey.isValidEd25519PublicKey(ctx.source)) {
    invalid(`context.source must be a valid G… public key, got ${JSON.stringify(ctx.source)}`);
  }
  if (ctx.network === undefined || ctx.network === null) invalid("context.network is required");
  return ctx;
}

function run(name: string, fn: () => ComposeBuilder): SorokitResult<ComposeBuilder> {
  try {
    return ok(fn());
  } catch (cause) {
    if (cause instanceof PresetError) {
      return err(SorokitErrorCode.VALIDATION, `presets.${name}: ${cause.message}`, cause);
    }
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `presets.${name}: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

function start(ctx: PresetContext): ComposeBuilder {
  return compose(ctx.source, ctx.network, ctx.options ?? {});
}

// ─── Presets ─────────────────────────────────────────────────────────────────

function simplePayment(
  destination: string,
  amount: string,
  asset: PresetAsset | undefined,
  context: PresetContext,
): SorokitResult<ComposeBuilder> {
  return run("simplePayment", () => {
    const ctx = checkContext(context);
    if (
      typeof destination !== "string" ||
      (!StrKey.isValidEd25519PublicKey(destination) && !StrKey.isValidMed25519PublicKey(destination))
    ) {
      invalid(`destination must be a valid G… or M… address, got ${JSON.stringify(destination)}`);
    }
    const resolved = checkAsset(asset, "asset");
    return start(ctx).addPayment({ destination, amount: checkAmount(amount, "amount"), asset: resolved });
  });
}

function swapAssets(
  sell: PresetAsset,
  buy: PresetAsset,
  price: PresetPrice,
  amount: string,
  context: PresetContext,
): SorokitResult<ComposeBuilder> {
  return run("swapAssets", () => {
    const ctx = checkContext(context);
    const selling = checkAsset(sell, "sell");
    const buying = checkAsset(buy, "buy");
    if (selling.equals(buying)) invalid("sell and buy must be different assets");
    return start(ctx).addManageOffer({
      selling,
      buying,
      price: checkPrice(price),
      amount: checkAmount(amount, "amount"),
    });
  });
}

function setupTrustline(
  asset: PresetAsset,
  limit: string | undefined,
  context: PresetContext,
): SorokitResult<ComposeBuilder> {
  return run("setupTrustline", () => {
    const ctx = checkContext(context);
    const resolved = checkAsset(asset, "asset");
    if (resolved.isNative()) invalid("XLM is native and does not need a trustline");
    if (resolved.getIssuer() === ctx.source) invalid("an issuer cannot hold a trustline to its own asset");
    return start(ctx).addTrustline({
      asset: resolved,
      ...(limit !== undefined ? { limit: checkAmount(limit, "limit") } : {}),
    });
  });
}

/**
 * Unbound presets: same arguments as {@link TransactionPresets}, plus the
 * {@link PresetContext} as the final argument.
 */
export const presets = Object.freeze({
  simplePayment,
  swapAssets,
  setupTrustline,
});

/**
 * Bind presets to a source account and network so they can be called with
 * the short signatures.
 */
export function createPresets(context: PresetContext): TransactionPresets {
  return Object.freeze({
    simplePayment: (destination: string, amount: string, asset?: PresetAsset) =>
      simplePayment(destination, amount, asset, context),
    swapAssets: (sell: PresetAsset, buy: PresetAsset, price: PresetPrice, amount: string) =>
      swapAssets(sell, buy, price, amount, context),
    setupTrustline: (asset: PresetAsset, limit?: string) => setupTrustline(asset, limit, context),
  });
}
