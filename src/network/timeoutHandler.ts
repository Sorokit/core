import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isOperationTimeoutError, runWithTimeout } from "../shared/timeout";
/** Execute an operation with an AbortSignal and return a typed timeout result. */
export async function executeWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<SorokitResult<T>> {
  try { return ok(await runWithTimeout(timeoutMs, (signal) => operation(signal ?? new AbortController().signal))); }
  catch (cause) { if (isOperationTimeoutError(cause)) return err(SorokitErrorCode.OPERATION_TIMEOUT, cause.message, cause); return err(SorokitErrorCode.UNKNOWN, cause instanceof Error ? cause.message : String(cause), cause); }
}
