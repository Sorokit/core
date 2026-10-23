/**
 * Transaction size tracking and early-warning utility (#858).
 *
 * `TransactionBuilder.addOperation()` has no visibility into how large the
 * resulting transaction envelope is getting until the caller actually calls
 * `.build().toXDR()` and submits it, at which point an oversized transaction
 * is rejected by Horizon/the network with no earlier warning. This module
 * tracks operation count and estimated XDR byte size as operations are
 * added, so callers can be warned before they finish building.
 *
 * Thresholds used here:
 *   - `MAX_OPERATIONS` (100): Stellar's protocol-level hard limit on
 *     operations per transaction. Exceeding it always fails at submission.
 *   - `RECOMMENDED_MAX_OPERATIONS` (50): a conservative soft limit, well
 *     below the hard cap, left as headroom for fee-bump/signature overhead
 *     and to keep individual transactions easy to reason about.
 *   - `RECOMMENDED_MAX_BYTES` (5 * 1024): a conservative soft limit on
 *     estimated envelope size. Horizon's hard limit is higher, but staying
 *     well under it avoids edge cases around varint-length XDR padding for
 *     operations with large parameter payloads (e.g. manage_data, path
 *     payments with many hops).
 */

export const MAX_OPERATIONS = 100;
export const RECOMMENDED_MAX_OPERATIONS = 50;
export const RECOMMENDED_MAX_BYTES = 5 * 1024;

/** Rough per-operation XDR overhead used for estimation before a real build. */
const BASE_OPERATION_BYTES = 36;
/** Rough fixed overhead for the transaction envelope itself (source account, seq num, fee, memo header, signature slots). */
const BASE_ENVELOPE_BYTES = 96;

export interface TransactionSizeWarning {
  code: "OPERATION_COUNT_EXCEEDS_LIMIT" | "OPERATION_COUNT_ABOVE_RECOMMENDED" | "ESTIMATED_SIZE_ABOVE_RECOMMENDED";
  message: string;
}

export interface TransactionSizeSnapshot {
  operationCount: number;
  /** Rough estimated XDR byte size of the envelope at this point. Not exact — a real `.build().toXDR()` is authoritative. */
  estimatedBytes: number;
  warnings: TransactionSizeWarning[];
}

export interface TransactionSizeTrackerOptions {
  /** Operation count above which a soft warning is emitted. @default RECOMMENDED_MAX_OPERATIONS */
  recommendedMaxOperations?: number;
  /** Estimated byte size above which a soft warning is emitted. @default RECOMMENDED_MAX_BYTES */
  recommendedMaxBytes?: number;
  /** Optional custom logger to receive warnings as they're emitted. Defaults to `console.warn`. */
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
  };
}

/**
 * Rough per-operation byte estimate based on the number of top-level keys in
 * its params payload. This is intentionally conservative (an underestimate
 * for operations with deeply nested or large array params) — it exists to
 * give an early, directional warning, not to replace a real `toXDR()` size.
 */
function estimateOperationBytes(params: Record<string, unknown> | undefined): number {
  if (!params) return BASE_OPERATION_BYTES;
  let total = BASE_OPERATION_BYTES;
  for (const value of Object.values(params)) {
    if (typeof value === "string") total += value.length;
    else if (value instanceof Uint8Array || Buffer.isBuffer(value)) total += value.length;
    else total += 8;
  }
  return total;
}

/**
 * Tracks operation count and estimated size as operations are added to a
 * transaction, and emits a warning (via the configured logger, defaulting
 * to `console.warn`) the first time a threshold is crossed.
 *
 * @example
 * const tracker = new TransactionSizeTracker();
 * for (const op of plannedOperations) {
 *   tracker.addOperation(op.type, op.params);
 * }
 * if (tracker.snapshot().warnings.length > 0) {
 *   // surface to the caller before calling builder.build()
 * }
 */
export class TransactionSizeTracker {
  private operationCount = 0;
  private estimatedBytes: number;
  private readonly recommendedMaxOperations: number;
  private readonly recommendedMaxBytes: number;
  private readonly logger: { warn: (message: string, ...args: unknown[]) => void };
  private readonly warnedCodes = new Set<TransactionSizeWarning["code"]>();

  constructor(options: TransactionSizeTrackerOptions = {}) {
    this.recommendedMaxOperations = options.recommendedMaxOperations ?? RECOMMENDED_MAX_OPERATIONS;
    this.recommendedMaxBytes = options.recommendedMaxBytes ?? RECOMMENDED_MAX_BYTES;
    this.logger = options.logger ?? {
      warn: (message: string, ...args: unknown[]) => {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn(message, ...args);
        }
      },
    };
    this.estimatedBytes = BASE_ENVELOPE_BYTES;
  }

  /** Record that an operation was added, re-evaluating thresholds and warning on first crossing. */
  addOperation(type: string, params?: Record<string, unknown>): TransactionSizeSnapshot {
    this.operationCount += 1;
    this.estimatedBytes += estimateOperationBytes(params);
    return this.evaluate(type);
  }

  /** Current snapshot without recording a new operation. */
  snapshot(): TransactionSizeSnapshot {
    return {
      operationCount: this.operationCount,
      estimatedBytes: this.estimatedBytes,
      warnings: [],
    };
  }

  /** Reset the tracker to track a fresh transaction. */
  reset(): void {
    this.operationCount = 0;
    this.estimatedBytes = BASE_ENVELOPE_BYTES;
    this.warnedCodes.clear();
  }

  private evaluate(lastOperationType: string): TransactionSizeSnapshot {
    const warnings: TransactionSizeWarning[] = [];

    if (this.operationCount > MAX_OPERATIONS) {
      warnings.push(this.emitOnce(
        "OPERATION_COUNT_EXCEEDS_LIMIT",
        `Transaction has ${this.operationCount} operations, exceeding the protocol limit of ${MAX_OPERATIONS}. ` +
          `This transaction will be rejected at submission.`,
      ));
    } else if (this.operationCount > this.recommendedMaxOperations) {
      warnings.push(this.emitOnce(
        "OPERATION_COUNT_ABOVE_RECOMMENDED",
        `Transaction has ${this.operationCount} operations (recommended max ${this.recommendedMaxOperations}) ` +
          `after adding "${lastOperationType}". Consider splitting into multiple transactions.`,
      ));
    }

    if (this.estimatedBytes > this.recommendedMaxBytes) {
      warnings.push(this.emitOnce(
        "ESTIMATED_SIZE_ABOVE_RECOMMENDED",
        `Transaction's estimated envelope size is ~${this.estimatedBytes} bytes ` +
          `(recommended max ${this.recommendedMaxBytes}) after adding "${lastOperationType}".`,
      ));
    }

    return {
      operationCount: this.operationCount,
      estimatedBytes: this.estimatedBytes,
      warnings,
    };
  }

  /** Emit a warning via the logger the first time this code is seen; return it every time regardless so `snapshot()`/`addOperation()` stay queryable. */
  private emitOnce(code: TransactionSizeWarning["code"], message: string): TransactionSizeWarning {
    if (!this.warnedCodes.has(code)) {
      this.warnedCodes.add(code);
      this.logger.warn(`[sorokit] TransactionSizeTracker: ${message}`);
    }
    return { code, message };
  }
}

export function createTransactionSizeTracker(options?: TransactionSizeTrackerOptions): TransactionSizeTracker {
  return new TransactionSizeTracker(options);
}
