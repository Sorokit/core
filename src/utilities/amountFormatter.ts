import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export const DEFAULT_STROOP_DECIMALS = 7;

/**
 * Convert integer stroops to a human-readable asset amount string.
 * Default decimals is 7 (1 XLM = 10,000,000 stroops).
 *
 * @param stroops - Integer stroops as number, string, or bigint.
 * @param decimals - Custom decimal places (default: 7).
 * @returns SorokitResult<string> formatted decimal amount string.
 */
export function stroopsToAmount(
  stroops: number | string | bigint,
  decimals: number = DEFAULT_STROOP_DECIMALS,
): SorokitResult<string> {
  if (!Number.isInteger(decimals) || decimals < 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid decimals: ${decimals}. Decimals must be a non-negative integer.`,
    );
  }

  if (stroops === null || stroops === undefined) {
    return err(SorokitErrorCode.VALIDATION, "Stroops value cannot be null or undefined");
  }

  const str = String(stroops).trim();
  if (str === "") {
    return err(SorokitErrorCode.VALIDATION, "Stroops value cannot be empty");
  }

  if (!/^-?\d+$/.test(str)) {
    return err(SorokitErrorCode.VALIDATION, `Invalid stroops value: "${str}". Must be an integer.`);
  }

  const isNegative = str.startsWith("-");
  const absStr = isNegative ? str.slice(1) : str;

  if (decimals === 0) {
    return ok(isNegative && absStr !== "0" ? `-${absStr}` : absStr);
  }

  const padLength = decimals + 1;
  const padded = absStr.padStart(padLength, "0");
  const wholePart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");

  let result = fracPart.length > 0 ? `${wholePart}.${fracPart}` : wholePart;
  if (isNegative && result !== "0") {
    result = `-${result}`;
  }

  return ok(result);
}

/**
 * Convert a human-readable asset amount string or number to integer stroops.
 * Default decimals is 7 (1 XLM = 10,000,000 stroops).
 *
 * @param amount - Decimal amount as string or number.
 * @param decimals - Custom decimal places (default: 7).
 * @returns SorokitResult<number> stroops amount.
 */
export function amountToStroops(
  amount: number | string,
  decimals: number = DEFAULT_STROOP_DECIMALS,
): SorokitResult<number> {
  if (!Number.isInteger(decimals) || decimals < 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid decimals: ${decimals}. Decimals must be a non-negative integer.`,
    );
  }

  if (amount === null || amount === undefined) {
    return err(SorokitErrorCode.VALIDATION, "Amount value cannot be null or undefined");
  }

  if (typeof amount === "number" && (!Number.isFinite(amount) || Number.isNaN(amount))) {
    return err(SorokitErrorCode.VALIDATION, `Invalid amount number: ${amount}`);
  }

  const str = String(amount).trim();
  if (str === "") {
    return err(SorokitErrorCode.VALIDATION, "Amount value cannot be empty");
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(str)) {
    return err(SorokitErrorCode.VALIDATION, `Invalid amount format: "${str}"`);
  }

  const isNegative = str.startsWith("-");
  const absStr = isNegative ? str.slice(1) : str;
  const parts = absStr.split(".");
  const whole = parts[0] || "0";
  const frac = parts[1] || "";

  if (frac.length > decimals) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Amount "${str}" has ${frac.length} decimal places, exceeding allowed ${decimals}`,
    );
  }

  const paddedFrac = frac.padEnd(decimals, "0");
  const combined = `${whole}${paddedFrac}`;
  const stroopsBigInt = BigInt(combined);
  const finalBigInt = isNegative ? -stroopsBigInt : stroopsBigInt;

  return ok(Number(finalBigInt));
}
