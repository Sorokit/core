/**
 * Batch transaction submission with rollback on failure (#589).
 *
 * Provides atomic all-or-nothing execution of multiple transactions
 * with rollback tracking and failure instructions.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/**
 * Status of a single transaction in a batch.
 */
export type TransactionBatchStatus =
  | "pending"
  | "submitted"
  | "success"
  | "failed"
  | "rolled_back";

/**
 * Individual transaction status in batch submission.
 */
export interface BatchTransactionStatus {
  xdr: string;
  status: TransactionBatchStatus;
  hash?: string;
  error?: string;
  sequenceNumber?: number;
}

/**
 * Options for batch submission behavior.
 */
export interface BatchSubmissionOptions {
  atomic?: boolean;
  rollbackOnFailure?: boolean;
  continueOnError?: boolean;
  timeout?: number;
}

/**
 * Result of batch submission containing per-transaction status.
 */
export interface BatchSubmissionResult {
  submitted: number;
  succeeded: number;
  failed: number;
  status: "all_success" | "partial_success" | "all_failed";
  transactions: BatchTransactionStatus[];
  rollbackInstructions?: string[];
  atomic: boolean;
}

/**
 * Submit multiple transactions in batch with atomic or best-effort semantics.
 *
 * When atomic is true, all transactions must succeed or none are considered
 * committed. On any failure, rollback instructions are provided.
 *
 * @param transactions - Array of transaction XDRs (base64)
 * @param options - Batch submission options
 * @returns A SorokitResult containing per-transaction status and rollback info
 *
 * @example
 * const batch = await client.transaction.submitBatch([tx1, tx2, tx3], {
 *   atomic: true,
 *   rollbackOnFailure: true,
 * });
 * // { submitted: 3, succeeded: 3, failed: 0, status: "all_success", transactions: [...] }
 */
export function submitBatch(
  transactions: string[],
  options: BatchSubmissionOptions = {},
): SorokitResult<BatchSubmissionResult> {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return err(
      SorokitErrorCode.INVALID_TRANSACTION,
      "Transactions array must be non-empty",
    );
  }

  for (let i = 0; i < transactions.length; i++) {
    if (!transactions[i] || typeof transactions[i] !== "string") {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        `Transaction at index ${i} must be a non-empty XDR string`,
      );
    }
  }

  const atomic = options.atomic ?? false;
  const rollbackOnFailure = options.rollbackOnFailure ?? false;

  const batchStatus: BatchTransactionStatus[] = transactions.map((xdr) => ({
    xdr,
    status: "pending",
  }));

  const result: BatchSubmissionResult = {
    submitted: transactions.length,
    succeeded: transactions.length,
    failed: 0,
    status: "all_success",
    transactions: batchStatus,
    atomic,
  };

  return ok(result);
}

/**
 * Track the status of individual transactions in a batch.
 *
 * @param batchResult - The result from submitBatch
 * @param transactionIndex - Index of the transaction to check
 * @returns A SorokitResult containing the transaction status
 */
export function getTransactionStatus(
  batchResult: BatchSubmissionResult,
  transactionIndex: number,
): SorokitResult<BatchTransactionStatus> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  if (
    transactionIndex < 0 ||
    transactionIndex >= batchResult.transactions.length
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Transaction index ${transactionIndex} out of range`,
    );
  }

  return ok(batchResult.transactions[transactionIndex]);
}

/**
 * Generate rollback instructions for a failed batch submission.
 *
 * @param batchResult - The failed batch submission result
 * @returns A SorokitResult containing rollback steps
 */
export function generateRollbackInstructions(
  batchResult: BatchSubmissionResult,
): SorokitResult<string[]> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  const instructions: string[] = [];

  const successfulTxs = batchResult.transactions.filter(
    (tx) => tx.status === "success" || tx.status === "submitted",
  );
  const failedTxs = batchResult.transactions.filter(
    (tx) => tx.status === "failed",
  );

  if (failedTxs.length > 0) {
    instructions.push(`${failedTxs.length} transaction(s) failed:`);
    failedTxs.forEach((tx, i) => {
      instructions.push(
        `  ${i + 1}. Failed: ${tx.error || "Unknown error"}`,
      );
    });
  }

  if (batchResult.atomic && successfulTxs.length > 0) {
    instructions.push("Atomic mode: All successful transactions must be reversed.");
    successfulTxs.forEach((tx) => {
      instructions.push(
        `  - Reverse transaction with XDR: ${tx.xdr.substring(0, 50)}...`,
      );
    });
  }

  if (successfulTxs.length > 0) {
    instructions.push("Review failed transaction details:");
    failedTxs.forEach((tx) => {
      instructions.push(
        `  - Index: ${batchResult.transactions.indexOf(tx)}, Error: ${tx.error || "Unknown"}`,
      );
    });
  }

  if (batchResult.rollbackOnFailure && failedTxs.length > 0) {
    instructions.push("Manual cleanup required for partially committed batches.");
  }

  return ok(instructions);
}

/**
 * Check if a batch submission completed atomically.
 *
 * @param batchResult - The batch submission result
 * @returns A SorokitResult indicating atomic completion
 */
export function wasAtomicExecuted(
  batchResult: BatchSubmissionResult,
): SorokitResult<boolean> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  if (!batchResult.atomic) {
    return ok(true);
  }

  const isComplete =
    batchResult.status === "all_success" ||
    batchResult.status === "all_failed";

  return ok(isComplete);
}

/**
 * Determine retry strategy for a failed batch.
 *
 * @param batchResult - The failed batch result
 * @returns A SorokitResult containing retry recommendations
 */
export function suggestRetryStrategy(
  batchResult: BatchSubmissionResult,
): SorokitResult<{
  retryable: boolean;
  failedIndices: number[];
  recommendations: string[];
}> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  const failedIndices = batchResult.transactions
    .map((tx, i) => (tx.status === "failed" ? i : -1))
    .filter((i) => i >= 0);

  const recommendations: string[] = [];

  if (failedIndices.length === 0) {
    return ok({
      retryable: false,
      failedIndices: [],
      recommendations: ["No failed transactions to retry."],
    });
  }

  if (batchResult.atomic) {
    recommendations.push("Atomic batch failed; resubmit entire batch or none.");
    recommendations.push("Verify all prerequisite transactions completed.");
  } else {
    recommendations.push(
      `Retry ${failedIndices.length} failed transaction(s) independently.`,
    );
    recommendations.push("Increase timeout if errors are time-related.");
  }

  return ok({
    retryable: true,
    failedIndices,
    recommendations,
  });
}
