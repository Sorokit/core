const STROOPS_PER_XLM = 10_000_000n;
const SCALE_DIGITS = 7;

function asDecimal(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Amount must be finite");
    return value.toString();
  }
  return value.trim();
}

function parseScaled(value: string | number): bigint {
  const text = asDecimal(value);
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new RangeError(`Invalid amount: ${text}`);
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > SCALE_DIGITS) {
    throw new RangeError("Amount supports at most 7 decimal places");
  }
  const scaled = BigInt(whole || "0") * STROOPS_PER_XLM + BigInt((fraction + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS) || "0");
  return negative ? -scaled : scaled;
}

function formatScaled(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Convert an XLM decimal amount to exact integer stroops. */
export function xlmToStroops(amount: string | number): bigint {
  return parseScaled(amount);
}

/** Convert integer stroops to a canonical XLM decimal string. */
export function stroopsToXlm(stroops: bigint | string | number): string {
  const value = typeof stroops === "bigint" ? stroops : BigInt(String(stroops));
  return formatScaled(value);
}

export function addAmounts(left: string | number, right: string | number): string {
  return formatScaled(parseScaled(left) + parseScaled(right));
}

export function subtractAmounts(left: string | number, right: string | number): string {
  return formatScaled(parseScaled(left) - parseScaled(right));
}

export function multiplyAmount(amount: string | number, multiplier: string | number): string {
  const factor = parseScaled(multiplier);
  return formatScaled((parseScaled(amount) * factor) / STROOPS_PER_XLM);
}

/** Divide using half-up rounding at the stroop boundary. */
export function divideAmount(amount: string | number, divisor: string | number): string {
  const numerator = parseScaled(amount) * STROOPS_PER_XLM;
  const denominator = parseScaled(divisor);
  if (denominator === 0n) throw new RangeError("Cannot divide an amount by zero");
  const sign = (numerator < 0n) === (denominator < 0n) ? 1n : -1n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const rounded = (absoluteNumerator + absoluteDenominator / 2n) / absoluteDenominator;
  return formatScaled(sign * rounded);
}

export const STROOPS_PER_XLM_NUMBER = Number(STROOPS_PER_XLM);
