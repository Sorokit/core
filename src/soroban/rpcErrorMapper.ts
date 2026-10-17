import {
  SorokitErrorCode,
  SorokitErrorCategory,
  type SorokitError,
  type SorokitResult,
  err,
} from "../shared/response";

export interface SorobanRpcErrorPayload {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: unknown; headers?: { get(name: string): string | null } };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function collectText(value: unknown, output: string[] = [], seen = new Set<unknown>()): string {
  if (value === null || value === undefined || seen.has(value)) return output.join(" ");
  if (typeof value === "string") { output.push(value); return output.join(" "); }
  if (typeof value !== "object") { output.push(String(value)); return output.join(" "); }
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "title", "reason", "result", "code"]) {
    if (key in record) collectText(record[key], output, seen);
  }
  return output.join(" ");
}

export function extractRpcErrorMessage(cause: unknown): string {
  return collectText(cause) || stringify(cause) || "Soroban RPC request failed";
}

export function classifySorobanRpcError(cause: unknown): SorokitErrorCode {
  const payload = cause as SorobanRpcErrorPayload | null;
  const status = typeof payload?.status === "number" ? payload.status :
    typeof payload?.response?.status === "number" ? payload.response.status : undefined;
  const text = extractRpcErrorMessage(cause).toLowerCase();
  if (status === 429 || /rate.?limit|too many requests|429/.test(text)) return SorokitErrorCode.RATE_LIMITED;
  if (/invalid auth|auth.*invalid|signature.*invalid|authorization/.test(text)) return SorokitErrorCode.INVALID_AUTH;
  if (/tx_bad_seq|bad.?seq|sequence.*(mismatch|invalid|too (low|high))|txbadseq/.test(text)) return SorokitErrorCode.TX_BAD_SEQ;
  if (/tx_bad_auth|bad.?auth|txbadauth|missing.*signature|wrong.*signer/.test(text)) return SorokitErrorCode.TX_BAD_AUTH;
  if (/tx_no_account|no.?account|account.*(not found|does not exist)|txnoaccount/.test(text)) return SorokitErrorCode.TX_NO_ACCOUNT;
  if (/tx_too_late|too.?late|time.?bound.*(expired|past)|txtoolate/.test(text)) return SorokitErrorCode.TX_TOO_LATE;
  if (/tx_too_early|too.?early|time.?bound.*(not yet|future)|txtooearly/.test(text)) return SorokitErrorCode.TX_TOO_EARLY;
  if (/insufficient fee|fee.*insufficient|insufficient.*base fee|fee bid/.test(text)) return SorokitErrorCode.INSUFFICIENT_FEE;
  if (/resource exhausted|resource limit|budget exceeded|cpu.*limit|memory.*limit|limit exceeded/.test(text)) return SorokitErrorCode.RESOURCE_LIMIT_EXCEEDED;
  if (/xdr|invalid transaction|malformed.*transaction|decode/.test(text)) return SorokitErrorCode.XDR_INVALID;
  if (/simulation failed|simulate.*fail|simulated.*failure|hosterror|contract.*failed/.test(text)) return SorokitErrorCode.SOROBAN_SIMULATION_FAILED;
  return SorokitErrorCode.CONTRACT_INVOKE_FAILED;
}

export function mapSorobanRpcError(cause: unknown): SorokitError {
  const code = classifySorobanRpcError(cause);
  const message = extractRpcErrorMessage(cause);
  const recovery = code === SorokitErrorCode.RATE_LIMITED
    ? { retryable: true, action: "Wait for the server Retry-After interval, then retry with backoff." }
    : code === SorokitErrorCode.INSUFFICIENT_FEE
      ? { retryable: true, action: "Increase the transaction fee using a fresh network estimate, then retry." }
      : code === SorokitErrorCode.RESOURCE_LIMIT_EXCEEDED
        ? { retryable: false, action: "Reduce contract work or split the operation before retrying." }
        : code === SorokitErrorCode.TX_BAD_SEQ
          ? { retryable: true, action: "Re-fetch the source account sequence number and rebuild the transaction before retrying." }
          : code === SorokitErrorCode.TX_BAD_AUTH
            ? { retryable: false, action: "Verify the signer, signing key, and signature coverage; rebuild and re-sign the transaction." }
            : code === SorokitErrorCode.TX_NO_ACCOUNT
              ? { retryable: false, action: "Fund or create the source account (or correct the account ID) before retrying." }
              : code === SorokitErrorCode.TX_TOO_LATE
                ? { retryable: true, action: "Rebuild the transaction with a fresh, later time bound and retry." }
                : code === SorokitErrorCode.TX_TOO_EARLY
                  ? { retryable: true, action: "Wait until the transaction's time bound becomes valid, then retry." }
        : { retryable: false, action: "Inspect the Soroban RPC details and correct the transaction or contract inputs." };
  const result = err(code, `Soroban RPC error: ${message}`, cause, undefined, { recovery });
  if (result.status === "error") return result.error;
  throw new Error("Unexpected successful Soroban RPC error mapping");
}

/** Convert an unknown RPC failure into the SDK result shape. */
export function mapSorobanRpcResult<T = never>(cause: unknown): SorokitResult<T> {
  const mapped = mapSorobanRpcError(cause);
  return { status: "error", data: null, error: mapped } as SorokitResult<T>;
}

/** Backward-friendly alias for consumers that prefer a shorter name. */
export const mapRpcError = mapSorobanRpcError;

export { SorokitErrorCategory };
