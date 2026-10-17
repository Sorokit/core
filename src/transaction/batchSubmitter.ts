/**
 * Batch transaction submission with rollback on failure (#589).
 *
 * Two call shapes are supported:
 *
 * 1. **Submission mode** — pass `horizonUrl` and `networkPassphrase`. Each XDR is
 *    submitted through `submitTransaction` and per-transaction results are
 *    reported (`summary`, per-entry `status`/`hash`/`error`).
 * 2. **Planning mode** — no `horizonUrl` supplied. The batch is planned and
 *    reported without contacting Horizon.
 *
 * Independent Stellar transactions are **not** atomic and cannot be rolled back
 * by the SDK: when a batch partially fails, `generateRollbackInstructions`
 * describes the compensating work an operator must perform manually. It never
 * reverses an already-submitted transaction.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { TransactionResult } from "./types";
import { submitTransaction } from "./submitTransaction";

/**
 * Status of a single transaction in a batch.
 */
export type TransactionBatchStatus =
  | "pending"
  | "submitted"
  | "success"
  | "failed"
  | "rolled_back"
  | "skipped";

/**
 * Aggregate outcome of a batch submission.
 */
export type BatchSummary = "all_success" | "partial_success" | "all_failed" | "planned";

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
  /** Horizon endpoint used to submit each XDR. Omit for planning mode. */
  horizonUrl?: string;
  /** Network passphrase used to submit each XDR. Required with `horizonUrl`. */
  networkPassphrase?: string;
  /** Submission order. Defaults to `"sequential"`. */
  mode?: "sequential" | "parallel";
  /** Optional cache forwarded to `submitTransaction`. */
  cache?: SorokitCache;
}

/**
 * Result of batch submission containing per-transaction status.
 *
 * `status` is the legacy aggregate field; `summary`/`ok` are the explicit
 * per-transaction reporting fields added alongside it.
 */
export interface BatchSubmissionResult {
  submitted: number;
  succeeded: number;
  failed: number;
  /** Entries not attempted because a prior failure stopped the batch. */
  skipped?: number;
  status: BatchSummary;
  /** Which call shape produced this result. */
  mode?: "planning" | "submission";
  summary?: BatchSummary;
  ok?: boolean;
  transactions: BatchTransactionStatus[];
  rollbackInstructions?: string[];
  atomic: boolean;
  atomicSupported: boolean;
  rollbackOnFailure: boolean;
}

/**
 * A single compensating-work instruction for a transaction that already
 * succeeded inside a partially failed batch.
 */
export interface RollbackInstruction {
  xdr: string;
  hash?: string | undefined;
  reason: string;
}

/**
 * Submit multiple transactions in batch with best-effort semantics.
 *
 * @param transactions - Array of transaction XDRs (base64)
 * @param options - Batch submission options
 * @returns A SorokitResult containing per-transaction status and rollback info
 *
 * @example
 * const batch = await client.transaction.submitBatch([tx1, tx2, tx3], {
 *   horizonUrl,
 *   networkPassphrase,
 * });
 * // { summary: "all_success", succeeded: 3, failed: 0, transactions: [...] }
 */
export type BatchPlanningOptions = Omit<
  BatchSubmissionOptions,
  "horizonUrl" | "networkPassphrase" | "cache"
> & { horizonUrl?: never; networkPassphrase?: never };

export function submitBatch(
  transactions: string[],
  options: BatchSubmissionOptions & {
    horizonUrl: string;
    networkPassphrase: string;
  },
): Promise<SorokitResult<BatchSubmissionResult>>;
export function submitBatch(
  transactions: string[],
  options?: BatchPlanningOptions,
): SorokitResult<BatchSubmissionResult>;
export function submitBatch(
  transactions: string[],
  options: BatchSubmissionOptions = {},
): SorokitResult<BatchSubmissionResult> | Promise<
  SorokitResult<BatchSubmissionResult>
> {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "Transactions array must be non-empty",
    );
  }

  for (let i = 0; i < transactions.length; i++) {
    const entry: unknown = transactions[i];
    if (!entry || typeof entry !== "string") {
      return err(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        `Transaction at index ${i} must be a non-empty XDR string`,
      );
    }
  }

  const atomic = options.atomic ?? false;
  const rollbackOnFailure = options.rollbackOnFailure ?? false;

  if (options.horizonUrl === undefined) {
    // Planning mode: no submission target configured, nothing is sent.
    const batchStatus: BatchTransactionStatus[] = transactions.map((xdr) => ({
      xdr,
      status: "pending",
    }));

    return ok({
      mode: "planning",
      submitted: 0,
      succeeded: 0,
      failed: 0,
      status: "planned",
      atomicSupported: false,
      transactions: batchStatus,
      atomic,
      rollbackOnFailure,
    });
  }

  const horizonUrl = options.horizonUrl;
  if (typeof horizonUrl !== "string" || horizonUrl.length === 0) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "horizonUrl must be a non-empty string",
    );
  }

  const networkPassphrase = options.networkPassphrase;
  if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "networkPassphrase must be a non-empty string",
    );
  }

  if (atomic) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "atomic batch submission is not supported: independent Stellar transactions cannot be committed or rolled back atomically",
    );
  }

  if (options.mode === "parallel" && options.continueOnError === false) {
    return err(
      SorokitErrorCode.VALIDATION,
      'continueOnError: false cannot be honoured with mode: "parallel": submissions start concurrently, so no entry can be skipped. Use mode: "sequential" for stop-on-first-failure semantics.',
    );
  }

  return submitBatchThroughHorizon(
    transactions,
    horizonUrl,
    networkPassphrase,
    atomic,
    rollbackOnFailure,
    options,
  );
}

/**
 * Submit every XDR through `submitTransaction`, collecting per-transaction
 * results. Failures never short-circuit the batch.
 */
async function submitBatchThroughHorizon(
  transactions: string[],
  horizonUrl: string,
  networkPassphrase: string,
  atomic: boolean,
  rollbackOnFailure: boolean,
  options: BatchSubmissionOptions,
): Promise<SorokitResult<BatchSubmissionResult>> {
  const entries: BatchTransactionStatus[] = transactions.map((xdr) => ({
    xdr,
    status: "pending",
  }));

  const submitOne = async (index: number): Promise<void> => {
    const xdr = transactions[index];
    if (xdr === undefined) return;

    const timeoutMs = options.timeout && options.timeout > 0 ? options.timeout : 0;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (
      timeoutMs > 0
        ? submitTransaction(horizonUrl, networkPassphrase, xdr, options.cache, {
            signal: controller.signal,
          })
        : submitTransaction(horizonUrl, networkPassphrase, xdr, options.cache)
    ).catch((error: unknown) => {
      if (timedOut) {
        return err<TransactionResult>(
          SorokitErrorCode.TX_SUBMIT_FAILED,
          `submission timed out after ${timeoutMs}ms and was aborted; the outcome is unknown, so do not auto-retry this signed XDR`,
        );
      }
      return err<TransactionResult>(
        SorokitErrorCode.TX_SUBMIT_FAILED,
        error instanceof Error ? error.message : String(error),
      );
    });
    let result: Awaited<ReturnType<typeof submitTransaction>>;
    if (timeoutMs > 0) {
      const timeout = new Promise<Awaited<ReturnType<typeof submitTransaction>>>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve(
            err<TransactionResult>(
              SorokitErrorCode.TX_SUBMIT_FAILED,
              `submission timed out after ${timeoutMs}ms and was aborted; the outcome is unknown, so do not auto-retry this signed XDR`,
            ),
          );
        }, timeoutMs);
      });
      result = await Promise.race([attempt, timeout]);
    } else {
      result = await attempt;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (result.status === "ok") {
      entries[index] = { xdr, status: "success", hash: result.data.hash };
      return;
    }

    entries[index] = {
      xdr,
      status: "failed",
      error: result.error.message,
    };
  };

  const stopOnError = options.continueOnError === false;

  if (options.mode === "parallel") {
    await Promise.all(transactions.map((_, index) => submitOne(index)));
  } else {
    for (let index = 0; index < transactions.length; index++) {
      await submitOne(index);
      if (stopOnError && entries[index]?.status === "failed") {
        for (let rest = index + 1; rest < entries.length; rest++) {
          entries[rest] = { xdr: transactions[rest] ?? "", status: "skipped" };
        }
        break;
      }
    }
  }

  const succeeded = entries.filter((entry) => entry.status === "success").length;
  const skipped = entries.filter((entry) => entry.status === "skipped").length;
  const failed = entries.length - succeeded - skipped;
  const summary: BatchSummary =
    failed === 0
      ? "all_success"
      : succeeded === 0 && skipped === 0
        ? "all_failed"
        : "partial_success";

  return ok({
    mode: "submission",
    submitted: entries.length,
    succeeded,
    failed,
    skipped,
    status: summary,
    summary,
    ok: summary === "all_success",
    transactions: entries,
    atomic: false,
    atomicSupported: false,
    rollbackOnFailure,
  });
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

  const transaction = batchResult.transactions[transactionIndex];
  if (!transaction) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Transaction index ${transactionIndex} out of range`,
    );
  }

  return ok(transaction);
}

/* --- pre-#808 public helper contract (single signature, SorokitResult) --- */

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

/** Structured retry guidance for the explicit (non-legacy) helper API. */
export type RetryStrategy = "none" | "retry_all" | "retry_failed";


/** Summary of a batch result across the legacy and #808 result shapes. */
function batchSummary(batchResult: BatchSubmissionResult): BatchSummary {
  return batchResult.summary ?? batchResult.status;
}

/** Structured rollback instructions (explicit API; not a rollback guarantee). */
export function buildRollbackInstructions(batchResult: BatchSubmissionResult): RollbackInstruction[] {
  if (batchSummary(batchResult) !== "partial_success") {
    return [];
  }

  return batchResult.transactions
    .filter((tx) => tx.status === "success")
    .map((tx) => ({
      xdr: tx.xdr,
      hash: tx.hash,
      reason: `Compensating action required for ${tx.hash ?? tx.xdr}`,
    }));
}

/** True only when every transaction in the batch reported success. */
export function isBatchAtomicComplete(batchResult: BatchSubmissionResult): boolean {
  return batchSummary(batchResult) === "all_success";
}

/** Retry guidance for the explicit helper API. */
export function recommendRetryStrategy(batchResult: BatchSubmissionResult): RetryStrategy {
  const summary = batchSummary(batchResult);
  if (summary === "all_failed") return "retry_all";
  if (summary === "partial_success") return "retry_failed";
  return "none";
}
