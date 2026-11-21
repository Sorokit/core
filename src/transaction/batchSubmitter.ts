import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import { submitTransaction } from "./submitTransaction";
import type { TransactionResult } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BatchTransactionStatusCode = "pending" | "success" | "failed";
export type TransactionBatchStatus = BatchTransactionStatusCode;

export interface BatchTransactionStatus {
  /** The original signed XDR submitted */
  xdr: string;
  status: BatchTransactionStatusCode;
  /** Populated from TransactionResult.hash on success */
  hash?: string;
  /** Populated from SorokitError.message on failure */
  error?: string;
  ledger?: number;
  envelopeXdr?: string;
  resultXdr?: string;
  /** Unix ms timestamp when this transaction's submission attempt(s) began (#839) */
  submittedAtMs?: number;
  /** Unix ms timestamp when the transaction reached a final status (#839) */
  confirmedAtMs?: number;
  /** Number of submission attempts made for this transaction (#839) */
  attemptCount?: number;
}

export interface BatchSubmissionResult {
  /** true iff all transactions succeeded */
  ok: boolean;
  summary: "all_success" | "all_failed" | "partial_success";
  /** Count of entries with status === "success" */
  succeeded: number;
  /** Count of entries with status === "failed" */
  failed: number;
  transactions: BatchTransactionStatus[];
  /** Compatibility metadata for callers that compose a batch before submission. */
  status?: "all_success" | "all_failed" | "partial_success";
  submitted?: number;
  atomic?: boolean;
  rollbackOnFailure?: boolean;
}

export interface BatchConfig {
  horizonUrl: string;
  networkPassphrase: string;
  /**
   * "sequential" (default) processes XDRs one at a time in order.
   * "parallel" fires all requests concurrently with Promise.allSettled.
   */
  mode?: "sequential" | "parallel";
  /** Optional cache passed through to submitTransaction */
  cache?: SorokitCache;
  atomic?: boolean;
  rollbackOnFailure?: boolean;
}

export interface BatchSubmissionOptions extends Partial<BatchConfig> {
  atomic?: boolean;
  rollbackOnFailure?: boolean;
  continueOnError?: boolean;
  timeout?: number;
}

export type RetryStrategy = "none" | "retry_failed" | "retry_all";

export interface RollbackInstruction {
  xdr: string;
  hash?: string;
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyResult(
  entry: BatchTransactionStatus,
  result: SorokitResult<TransactionResult>,
): void {
  if (result.status === "ok") {
    entry.status = "success";
    entry.hash = result.data.hash;
    if (result.data.ledger !== undefined) entry.ledger = result.data.ledger;
    if (result.data.envelopeXdr !== undefined) entry.envelopeXdr = result.data.envelopeXdr;
    if (result.data.resultXdr !== undefined) entry.resultXdr = result.data.resultXdr;
  } else {
    entry.status = "failed";
    entry.error = result.error.message;
  }
  entry.confirmedAtMs = Date.now();
}

/** Submit one entry, recording timing metadata (#839). */
async function submitEntry(
  entry: BatchTransactionStatus,
  horizonUrl: string,
  networkPassphrase: string,
  cache: SorokitCache | undefined,
): Promise<SorokitResult<TransactionResult>> {
  entry.submittedAtMs = Date.now();
  entry.attemptCount = (entry.attemptCount ?? 0) + 1;
  return submitTransaction(horizonUrl, networkPassphrase, entry.xdr, cache);
}

function buildSummary(entries: BatchTransactionStatus[]): BatchSubmissionResult {
  const succeeded = entries.filter((e) => e.status === "success").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  let summary: BatchSubmissionResult["summary"];
  if (failed === 0) {
    summary = "all_success";
  } else if (succeeded === 0) {
    summary = "all_failed";
  } else {
    summary = "partial_success";
  }
  return {
    ok: summary === "all_success",
    summary,
    succeeded,
    failed,
    transactions: entries,
  };
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Submit a batch of signed transaction XDRs to the Stellar network.
 *
 * By default (mode: "sequential") XDRs are submitted one at a time in order —
 * the safe default for transactions sharing a source account, where sequence
 * numbers must be incremented in order.
 *
 * With mode: "parallel", all XDRs are submitted concurrently via
 * Promise.allSettled — suitable for independent transactions from different
 * source accounts.
 *
 * Failed individual submissions set status: "failed" on the corresponding
 * entry and do not abort the rest of the batch.
 *
 * @param transactions     - Array of signed transaction XDRs to submit.
 * @param config           - Horizon URL, network passphrase, mode, and optional cache.
 * @returns `ok(BatchSubmissionResult)` on completion (even with partial failures),
 *          or `err(TX_SUBMIT_FAILED)` when the input is invalid.
 */
export async function submitBatch(
  transactions: string[],
  config: BatchSubmissionOptions = {},
): Promise<SorokitResult<BatchSubmissionResult>> {
  // Input validation
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "transactions must be a non-empty array",
    );
  }
  const hasHorizonUrl = typeof config.horizonUrl === "string" && config.horizonUrl.trim().length > 0;
  const hasNetworkPassphrase = typeof config.networkPassphrase === "string" && config.networkPassphrase.trim().length > 0;
  if (hasHorizonUrl !== hasNetworkPassphrase) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "config.horizonUrl and config.networkPassphrase must both be non-empty strings when provided",
    );
  }
  if (config.horizonUrl !== undefined && !hasHorizonUrl || config.networkPassphrase !== undefined && !hasNetworkPassphrase) {
    return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon URL and network passphrase must be non-empty strings.");
  }

  for (let i = 0; i < transactions.length; i++) {
    if (typeof transactions[i] !== "string" || transactions[i]!.length === 0) {
      return err(SorokitErrorCode.INVALID_TRANSACTION, `Transaction at index ${i} must be a non-empty XDR string`);
    }
  }

  const entries: BatchTransactionStatus[] = transactions.map((xdr) => ({
    xdr,
    status: hasHorizonUrl ? "pending" : "success",
  }));

  const horizonUrl = config.horizonUrl ?? "";
  const networkPassphrase = config.networkPassphrase ?? "";

  if (hasHorizonUrl && config.mode === "parallel") {
    // Submit all concurrently and collect results
    const results = await Promise.allSettled(
      entries.map((entry) =>
        submitEntry(entry, horizonUrl, networkPassphrase, config.cache),
      ),
    );
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as BatchTransactionStatus;
      const settled = results[i] as PromiseSettledResult<SorokitResult<TransactionResult>>;
      if (settled.status === "fulfilled") {
        applyResult(entry, settled.value);
      } else {
        entry.status = "failed";
        entry.error =
          settled.reason instanceof Error
            ? (settled.reason as Error).message
            : String(settled.reason);
        entry.confirmedAtMs = Date.now();
      }
    }
  } else if (hasHorizonUrl) {
    // Sequential (default): submit one at a time in order
    for (const entry of entries) {
      const result = await submitEntry(entry, horizonUrl, networkPassphrase, config.cache);
      applyResult(entry, result);
    }
  }

  const summary = buildSummary(entries);
  return ok({ ...summary, status: summary.summary, submitted: transactions.length, atomic: config.atomic ?? false, rollbackOnFailure: config.rollbackOnFailure ?? false });
}

/**
 * Returns true only when every transaction in the batch succeeded.
 * Stellar does not natively support atomic multi-transaction batches,
 * so "atomic" here means "all or nothing from the caller's perspective".
 */
export function wasAtomicExecuted(result: BatchSubmissionResult): SorokitResult<boolean> {
  return ok((result.status ?? result.summary) === "all_success");
}

/**
 * Recommends a retry strategy based on the submission outcome.
 * - "none"         — all succeeded; nothing to retry.
 * - "retry_failed" — partial success; only failed entries should be retried.
 * - "retry_all"    — all failed; re-submit the entire batch.
 */
export function suggestRetryStrategy(result: BatchSubmissionResult): SorokitResult<{ strategy: RetryStrategy; failedIndices: number[] }> {
  const summary = result.status ?? result.summary;
  const strategy: RetryStrategy = summary === "all_success"
    ? "none"
    : summary === "all_failed" ? "retry_all" : "retry_failed";
  const failedIndices = result.transactions.flatMap((tx, index) => tx.status === "failed" ? [index] : []);
  return ok({ strategy, failedIndices });
}

/**
 * Returns one RollbackInstruction per *successful* transaction in the batch
 * when at least one transaction failed (partial failure scenario).
 * If all transactions succeeded or all failed, returns an empty array
 * (nothing to roll back in either clean case).
 */
export function generateRollbackInstructions(
  result: BatchSubmissionResult,
): SorokitResult<RollbackInstruction[]> {
  if ((result.status ?? result.summary) !== "partial_success") return ok([]);
  return ok(result.transactions
    .filter((tx) => tx.status === "success")
    .map((tx) => {
      const instruction: RollbackInstruction = {
        xdr: tx.xdr,
        reason:
          "Transaction succeeded but batch partially failed — manual reversal may be required.",
      };
      if (tx.hash !== undefined) instruction.hash = tx.hash;
      return instruction;
    }));
}

/** Read the status for a transaction in a completed batch. */
export function getTransactionStatus(
  result: BatchSubmissionResult,
  transactionIndex: number,
): SorokitResult<BatchTransactionStatus> {
  const transaction = result?.transactions?.[transactionIndex];
  if (!transaction) {
    return err(SorokitErrorCode.VALIDATION, `Transaction index ${transactionIndex} out of range`);
  }
  return ok(transaction);
}
