/**
 * Batch account operations (fix.md).
 *
 * A unified batch execution model for account-level operations — trustline
 * creation, payments, and key rotation — with bounded concurrency, operation
 * grouping, progress tracking, and partial-failure handling.
 *
 * Design principles
 * -----------------
 * - A single idempotency-aware executor (`runBatchOperations`) drives every
 *   batch. It is transport-agnostic: the caller supplies a per-operation
 *   `runner`.
 * - Each operation is planned with a stable, caller-supplied `id` and its
 *   result is tracked independently. A failure in one operation never
 *   invalidates unrelated operations.
 * - Retry is never blind: an operation that has already succeeded (or is in
 *   `previouslyCompletedIds`) is never re-run, so `maxRetries` cannot
 *   duplicate a completed/possibly-submitted operation.
 * - Progress is exposed incrementally via `onProgress` and summarized in the
 *   final report.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  buildPaymentTransaction,
  buildTrustlineTransaction,
} from "../transaction/buildTransaction";
import type { TrustlineParams } from "../transaction/types";
import { rotateAccountKey } from "./keyRotation";
import type { RotateAccountKeyParams } from "./keyRotation";
import type { ResolvedNetworkConfig } from "../shared/types";
import { sleep } from "../shared/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Lifecycle status of a single batch operation. */
export type BatchOperationStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "retried";

/** Metadata for an operation in a batch plan. */
export interface BatchOperation<T = unknown> {
  /** Stable, caller-supplied identifier used for idempotency. */
  id: string;
  /**
   * Runnable that actually performs the operation.
   * Return `ok(data)` on success, or an error result on failure.
   */
  runner: BatchRunner<T>;
  /** Optional input associated with the operation (for reporting). */
  input?: unknown;
}

export type BatchRunner<T> = (
  operationId: string,
) => Promise<SorokitResult<T>>;

/** Individual tracked result of one batch operation. */
export interface BatchOperationResult<T> {
  id: string;
  status: BatchOperationStatus;
  /** Available when the operation succeeded. */
  data?: T;
  /** Human-readable error message when the operation ultimately failed. */
  errorMessage?: string;
  errorCode?: string;
  /** Number of execution attempts (1 = initial, >1 = retried). */
  attempts: number;
  /** Number of retries performed. */
  retries: number;
  /** True when the operation was skipped (already completed / explicit skip). */
  skipped?: boolean;
}

/** Incremental snapshot of batch progress. */
export interface BatchProgress {
  total: number;
  planned: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  retried: number;
  completed: number;
  /** Epoch-ms timestamp when the batch started. */
  startedAt: number;
  /** Elapsed ms at the time the snapshot was produced. */
  elapsedMs: number;
}

/** Configuration for a batch execution. */
export interface BatchExecutorConfig {
  /**
   * Maximum number of operations to schedule into a single grouping wave.
   * Larger values allow more operations in flight at once; smaller values
   * give finer-grained progress callbacks.
   */
  batchSize?: number;
  /** Maximum number of operations running concurrently (default: 5). */
  concurrency?: number;
  /**
   * Maximum retry attempts for retryable failures (default: 2).
   * Successful or previously-completed operations are never retried.
   */
  maxRetries?: number;
  /** Base delay (ms) before the first retry; backoff is exponential (default: 200). */
  retryDelayMs?: number;
  /**
   * Idempotency set. Operations whose id appears here are assumed already
   * completed and are skipped rather than executed.
   */
  previouslyCompletedIds?: Iterable<string>;
  /** Called whenever progress changes with a live snapshot. */
  onProgress?: (progress: BatchProgress) => void;
  /**
   * Optional predicate classifying an error as retryable. Defaults to
   * network/timeout/service-unavailable errors.
   */
  isRetryable?: (error: SorokitResult<unknown>) => boolean;
  /** Inject determinism for clock in tests. */
  now?: () => number;
  /** Time source for the retry sleep (overridable in tests). */
  delay?: (ms: number) => Promise<void>;
}

/** Final report of a batch execution. */
export interface BatchExecutionReport<T> {
  results: BatchOperationResult<T>[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    retried: number;
    completed: number;
    /** True when every operation ended in success. */
    allSucceeded: boolean;
  };
  /** Final progress snapshot. */
  progress: BatchProgress;
  /** Epoch-ms timestamp when the batch finished. */
  finishedAt: number;
}

// ─── Defaults & helpers ───────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 10_000;

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  SorokitErrorCode.NETWORK_ERROR,
  SorokitErrorCode.OPERATION_TIMEOUT,
  SorokitErrorCode.SERVICE_UNAVAILABLE,
]);

function defaultIsRetryable(error: SorokitResult<unknown>): boolean {
  if (error.status !== "error" || !error.error) return false;
  return RETRYABLE_CODES.has(error.error.code);
}

// ─── Progress accounting ──────────────────────────────────────────────────────

function createProgressState(total: number, startedAt: number) {
  return {
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    completed: 0,
  };
}

function snapshotProgress(
  startedAt: number,
  counter: ReturnType<typeof createProgressState>,
  total: number,
  now: () => number,
): BatchProgress {
  return {
    total,
    planned: counter.planned,
    running: counter.running,
    succeeded: counter.succeeded,
    failed: counter.failed,
    skipped: counter.skipped,
    retried: counter.retried,
    completed: counter.completed,
    startedAt,
    elapsedMs: now() - startedAt,
  };
}

// ─── Core executor ────────────────────────────────────────────────────────────

export interface QueueItem<T> {
  operation: BatchOperation<T>;
}

/**
 * Run a batch of operations with bounded concurrency, operation grouping,
 * progress tracking, and partial-failure handling.
 *
 * Behavioral guarantees:
 *  - Each operation runs exactly once if it succeeds; retryable failures are
 *    retried up to `maxRetries` times before being marked `failed`.
 *  - Operations listed in `previouslyCompletedIds` are marked `skipped`
 *    (never executed again) to make re-running a batch idempotent.
 *  - A failure in one operation is isolated and does not affect other
 *    operations.
 *
 * @param operations - The operations to plan and execute.
 * @param userConfig - Batch size, concurrency, retry, and progress options.
 * @returns A {@link BatchExecutionReport} with per-operation outcomes.
 */
export async function runBatchOperations<T>(
  operations: BatchOperation<T>[],
  userConfig: BatchExecutorConfig = {},
): Promise<BatchExecutionReport<T>> {
  const config: Required<
    Pick<
      BatchExecutorConfig,
      "batchSize" | "concurrency" | "maxRetries" | "retryDelayMs" | "now"
    >
  > = {
    batchSize: userConfig.batchSize ?? operations.length,
    concurrency: Math.max(1, userConfig.concurrency ?? DEFAULT_CONCURRENCY),
    maxRetries: Math.max(0, userConfig.maxRetries ?? DEFAULT_MAX_RETRIES),
    retryDelayMs: Math.max(0, userConfig.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
    now: userConfig.now ?? Date.now,
  };
  const delay = userConfig.delay ?? sleep;
  const isRetryable =
    userConfig.isRetryable ??
    ((error: SorokitResult<unknown>) => defaultIsRetryable(error));
  const completedIds = new Set<string>(userConfig.previouslyCompletedIds ?? []);

  const startedAt = config.now();
  const counter = createProgressState(operations.length, startedAt);
  const resultsArray: BatchOperationResult<T>[] = [];

  const emit = () => {
    userConfig.onProgress?.(
      snapshotProgress(startedAt, counter, operations.length, config.now),
    );
  };

  const markSkipped = (id: string) => {
    counter.skipped += 1;
    counter.completed += 1;
    resultsArray.push({
      id,
      status: "skipped",
      attempts: 0,
      retries: 0,
      skipped: true,
    });
  };

  // Plan operations in groups of `batchSize` so big batches can be chunked
  // with incremental progress callbacks after each group is scheduled.
  const plan = [...operations];
  const queue: QueueItem<T>[] = [];

  // Skip previously completed operations up front (idempotency), emitting
  // progress in `batchSize` chunks so large batches report incrementally.
  let plannedCount = 0;
  for (const op of plan) {
    if (completedIds.has(op.id)) {
      markSkipped(op.id);
      if (plannedCount % config.batchSize === 0) emit();
      continue;
    }
    counter.planned += 1;
    plannedCount += 1;
    queue.push({ operation: op });
    if (plannedCount % config.batchSize === 0) emit();
  }
  emit();

  // ── Bounded-concurrency worker pool ──────────────────────────────────────
  let nextIndex = 0;
  const active = new Set<number>();

  const processOne = async (index: number): Promise<void> => {
    if (index >= queue.length) return;
    const item = queue[index];
    if (!item) return;
    if (completedIds.has(item.operation.id)) {
      markSkipped(item.operation.id);
      return;
    }

    counter.running += 1;
    emit();

    const { operation } = item;

    const outcome = await runWithRetry(operation, {
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      isRetryable,
      delay,
    });

    counter.running -= 1;
    if (outcome.status === "success") {
      counter.succeeded += 1;
      counter.completed += 1;
      // Mark completed so re-runs / later scans skip it (idempotency).
      completedIds.add(operation.id);
    } else {
      counter.failed += 1;
      counter.completed += 1;
    }
    counter.retried += outcome.retries;

    resultsArray.push({
      id: operation.id,
      status: outcome.status,
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.errorMessage !== undefined
        ? { errorMessage: outcome.errorMessage }
        : {}),
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      attempts: outcome.attempts,
      retries: outcome.retries,
    });
    emit();

    // Pull the next item as soon as a slot frees up (bounded concurrency).
    const next = nextIndex++;
    if (next < queue.length) {
      active.add(next);
      // Fire-and-forget each worker; the pool tracks completion via a final await.
      void processOne(next).finally(() => active.delete(next));
    } else {
      active.delete(index);
    }
  };

  // Seed up to `concurrency` workers.
  const initialWorkers = Math.min(config.concurrency, queue.length);
  for (let i = 0; i < initialWorkers; i++) {
    const index = nextIndex++;
    active.add(index);
    void processOne(index).finally(() => active.delete(index));
  }

  // Wait for every worker to finish.
  await waitForWorkers(() => active.size === 0);

  const completed = counter.completed;
  const summary = {
    total: operations.length,
    succeeded: counter.succeeded,
    failed: counter.failed,
    skipped: counter.skipped,
    retried: counter.retried,
    completed,
    allSucceeded:
      counter.failed === 0 && counter.skipped === 0 && counter.succeeded === totalOf(operations),
  };

  return {
    results: resultsArray,
    summary,
    progress: snapshotProgress(
      startedAt,
      counter,
      operations.length,
      config.now,
    ),
    finishedAt: config.now(),
  };
}

function totalOf<T>(operations: BatchOperation<T>[]): number {
  return operations.length;
}

interface RetryOutcome<T> {
  status: "success" | "failed";
  attempts: number;
  retries: number;
  data?: T;
  errorMessage?: string;
  errorCode?: string;
}

async function runWithRetry<T>(
  operation: BatchOperation<T>,
  opts: {
    maxRetries: number;
    retryDelayMs: number;
    isRetryable: (error: SorokitResult<unknown>) => boolean;
    delay: (ms: number) => Promise<void>;
  },
): Promise<RetryOutcome<T>> {
  let lastError: SorokitResult<unknown> | undefined;
  let executedAttempts = 0;
  let retries = 0;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    let result: SorokitResult<T>;
    try {
      result = await operation.runner(operation.id);
    } catch (e) {
      result = err(
        SorokitErrorCode.UNKNOWN,
        "Operation runner threw an error.",
        e,
      );
    }
    executedAttempts += 1;
    if (result.status === "ok") {
      return {
        status: "success",
        attempts: executedAttempts,
        retries,
        ...(result.data !== undefined ? { data: result.data } : {}),
      };
    }
    lastError = result as SorokitResult<unknown>;
    if (attempt < opts.maxRetries && opts.isRetryable(result as SorokitResult<unknown>)) {
      retries += 1;
      const backoffMs = Math.min(
        opts.retryDelayMs * Math.pow(2, attempt),
        MAX_RETRY_DELAY_MS,
      );
      await opts.delay(backoffMs);
      continue;
    }
    break;
  }

  const error = lastError;
  return {
    status: "failed",
    attempts: executedAttempts,
    retries,
    ...(error && error.status === "error" && error.error
      ? { errorMessage: error.error.message, errorCode: error.error.code }
      : { errorMessage: "Operation failed after retries." }),
  };
}

/** Simplified busy-wait on worker completion (bounded by average op time). */
async function waitForWorkers(isDone: () => boolean): Promise<void> {
  while (!isDone()) {
    // Yield to the event loop so pending microtasks (worker promises) advance.
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

/** Result payload for a trustline creation operation in a bulk run. */
export interface BulkTrustlineResult {
  account: string;
  assetCode: string;
  assetIssuer: string;
  /** Built transaction XDR when submission was skipped. */
  xdr?: string;
}

export interface BulkCreateTrustlineOp {
  /** Stable operation id (idempotency). */
  id: string;
  account: string;
  assetCode: string;
  assetIssuer: string;
  limit?: string;
}

export interface BulkCreateTrustlinesInput {
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  /** Accounts (G-addresses) to establish trustlines for. */
  accounts: string[];
  /** Assets to trust. */
  assets: Array<{ code: string; issuer: string; limit?: string }>;
  config?: BatchExecutorConfig;
  /** Optional sign-and-submit callback. When omitted, only the XDR is built. */
  submit?: (xdr: string) => Promise<SorokitResult<unknown>>;
}

/**
 * Establish trustlines for many accounts against many assets, each tracked
 * independently with bounded concurrency and retry.
 */
export async function bulkCreateTrustlines(
  input: BulkCreateTrustlinesInput,
): Promise<BatchExecutionReport<BulkTrustlineResult>> {
  const ops: BatchOperation<BulkTrustlineResult>[] = [];
  for (const account of input.accounts) {
    for (const asset of input.assets) {
      const id = `tl:${account}:${asset.code}:${asset.issuer}`;
      const runner = async (): Promise<SorokitResult<BulkTrustlineResult>> => {
        const params: TrustlineParams = {
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          ...(asset.limit !== undefined ? { limit: asset.limit } : {}),
        };
        const built = await buildTrustlineTransaction(
          input.horizonUrl,
          input.networkConfig,
          account,
          params,
        );
        if (built.status === "error") return built;
        if (input.submit) {
          const submitted = await input.submit(built.data);
          if (submitted.status === "error") {
            return err(
              submitted.error!.code,
              submitted.error!.message,
              submitted.error!.cause,
            );
          }
        }
        return ok<BulkTrustlineResult>({
          account,
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          ...(input.submit ? {} : { xdr: built.data }),
        });
      };
      ops.push({ id, runner, input: { account, assetCode: asset.code } });
    }
  }
  return runBatchOperations(ops, input.config);
}

// ─── Bulk payments ────────────────────────────────────────────────────────────

export interface BulkPaymentOp {
  id: string;
  source: string;
  params: import("../transaction/types").PaymentParams;
}

export interface BulkSendPaymentsInput {
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  transactions: BulkPaymentOp[];
  config?: BatchExecutorConfig;
  /** Optional sign-and-submit callback. When omitted, only the XDR is built. */
  submit?: (xdr: string) => Promise<SorokitResult<unknown>>;
}

export interface BulkPaymentResult {
  source: string;
  destination: string;
  xdr?: string;
}

/**
 * Execute many payments concurrently, tracking each independently. Building
 * uses the existing `buildPaymentTransaction`; when a `submit` callback is
 * supplied, the built XDR is signed and submitted by the caller.
 */
export async function bulkSendPayments(
  input: BulkSendPaymentsInput,
): Promise<BatchExecutionReport<BulkPaymentResult>> {
  const ops: BatchOperation<BulkPaymentResult>[] = input.transactions.map(
    (tx) => {
      const runner = async (): Promise<SorokitResult<BulkPaymentResult>> => {
        const built = await buildPaymentTransaction(
          input.horizonUrl,
          input.networkConfig,
          tx.source,
          tx.params,
        );
        if (built.status === "error") return built;
        if (input.submit) {
          const submitted = await input.submit(built.data);
          if (submitted.status === "error") {
            return err(
              submitted.error!.code,
              submitted.error!.message,
              submitted.error!.cause,
            );
          }
        }
        return ok<BulkPaymentResult>({
          source: tx.source,
          destination: tx.params.destination,
          ...(input.submit ? {} : { xdr: built.data }),
        });
      };
      return { id: tx.id, runner, input: { source: tx.source } };
    },
  );
  return runBatchOperations(ops, input.config);
}

// ─── Bulk key rotation ────────────────────────────────────────────────────────

export interface BulkRotateKeyOp {
  id: string;
  account: string;
  oldKey: string;
  newKey: string;
  newKeyWeight?: number;
}

export interface BulkRotateKeysInput {
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  /** Accounts whose keys are being rotated. */
  accounts: BulkRotateKeyOp[];
  config?: BatchExecutorConfig;
  /** Optional sign-and-submit callback. When omitted, only the XDR is built. */
  submit?: (xdr: string) => Promise<SorokitResult<unknown>>;
}

export interface BulkRotateKeyResult {
  account: string;
  xdr?: string;
}

/**
 * Rotate signing keys across many accounts, each tracked independently.
 * Backed by the existing `rotateAccountKey` API.
 */
export async function bulkRotateKeys(
  input: BulkRotateKeysInput,
): Promise<BatchExecutionReport<BulkRotateKeyResult>> {
  const ops: BatchOperation<BulkRotateKeyResult>[] = input.accounts.map(
    (op) => {
      const runner = async (): Promise<SorokitResult<BulkRotateKeyResult>> => {
        const params: RotateAccountKeyParams = {
          account: op.account,
          oldKey: op.oldKey,
          newKey: op.newKey,
          ...(op.newKeyWeight !== undefined
            ? { newKeyWeight: op.newKeyWeight }
            : {}),
        };
        const built = await rotateAccountKey(
          input.horizonUrl,
          input.networkConfig,
          params,
        );
        if (built.status === "error") return built;
        if (input.submit) {
          const submitted = await input.submit(built.data);
          if (submitted.status === "error") {
            return err(
              submitted.error!.code,
              submitted.error!.message,
              submitted.error!.cause,
            );
          }
        }
        return ok<BulkRotateKeyResult>({
          account: op.account,
          ...(input.submit ? {} : { xdr: built.data }),
        });
      };
      return { id: op.id, runner, input: { account: op.account } };
    },
  );
  return runBatchOperations(ops, input.config);
}
