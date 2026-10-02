/**
 * Locale-aware amount formatting (#616).
 *
 * Converts a raw stroop amount into a human-readable string, honoring the
 * asset's decimal precision (7 for a classic Stellar asset; a configurable
 * `decimals` for anything else, e.g. a Soroban token) and the caller's
 * locale via `Intl.NumberFormat` rather than hand-rolled grouping/decimal
 * separator logic.
 */

import { err, ok, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";
import { STROOPS_PER_XLM, validateStroop } from "./amountValidation";
import type { TokenAsset } from "./validateToken";

/** Decimal precision Stellar classic assets (XLM and issued assets alike) use. */
export const DEFAULT_ASSET_DECIMALS = 7;

export interface FormatAmountOptions {
  /**
   * The asset the amount is denominated in. Only `decimals` (if provided via
   * the asset registry, see assetRegistry.ts) and the symbol lookup use
   * this; formatting itself works from `decimals`/`symbol` below when given
   * directly, so this field is optional.
   */
  asset?: TokenAsset;
  /** BCP 47 locale tag, e.g. "en-US", "de-DE". Defaults to "en-US". */
  locale?: string;
  /** Whether to append the asset's symbol/code after the number. Default: false. */
  showSymbol?: boolean;
  /** Explicit symbol to display when `showSymbol` is true; defaults to `asset.code` or "XLM". */
  symbol?: string;
  /**
   * Decimal precision of the input amount. Defaults to 7 (Stellar classic
   * stroop precision). Pass a token's own decimals for a Soroban asset
   * whose amount isn't stroop-denominated.
   */
  decimals?: number;
  /** Minimum fraction digits to always show, e.g. 2 for "10.00". Defaults to 2. */
  minimumFractionDigits?: number;
  /** Maximum fraction digits to show; excess precision is rounded. Defaults to `decimals`. */
  maximumFractionDigits?: number;
}

function isValidLocale(locale: string): boolean {
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a raw integer amount (stroops, by default) into a locale-formatted
 * decimal string, optionally suffixed with a symbol.
 *
 * @example
 * formatAmount("1000000000", { locale: "en-US", showSymbol: true });
 * // "100.00 XLM" - 1_000_000_000 stroops / 10^7 = 100 XLM
 *
 * @example
 * formatAmount("1000000000", { locale: "de-DE" });
 * // "100,00" - German grouping/decimal separators
 */
export function formatAmount(
  rawAmount: string | number | bigint,
  options: FormatAmountOptions = {},
): SorokitResult<string> {
  const decimals = options.decimals ?? DEFAULT_ASSET_DECIMALS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) {
    return err(
      SorokitErrorCode.VALIDATION,
      `decimals must be an integer between 0 and 20, got ${decimals}.`,
    );
  }

  const stroopValidation = validateStroop(
    typeof rawAmount === "bigint" ? rawAmount : rawAmount,
  );
  if (stroopValidation.status === "error") return stroopValidation;

  const units = BigInt(stroopValidation.data);
  const divisor = decimals === 7 ? STROOPS_PER_XLM : 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = units % divisor;

  // Build the exact decimal value as a string first (avoids float precision
  // loss for amounts beyond Number.MAX_SAFE_INTEGER), then hand it to
  // Intl.NumberFormat purely for locale-appropriate grouping/decimal
  // separators and digit padding/rounding.
  const fractionStr = fraction.toString().padStart(decimals, "0");
  const exactValue = decimals > 0 ? `${whole}.${fractionStr}` : whole.toString();

  const locale = options.locale ?? "en-US";
  if (!isValidLocale(locale)) {
    return err(SorokitErrorCode.VALIDATION, `Invalid locale: "${locale}".`);
  }

  const minimumFractionDigits = options.minimumFractionDigits ?? 2;
  const maximumFractionDigits = Math.max(
    options.maximumFractionDigits ?? decimals,
    minimumFractionDigits,
  );

  let formatted: string;
  try {
    formatted = formatExactDecimal(
      whole,
      fractionStr,
      locale,
      minimumFractionDigits,
      maximumFractionDigits,
    );
  } catch (cause) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Failed to format amount "${exactValue}" for locale "${locale}".`,
      cause,
    );
  }

  if (!options.showSymbol) return ok(formatted);

  const symbol = options.symbol ?? options.asset?.code ?? "XLM";
  return ok(`${formatted} ${symbol}`);
}

/**
 * Renders `whole` (grouped via Intl.NumberFormat's exact BigInt support, so
 * arbitrarily large amounts never round-trip through a float) followed by
 * the locale's own decimal separator and a rounded/padded fraction.
 *
 * Number(bigDecimalString) would lose precision for amounts beyond
 * Number.MAX_SAFE_INTEGER (Stellar's own int64 stroop range comfortably
 * exceeds that), so the whole and fractional parts are formatted
 * separately: BigInt.prototype.toLocaleString-equivalent grouping for the
 * integer part via Intl.NumberFormat (which accepts bigint exactly), and
 * manual decimal-separator insertion for the fraction using a value
 * Intl.NumberFormat itself reports via formatToParts.
 */
function formatExactDecimal(
  whole: bigint,
  fractionDigits: string,
  locale: string,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): string {
  const groupedWhole = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(whole);

  if (maximumFractionDigits === 0) return groupedWhole;

  const roundedFraction = roundFractionDigits(fractionDigits, maximumFractionDigits);
  const padded = roundedFraction.digits.padEnd(maximumFractionDigits, "0");
  const trimmedToMax = padded.slice(0, maximumFractionDigits);

  let shownFraction = trimmedToMax;
  while (shownFraction.length > minimumFractionDigits && shownFraction.endsWith("0")) {
    shownFraction = shownFraction.slice(0, -1);
  }

  const decimalSeparator = new Intl.NumberFormat(locale)
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ".";

  const finalWhole = roundedFraction.carry
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole + 1n)
    : groupedWhole;

  return shownFraction.length > 0
    ? `${finalWhole}${decimalSeparator}${shownFraction}`
    : finalWhole;
}

/**
 * Rounds a fractional-digit string (no leading "0.") to `precision` digits,
 * half-up, returning whether rounding carried into the whole part (e.g.
 * "995" rounded to 2 digits is "100" with carry=true, meaning the caller's
 * whole part must be incremented).
 */
function roundFractionDigits(
  digits: string,
  precision: number,
): { digits: string; carry: boolean } {
  if (digits.length <= precision) {
    return { digits, carry: false };
  }
  const kept = digits.slice(0, precision);
  const roundingDigit = digits.charCodeAt(precision) - 48; // "0".charCodeAt(0)
  if (roundingDigit < 5) {
    return { digits: kept, carry: false };
  }
  // Half-up rounding, propagated across all `precision` digits.
  const asNumber = BigInt(kept || "0") + 1n;
  const roundedStr = asNumber.toString();
  if (roundedStr.length > kept.length) {
    // Rounding overflowed the kept digits (e.g. "99" -> "100"): carries into
    // the whole part, and the fractional part becomes all zeros.
    return { digits: "0".repeat(precision), carry: true };
  }
  return { digits: roundedStr.padStart(precision, "0"), carry: false };
}
