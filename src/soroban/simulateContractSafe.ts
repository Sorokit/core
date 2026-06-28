import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { simulateTransaction } from "./simulateTransaction";
import type { SimulateTransactionOptions } from "./simulateTransaction";
import type { SimulateTransactionResult } from "./types";

export interface SimulateContractSafeOptions extends SimulateTransactionOptions {
  /** When true, simulation failures resolve to a fallback result instead of an error. */
  allowFail?: boolean;
  /** Fee in stroops returned when simulation fails and allowFail is set. */
  fallbackFee?: string;
}

export interface SafeSimulationResult extends SimulateTransactionResult {
  /** True when the underlying simulation succeeded; false when fallback kicked in. */
  fromFallback: boolean;
}

const DEFAULT_FALLBACK_FEE = "100000";

/**
 * Wrap simulateTransaction with graceful degradation.
 *
 * - Returns the live simulation result when it succeeds.
 * - When the underlying simulation errors (network/RPC) or returns
 *   `success: false`, and `allowFail` is true, resolves to a fallback
 *   result built from `fallbackFee` (or a sane default).
 * - When `allowFail` is false, propagates the original error.
 */
export async function simulateContractSafe(
  rpcUrl: string,
  networkPassphrase: string,
  transactionXdr: string,
  options?: SimulateContractSafeOptions,
): Promise<SorokitResult<SafeSimulationResult>> {
  const allowFail = options?.allowFail ?? false;
  const fallbackFee = options?.fallbackFee ?? DEFAULT_FALLBACK_FEE;

  const result = await simulateTransaction(rpcUrl, networkPassphrase, transactionXdr, options);

  if (result.status === "ok") {
    if (result.data.success) {
      return ok({ ...result.data, fromFallback: false });
    }
    if (allowFail) {
      return ok({
        success: true,
        fee: fallbackFee,
        error: result.data.error,
        fromFallback: true,
      });
    }
    return ok({ ...result.data, fromFallback: false });
  }

  if (allowFail) {
    return ok({
      success: true,
      fee: fallbackFee,
      error: result.error.message,
      fromFallback: true,
    });
  }

  return result;
}
