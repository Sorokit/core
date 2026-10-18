/**
 * Compile-time contract checks for the public submitBatch call shapes (REV9).
 *
 * Every assignment below is a type-level assertion: the values are declared,
 * never executed. `npm run typecheck` fails if any public shape regresses, and
 * the `@ts-expect-error` guard fails if planning mode ever starts returning a
 * Promise again.
 */
import type { SorokitResult } from "../shared/response";
import {
  buildRollbackInstructions,
  generateRollbackInstructions,
  isBatchAtomicComplete,
  recommendRetryStrategy,
  submitBatch,
  suggestRetryStrategy,
  wasAtomicExecuted,
} from "../transaction/batchSubmitter";
import type { BatchSubmissionResult } from "../transaction/batchSubmitter";

declare const transactions: string[];
declare const batchResult: BatchSubmissionResult;

/** Submission mode requires a target and returns a Promise. */
const submissionCall: Promise<SorokitResult<BatchSubmissionResult>> = submitBatch(transactions, {
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

/** Planning mode has no target and stays synchronous. */
const planningCall: SorokitResult<BatchSubmissionResult> = submitBatch(transactions, {
  atomic: false,
});

// @ts-expect-error planning mode is synchronous, so it must not be typed as a Promise
const planningIsNotAPromise: Promise<SorokitResult<BatchSubmissionResult>> = planningCall;

/** Structured rollback instructions are a plain array, not a result wrapper. */
const rollbackInstructions: { xdr: string }[] = buildRollbackInstructions(batchResult);

/** The legacy rollback helper keeps its SorokitResult<string[]> contract. */
const legacyRollback: SorokitResult<string[]> = generateRollbackInstructions(batchResult);

/** Boolean helpers are plain booleans; the legacy helper stays wrapped. */
const atomicComplete: boolean = isBatchAtomicComplete(batchResult);
const legacyAtomic: SorokitResult<boolean> = wasAtomicExecuted(batchResult);

/** Retry helpers keep one stable signature each. */
const retryStrategy: ReturnType<typeof recommendRetryStrategy> =
  recommendRetryStrategy(batchResult);
const legacyRetry: SorokitResult<unknown> = suggestRetryStrategy(batchResult);

export {
  atomicComplete,
  legacyAtomic,
  legacyRetry,
  legacyRollback,
  planningCall,
  planningIsNotAPromise,
  retryStrategy,
  rollbackInstructions,
  submissionCall,
};
