import { err, SorokitErrorCode } from "./response";
import type { SorokitError, SorokitResult } from "./response";

export type HorizonErrorResource = "account" | "transaction" | "generic";

export interface HorizonErrorMappingOptions {
  resource?: HorizonErrorResource;
  fallbackCode?: SorokitErrorCode;
}

function property(error: unknown, key: string): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function statusOf(error: unknown): number | undefined {
  const direct = property(error, "status");
  if (typeof direct === "number") return direct;
  const response = property(error, "response");
  const responseStatus = property(response, "status");
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  const message = property(error, "message");
  return typeof message === "string" ? message : String(error);
}

function resourceNotFoundCode(resource: HorizonErrorResource): SorokitErrorCode {
  if (resource === "account") return SorokitErrorCode.ACCOUNT_NOT_FOUND;
  if (resource === "transaction") return SorokitErrorCode.TX_NOT_FOUND;
  return SorokitErrorCode.NETWORK_ERROR;
}

/** Convert a Horizon SDK/HTTP exception into a stable SorokitError. */
export function mapHorizonError(
  error: unknown,
  options: HorizonErrorMappingOptions = {},
): SorokitError {
  const status = statusOf(error);
  const message = messageOf(error);
  const resource = options.resource ?? "generic";
  let code = options.fallbackCode ?? SorokitErrorCode.NETWORK_ERROR;
  let recovery: SorokitError["recovery"];

  if (status === 400 || /bad transaction|tx_bad|transaction failed/i.test(message)) {
    code = SorokitErrorCode.INVALID_TRANSACTION;
  } else if (status === 404) {
    code = resourceNotFoundCode(resource);
  } else if (status === 408 || status === 429) {
    code = options.fallbackCode ?? SorokitErrorCode.SERVICE_UNAVAILABLE;
    recovery = status === 429
      ? { retryable: true, action: "Retry after the Horizon service recovers.", retryAfterMs: 1000 }
      : { retryable: true, action: "Retry after the Horizon service recovers." };
  } else if (status !== undefined && status >= 500) {
    code = SorokitErrorCode.SERVICE_UNAVAILABLE;
    recovery = { retryable: true, action: "Retry against a healthy Horizon endpoint." };
  }

  const mappedResult = err(
    code,
    `Horizon request failed${status ? ` (HTTP ${status})` : ""}: ${message}`,
    error,
    undefined,
    recovery ? { recovery } : undefined,
  );
  if (mappedResult.status === "error") return mappedResult.error;
  throw new Error("Horizon error mapping unexpectedly produced a successful result");
}

/** Convenience result helper for Horizon-facing modules. */
export function horizonErrorResult<T>(
  error: unknown,
  options: HorizonErrorMappingOptions = {},
): SorokitResult<T> {
  const mapped = mapHorizonError(error, options);
  return err(
    mapped.code,
    mapped.message,
    mapped.cause,
    undefined,
    mapped.recovery ? { recovery: mapped.recovery } : undefined,
  );
}

export function getHorizonErrorStatus(error: unknown): number | undefined {
  return statusOf(error);
}
