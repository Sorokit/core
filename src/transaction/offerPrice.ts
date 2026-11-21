/**
 * Price-ratio sanity checks for DEX offers.
 *
 * Stellar offer prices are expressed as "units of buying asset per unit of
 * selling asset". A price that is accidentally inverted or off by orders of
 * magnitude can still produce a valid transaction, but the offer will either
 * never fill or fill at a disastrous rate. These helpers warn before that
 * happens without blocking advanced use cases.
 */

/** Offer price as a decimal string or a rational numerator/denominator pair. */
export type OfferPrice = string | { n: number; d: number };

/** Inclusive warning bounds for an offer price ratio. */
export interface OfferPriceWarningRange {
  /** Lower bound. Values below this warn. Defaults to 0.001. */
  min?: number;
  /** Upper bound. Values above this warn. Defaults to 1000. */
  max?: number;
}

/** Options for {@link warnOnExtremeOfferPrice}. */
export interface OfferPriceWarningOptions {
  /** Suppress the warning for intentionally extreme prices. */
  suppress?: boolean;
  /** Override the default warning bounds. */
  range?: OfferPriceWarningRange;
  /** Label included in the warning, e.g. "Offer price (XLM/USDC)". */
  context?: string;
}

/** Minimum typical offer price. Prices below this trigger a warning. */
export const DEFAULT_MIN_OFFER_PRICE = 0.001;

/** Maximum typical offer price. Prices above this trigger a warning. */
export const DEFAULT_MAX_OFFER_PRICE = 1000;

/**
 * Convert an offer price to its numeric ratio.
 *
 * Returns `null` for malformed, non-positive, or non-finite prices. Rational
 * prices must have a positive numerator and denominator.
 */
export function getOfferPriceRatio(price: OfferPrice): number | null {
  if (typeof price === "string") {
    const value = Number(price.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (
    typeof price !== "object" ||
    price === null ||
    !Number.isFinite(price.n) ||
    !Number.isFinite(price.d) ||
    price.n <= 0 ||
    price.d <= 0
  ) {
    return null;
  }

  const value = price.n / price.d;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Warn when an offer price falls outside the typical range.
 *
 * Defaults to warning below 0.001 or above 1000. The warning is advisory: it
 * never throws or rejects the offer. Set `suppress` to true (or expose the
 * corresponding `suppressPriceWarnings` parameter) for deliberate extreme
 * prices. Returns the parsed ratio, or `null` when the price is malformed.
 */
export function warnOnExtremeOfferPrice(
  price: OfferPrice,
  options?: OfferPriceWarningOptions,
): number | null {
  const ratio = getOfferPriceRatio(price);
  if (ratio === null || options?.suppress === true) return ratio;

  const min = options?.range?.min ?? DEFAULT_MIN_OFFER_PRICE;
  const max = options?.range?.max ?? DEFAULT_MAX_OFFER_PRICE;
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < 0 ||
    max <= 0 ||
    min > max
  ) {
    return ratio;
  }

  if (ratio >= min && ratio <= max) return ratio;

  const label =
    typeof price === "string" ? price : `${price.n}/${price.d}`;
  const context = options?.context ?? "Offer price";
  console.warn(
    `[sorokit] ${context} ${label} is outside the typical range ` +
      `[${min}, ${max}]. Double-check that the selling and buying assets are ` +
      "not inverted and that the price scale is intentional. Set " +
      "suppressPriceWarnings: true to disable this warning.",
  );

  return ratio;
}
