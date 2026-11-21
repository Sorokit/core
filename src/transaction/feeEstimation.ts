import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { PROTOCOL_BASE_FEE } from "./feePolicy";
import { MAX_OPERATIONS_PER_TRANSACTION } from "./validateTransaction";

/** Default network base rate: 100 stroops per operation (0.00001 XLM). */
export const DEFAULT_BASE_RATE_STROOPS = PROTOCOL_BASE_FEE;

const STROOPS_PER_XLM = 10_000_000n;

export interface EstimatedFee {
  /** Number of operations the estimate was computed for. */
  operationCount: number;
  /** Per-operation base rate used, in stroops. */
  baseRate: number;
  /** Estimated total fee in stroops, as a string (exact, never a float). */
  stroops: string;
  /** Estimated total fee in XLM with 7 decimal places, as a string. */
  xlm: string;
}

function formatXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/**
 * Estimate the fee for a transaction from its operation count.
 *
 * Stellar charges a flat per-operation rate, so the formula is:
 *
 *     fee (stroops) = operationCount × baseRate
 *
 * `baseRate` defaults to 100 stroops (the network minimum). 1 XLM is
 * 10,000,000 stroops. This is a local calculation: it does not query the
 * network, so it cannot see surge pricing. A rate below the current network
 * base fee produces an estimate the network would reject with
 * `tx_insufficient_fee`; for live fees use `estimateFee` instead.
 *
 * Returns `VALIDATION` when `operationCount` is not an integer from 1 to 100
 * or `baseRate` is not a positive integer.
 *
 * @example
 * estimateFeeByOperationCount(3);      // 300 stroops, "0.0000300" XLM
 * estimateFeeByOperationCount(3, 250); // 750 stroops, "0.0000750" XLM
 */
export function estimateFeeByOperationCount(
  operationCount: number,
  baseRate: number = DEFAULT_BASE_RATE_STROOPS,
): SorokitResult<EstimatedFee> {
  if (
    typeof operationCount !== "number" ||
    !Number.isInteger(operationCount) ||
    operationCount < 1 ||
    operationCount > MAX_OPERATIONS_PER_TRANSACTION
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `operationCount must be an integer between 1 and ${MAX_OPERATIONS_PER_TRANSACTION}, got ${String(operationCount)}.`,
    );
  }
  if (
    typeof baseRate !== "number" ||
    !Number.isSafeInteger(baseRate) ||
    baseRate < 1
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `baseRate must be a positive integer number of stroops, got ${String(baseRate)}.`,
    );
  }

  const total = BigInt(operationCount) * BigInt(baseRate);
  return ok({
    operationCount,
    baseRate,
    stroops: total.toString(),
    xlm: formatXlm(total),
  });
}
