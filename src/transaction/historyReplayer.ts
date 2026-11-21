import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { getTransactionStatus } from "./status";
import type { TransactionResult } from "./types";

export type ExpectedTransactionResult = Partial<
  Pick<TransactionResult, "status" | "ledger" | "resultXdr" | "envelopeXdr">
>;

/**
 * Reconstruct a past transaction from Horizon by hash. The returned object is
 * frozen so historical data cannot be mutated. Read-only: nothing is submitted.
 */
export async function replayTransaction(
  horizonUrl: string,
  txHash: string,
): Promise<SorokitResult<TransactionResult>> {
  const result = await getTransactionStatus(horizonUrl, txHash);
  if (result.status === "error") return result;
  return ok(Object.freeze({ ...result.data }));
}

/** Verify that a replayed transaction matches every provided expected field. */
export function verifyTransaction(
  tx: TransactionResult,
  expected: ExpectedTransactionResult,
): SorokitResult<TransactionResult> {
  const mismatched = (Object.keys(expected) as Array<keyof ExpectedTransactionResult>).filter(
    (k) => expected[k] !== undefined && tx[k] !== expected[k],
  );
  if (mismatched.length > 0) {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      `Transaction ${tx.hash} does not match expected: ${mismatched.join(", ")}`,
    );
  }
  return ok(tx);
}
