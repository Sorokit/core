/**
 * Transaction queue with prioritized scheduling and batch submission.
 *
 * Supports multiple priority levels (low, normal, high, critical), automatic
 * scheduling of eligible transactions, grouping compatible submissions, and
 * preservation of ordering for dependent transactions.
 */

import { err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCategory, SorokitErrorCode } from "../shared/response";

/**
 * Transaction priority level.
 */
export type TransactionPriority = "low" | "normal" | "high" | "critical";

/**
 * Queue item status.
 */
export type QueueItemStatus = "pending" | "processing" | "completed" | "failed";

/**
 * Queued transaction.
 */
export interface QueuedTransaction {
  /** Unique transaction identifier */
  id: string;
  /** Transaction envelope XDR */
  envelopeXdr: string;
  /** Priority level */
  priority: TransactionPriority;
  /** Current status */
  status: QueueItemStatus;
  /** Dependencies on other transaction IDs */
  dependsOn?: string[];
  /** When this transaction was queued (Unix milliseconds) */
  queuedAt: number;
  /** When processing started (Unix milliseconds) */
  processingStartedAt?: number;
  /** When processing completed (Unix milliseconds) */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Number of retry attempts */
  retryCount: number;
  /** Maximum retry attempts allowed */
  maxRetries: number;
  /** Result hash if transaction was submitted successfully */
  resultHash?: string;
}

/**
 * Queue state snapshot.
 */
export interface QueueState {
  /** Pending transactions waiting to be processed */
  pending: number;
  /** Transactions currently being processed */
  processing: number;
  /** Successfully completed transactions */
  completed: number;
  /** Failed transactions */
  failed: number;
}

/**
 * Batch submission result.
 */
export interface BatchSubmissionResult {
  /** Batch identifier */
  batchId: string;
  /** Transaction IDs included in this batch */
  transactionIds: string[];
  /** Submission timestamp */
  submittedAt: number;
  /** Individual transaction results */
  results: Map<string, { success: boolean; hash?: string; error?: string }>;
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  /** Maximum retry attempts per transaction */
  maxRetries: number;
  /** Delay between retries in milliseconds */
  retryDelayMs: number;
  /** Exponential backoff multiplier for retries */
  backoffMultiplier?: number;
}

/**
 * Queue configuration options.
 */
export interface TransactionQueueConfig {
  /** Maximum batch size for submission */
  batchSize?: number;
  /** Scheduling interval in milliseconds */
  schedulingIntervalMs?: number;
  /** Retry policy for failed transactions */
  retryPolicy?: RetryPolicy;
  /** Maximum queue size before rejecting new items */
  maxQueueSize?: number;
}

// Default configuration
const DEFAULT_CONFIG: Required<TransactionQueueConfig> = {
  batchSize: 10,
  schedulingIntervalMs: 5000,
  retryPolicy: {
    maxRetries: 3,
    retryDelayMs: 1000,
    backoffMultiplier: 2,
  },
  maxQueueSize: 1000,
};

/**
 * Transaction queue with priority scheduling.
 *
 * Manages transaction submissions with configurable priorities, automatic
 * batching, retry logic, and dependency tracking.
 */
export class TransactionQueue {
  private queue: Map<string, QueuedTransaction> = new Map();
  private config: Required<TransactionQueueConfig>;
  private processingScheduleId?: NodeJS.Timeout;
  private batchCounter: number = 0;

  /**
   * Create a new transaction queue.
   *
   * @param config - Queue configuration (optional)
   */
  constructor(config?: TransactionQueueConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a transaction to the queue.
   *
   * @param id - Unique transaction ID
   * @param envelopeXdr - Transaction envelope XDR
   * @param priority - Priority level (default: "normal")
   * @param dependsOn - Optional dependency on other transaction IDs
   * @returns Queue item or error
   */
  enqueue(
    id: string,
    envelopeXdr: string,
    priority: TransactionPriority = "normal",
    dependsOn?: string[],
  ): SorokitResult<QueuedTransaction> {
    try {
      // Check for duplicates
      if (this.queue.has(id)) {
        return err({
          code: SorokitErrorCode.INVALID_CONFIG,
          message: "Transaction with this ID already exists in queue",
          category: SorokitErrorCategory.VALIDATION,
          context: {
            operation: "enqueue",
            parameters: { id },
          },
        });
      }

      // Check queue size limit
      if (this.queue.size >= this.config.maxQueueSize) {
        return err({
          code: SorokitErrorCode.TX_SUBMIT_FAILED,
          message: "Queue is full",
          category: SorokitErrorCategory.TRANSACTION,
          context: {
            operation: "enqueue",
            parameters: { queueSize: this.queue.size },
          },
        });
      }

      // Validate dependencies exist
      if (dependsOn) {
        for (const depId of dependsOn) {
          if (!this.queue.has(depId)) {
            return err({
              code: SorokitErrorCode.INVALID_CONFIG,
              message: `Dependency transaction ${depId} not found in queue`,
              category: SorokitErrorCategory.VALIDATION,
              context: {
                operation: "enqueue",
                parameters: { id, dependsOn },
              },
            });
          }
        }
      }

      const transaction: QueuedTransaction = {
        id,
        envelopeXdr,
        priority,
        status: "pending",
        dependsOn,
        queuedAt: Date.now(),
        retryCount: 0,
        maxRetries: this.config.retryPolicy.maxRetries,
      };

      this.queue.set(id, transaction);
      return ok(transaction);
    } catch (error) {
      return err({
        code: SorokitErrorCode.INTERNAL,
        message: "Failed to enqueue transaction",
        category: SorokitErrorCategory.INTERNAL,
        cause: error,
      });
    }
  }

  /**
   * Get current queue state.
   *
   * @returns Queue state with counts
   */
  getState(): QueueState {
    let pending = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const tx of this.queue.values()) {
      switch (tx.status) {
        case "pending":
          pending++;
          break;
        case "processing":
          processing++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    return { pending, processing, completed, failed };
  }

  /**
   * Get next batch of transactions ready to submit.
   *
   * Returns transactions ordered by priority, excluding those with
   * unsatisfied dependencies.
   *
   * @returns Array of queued transactions
   */
  getNextBatch(): QueuedTransaction[] {
    const batch: QueuedTransaction[] = [];
    const processed = new Set<string>();

    // Sort by priority (critical > high > normal > low)
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    const sortedTxs = Array.from(this.queue.values())
      .filter((tx) => tx.status === "pending")
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    for (const tx of sortedTxs) {
      // Check if dependencies are satisfied
      if (tx.dependsOn) {
        const allDependenciesMet = tx.dependsOn.every((depId) => {
          const depTx = this.queue.get(depId);
          return depTx?.status === "completed";
        });

        if (!allDependenciesMet) {
          continue;
        }
      }

      if (batch.length < this.config.batchSize) {
        batch.push(tx);
        processed.add(tx.id);
      }
    }

    return batch;
  }

  /**
   * Mark a transaction as completed.
   *
   * @param id - Transaction ID
   * @param resultHash - Optional transaction result hash
   * @returns Success or error
   */
  markCompleted(id: string, resultHash?: string): SorokitResult<void> {
    const tx = this.queue.get(id);
    if (!tx) {
      return err({
        code: SorokitErrorCode.TX_NOT_FOUND,
        message: `Transaction ${id} not found in queue`,
        category: SorokitErrorCategory.TRANSACTION,
      });
    }

    tx.status = "completed";
    tx.completedAt = Date.now();
    if (resultHash) {
      tx.resultHash = resultHash;
    }

    return ok(undefined);
  }

  /**
   * Mark a transaction as failed and potentially retry.
   *
   * @param id - Transaction ID
   * @param error - Error message
   * @returns Success, retry scheduled, or error
   */
  markFailed(id: string, error: string): SorokitResult<"retry" | "failed"> {
    const tx = this.queue.get(id);
    if (!tx) {
      return err({
        code: SorokitErrorCode.TX_NOT_FOUND,
        message: `Transaction ${id} not found in queue`,
        category: SorokitErrorCategory.TRANSACTION,
      });
    }

    tx.error = error;
    tx.retryCount++;

    if (tx.retryCount < tx.maxRetries) {
      tx.status = "pending";
      return ok("retry");
    }

    tx.status = "failed";
    return ok("failed");
  }

  /**
   * Get a specific transaction from the queue.
   *
   * @param id - Transaction ID
   * @returns Queued transaction or undefined
   */
  get(id: string): QueuedTransaction | undefined {
    return this.queue.get(id);
  }

  /**
   * Cancel a transaction in the queue.
   *
   * Removes pending transactions (cannot cancel processing/completed ones).
   *
   * @param id - Transaction ID
   * @returns Success or error
   */
  cancel(id: string): SorokitResult<void> {
    const tx = this.queue.get(id);
    if (!tx) {
      return err({
        code: SorokitErrorCode.TX_NOT_FOUND,
        message: `Transaction ${id} not found in queue`,
        category: SorokitErrorCategory.TRANSACTION,
      });
    }

    if (tx.status !== "pending") {
      return err({
        code: SorokitErrorCode.INVALID_CONFIG,
        message: "Can only cancel pending transactions",
        category: SorokitErrorCategory.VALIDATION,
      });
    }

    this.queue.delete(id);
    return ok(undefined);
  }

  /**
   * Clear all transactions from the queue.
   *
   * Optionally filter by status.
   *
   * @param status - Filter by status (optional)
   */
  clear(status?: QueueItemStatus): void {
    if (!status) {
      this.queue.clear();
    } else {
      for (const [id, tx] of this.queue.entries()) {
        if (tx.status === status) {
          this.queue.delete(id);
        }
      }
    }
  }

  /**
   * Start automatic scheduling (for testing).
   *
   * @param submissionFn - Function to call for batch submission
   */
  startScheduling(
    submissionFn: (batch: QueuedTransaction[]) => Promise<BatchSubmissionResult>,
  ): void {
    if (this.processingScheduleId) return;

    this.processingScheduleId = setInterval(() => {
      const batch = this.getNextBatch();
      if (batch.length > 0) {
        // Mark as processing
        for (const tx of batch) {
          tx.status = "processing";
          tx.processingStartedAt = Date.now();
        }

        submissionFn(batch).catch((error) => {
          for (const tx of batch) {
            this.markFailed(tx.id, error.message);
          }
        });
      }
    }, this.config.schedulingIntervalMs);
  }

  /**
   * Stop automatic scheduling.
   */
  stopScheduling(): void {
    if (this.processingScheduleId) {
      clearInterval(this.processingScheduleId);
      this.processingScheduleId = undefined;
    }
  }
}
