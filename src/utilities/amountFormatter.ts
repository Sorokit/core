/**
 * Exact fixed-point conversion utilities between stroops (base integer units)
 * and human-readable decimal asset amounts (#962).
 *
 * Uses pure BigInt decimal arithmetic so conversions never suffer IEEE-754
 * floating-point rounding drift. No locale formatting is performed here
 * (see `shared/amountFormatter.ts` for locale-aware display formatting).
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Default decimal places for native XLM and classic Stellar assets (1 XLM = 10^7 stroops). */
export const STROOPS_DECIMALS = 7;

/** Maximum supported custom decimal precision (covers Soroban 18-decimal tokens and beyond). */
export const MAX_SUPPORTED_DECIMALS = 38;

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const INTEGER_PATTERN = /^\d+$/;

export interface AmountConversionOptions {
  /**
   * Number of decimal places separating one whole token from its smallest base
   * unit. Defaults to `7` (1 XLM = 10,000,000 stroops).
   */
  decimals?: number;
  /**
   * When `true` (default), strips trailing fractional zeros (e.g. `"1.5000000"` -> `"1.5"`,
   * `"1.0000000"` -> `"1"`). Set `false` to preserve fixed decimal padding.
   */
  trimTrailingZeros?: boolean;
}

function resolveOptions(
  optionsOrDecimals?: number | AmountConversionOptions,
): SorokitResult<{ decimals: number; trimTrailingZeros: boolean }> {
  const decimals =
    typeof optionsOrDecimals === "number"
      ? optionsOrDecimals
      : (optionsOrDecimals?.decimals ?? STROOPS_DECIMALS);

  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_SUPPORTED_DECIMALS
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `decimals — must be an integer between 0 and ${MAX_SUPPORTED_DECIMALS}, got ${String(decimals)}.`,
    );
  }

  const trimTrailingZeros =
    typeof optionsOrDecimals === "object" && optionsOrDecimals !== null
      ? (optionsOrDecimals.trimTrailingZeros ?? true)
      : true;

  return ok({ decimals, trimTrailingZeros });
}

function parseAmountToBaseUnits(
  amount: string | number,
  decimals: number,
): SorokitResult<bigint> {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `amount — numeric amount must be finite, got ${String(amount)}.`,
      );
    }
    if (amount < 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        `amount — "${amount}" cannot be negative.`,
      );
    }
    const asText = String(amount);
    if (/[eE]/.test(asText)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `amount — numeric amount ${asText} uses exponent notation; pass a decimal string for very large or very small values to avoid precision loss.`,
      );
    }
    return parseAmountToBaseUnits(asText, decimals);
  }

  if (typeof amount !== "string") {
    return err(
      SorokitErrorCode.VALIDATION,
      "amount — must be a decimal string or finite number.",
    );
  }

  const trimmed = amount.trim();
  if (trimmed.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "amount — cannot be empty.",
    );
  }

  if (trimmed.startsWith("-")) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" cannot be negative.`,
    );
  }

  const unsigned = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (!DECIMAL_PATTERN.test(unsigned)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" is not a valid plain decimal amount.`,
    );
  }

  const [rawWhole = "0", rawFraction = ""] = unsigned.split(".");
  const wholePart = rawWhole.length === 0 ? "0" : rawWhole;

  if (rawFraction.length > decimals) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" has ${rawFraction.length} decimal places, exceeding the configured precision of ${decimals}.`,
    );
  }

  const scale = 10n ** BigInt(decimals);
  const paddedFraction =
    decimals === 0 ? "0" : rawFraction.padEnd(decimals, "0");
  const baseUnits = BigInt(wholePart) * scale + BigInt(paddedFraction);

  return ok(baseUnits);
}

/**
 * Convert an integer stroop (base-unit) value into a plain decimal asset amount string.
 *
 * Accepts `string`, `number`, or `bigint` stroop values so callers can format
 * arbitrarily large ledger/Soroban balances without floating-point rounding.
 *
 * @param stroops - Non-negative integer base units (`10_000_000` stroops = `"1"` XLM at 7 decimals).
 * @param optionsOrDecimals - Custom decimal places (`0`–`38`, default `7`) or options object.
 */
export function stroopsToAmount(
  stroops: string | number | bigint,
  optionsOrDecimals?: number | AmountConversionOptions,
): SorokitResult<string> {
  const resolved = resolveOptions(optionsOrDecimals);
  if (resolved.status === "error") return resolved;
  const { decimals, trimTrailingZeros } = resolved.data;

  let units: bigint;
  if (typeof stroops === "bigint") {
    if (stroops < 0n) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — "${stroops.toString()}" cannot be negative.`,
      );
    }
    units = stroops;
  } else if (typeof stroops === "number") {
    if (!Number.isFinite(stroops) || !Number.isInteger(stroops)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — must be a finite integer, got ${String(stroops)}.`,
      );
    }
    if (stroops < 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — "${stroops}" cannot be negative.`,
      );
    }
    if (!Number.isSafeInteger(stroops)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — ${stroops} exceeds Number.MAX_SAFE_INTEGER; pass a string or bigint to preserve exact stroop precision.`,
      );
    }
    units = BigInt(stroops);
  } else if (typeof stroops === "string") {
    const trimmed = stroops.trim();
    if (trimmed.length === 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "stroops — cannot be empty.",
      );
    }
    if (trimmed.startsWith("-")) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — "${trimmed}" cannot be negative.`,
      );
    }
    const unsigned = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    if (!INTEGER_PATTERN.test(unsigned)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `stroops — "${trimmed}" must be a non-negative integer string.`,
      );
    }
    units = BigInt(unsigned);
  } else {
    return err(
      SorokitErrorCode.VALIDATION,
      "stroops — must be a string, integer number, or bigint.",
    );
  }

  if (decimals === 0) {
    return ok(units.toString());
  }

  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0");

  if (!trimTrailingZeros) {
    return ok(`${whole.toString()}.${fraction}`);
  }

  const trimmedFraction = fraction.replace(/0+$/, "");
  return ok(
    trimmedFraction.length > 0
      ? `${whole.toString()}.${trimmedFraction}`
      : whole.toString(),
  );
}

/**
 * Convert a human-readable asset amount into integer stroops as a JavaScript `number`.
 *
 * Uses exact decimal string parsing rather than floating-point multiplication
 * (avoiding classic IEEE-754 drift such as `19.99 * 1e7 === 199899999.99999997`).
 * Rejects results exceeding `Number.MAX_SAFE_INTEGER` so an inexact `number`
 * is never silently returned; use {@link amountToStroopsString} for int64/u128
 * amounts above `900,719,925.4740991` XLM.
 *
 * @param amount - Non-negative decimal string or finite number (e.g. `"1.5"` or `1.5`).
 * @param optionsOrDecimals - Custom decimal places (`0`–`38`, default `7`) or options object.
 */
export function amountToStroops(
  amount: string | number,
  optionsOrDecimals?: number | Pick<AmountConversionOptions, "decimals">,
): SorokitResult<number> {
  const resolved = resolveOptions(optionsOrDecimals);
  if (resolved.status === "error") return resolved;

  const baseUnits = parseAmountToBaseUnits(amount, resolved.data.decimals);
  if (baseUnits.status === "error") return baseUnits;

  if (baseUnits.data > MAX_SAFE_INTEGER_BIGINT) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — converted value (${baseUnits.data.toString()} base units) exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); use amountToStroopsString for lossless large-amount conversion.`,
    );
  }

  return ok(Number(baseUnits.data));
}

/**
 * Lossless string variant of {@link amountToStroops} for full Stellar int64
 * (`922337203685.4775807` XLM) and Soroban i128/u128 token amounts that exceed
 * `Number.MAX_SAFE_INTEGER`.
 */
export function amountToStroopsString(
  amount: string | number,
  optionsOrDecimals?: number | Pick<AmountConversionOptions, "decimals">,
): SorokitResult<string> {
  const resolved = resolveOptions(optionsOrDecimals);
  if (resolved.status === "error") return resolved;

  const baseUnits = parseAmountToBaseUnits(amount, resolved.data.decimals);
  if (baseUnits.status === "error") return baseUnits;

  return ok(baseUnits.data.toString());
}
