import { SorokitErrorCode } from "./response";

// ─── JSON-RPC 2.0 error codes (RFC: https://www.jsonrpc.org/specification) ───
// Standard codes
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
// Soroban server-defined error range (-32000 to -32099)
const RPC_SERVER_ERROR_MIN = -32099;
const RPC_SERVER_ERROR_MAX = -32000;

/**
 * Map a Soroban RPC error (JSON-RPC 2.0) to a `SorokitErrorCode` and extract
 * a human-readable message.
 *
 * JSON-RPC errors have a numeric `code`, a `message` string, and an optional
 * `data` field. This function inspects `error.code` and applies the following
 * mapping:
 *
 * | JSON-RPC code        | SorokitErrorCode          |
 * |----------------------|---------------------------|
 * | -32700 (Parse error) | INVALID_TRANSACTION       |
 * | -32600 (Invalid req) | INVALID_TRANSACTION       |
 * | -32601 (Method n/f)  | INVALID_TRANSACTION       |
 * | -32602 (Invalid par) | INVALID_TRANSACTION       |
 * | -32603 (Internal)    | NETWORK_ERROR             |
 * | -32000…-32099        | CONTRACT_INVOKE_FAILED or |
 * |                      | TX_SUBMIT_FAILED for known|
 * |                      | codes; SERVICE_UNAVAILABLE|
 * |                      | for unrecognised ones     |
 * | anything else        | NETWORK_ERROR             |
 *
 * @param error - The raw error value from an RPC call (may be any type).
 * @returns `{ code, message, originalError }` — `message` is taken from
 *   `error.message` when present, otherwise from `String(error)`.
 */
export function mapRpcError(error: unknown): {
  code: SorokitErrorCode;
  message: string;
  originalError: unknown;
} {
  // Extract message
  let message: string;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in (error as object) &&
    typeof (error as Record<string, unknown>)["message"] === "string"
  ) {
    message = (error as Record<string, unknown>)["message"] as string;
  } else {
    message = String(error);
  }

  // Extract numeric RPC error code
  let rpcCode: number | undefined;
  if (error !== null && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e["code"] === "number") {
      rpcCode = e["code"] as number;
    }
  }

  let code: SorokitErrorCode;

  if (rpcCode === undefined) {
    code = SorokitErrorCode.NETWORK_ERROR;
  } else if (
    rpcCode === RPC_PARSE_ERROR ||
    rpcCode === RPC_INVALID_REQUEST ||
    rpcCode === RPC_METHOD_NOT_FOUND ||
    rpcCode === RPC_INVALID_PARAMS
  ) {
    code = SorokitErrorCode.INVALID_TRANSACTION;
  } else if (rpcCode === RPC_INTERNAL_ERROR) {
    code = SorokitErrorCode.NETWORK_ERROR;
  } else if (rpcCode >= RPC_SERVER_ERROR_MIN && rpcCode <= RPC_SERVER_ERROR_MAX) {
    // Soroban server-defined errors (-32000 to -32099)
    // Inspect message for known Soroban-specific error patterns
    const lowerMsg = message.toLowerCase();
    if (/contract.*invok|invok.*contract|contract.*fail/.test(lowerMsg)) {
      code = SorokitErrorCode.CONTRACT_INVOKE_FAILED;
    } else if (/tx.*submit|submit.*tx|transaction.*submit|submit.*fail/.test(lowerMsg)) {
      code = SorokitErrorCode.TX_SUBMIT_FAILED;
    } else {
      code = SorokitErrorCode.SERVICE_UNAVAILABLE;
    }
  } else {
    code = SorokitErrorCode.NETWORK_ERROR;
  }

  return { code, message, originalError: error };
}

/**
 * Extract a human-readable message from a Horizon error response body.
 *
 * Horizon error bodies follow the Problem Details format (RFC 7807) and may
 * include an `extras.result_codes` array for transaction failures.
 *
 * Priority order:
 *  1. `body.extras.result_codes` — joined with ", "
 *  2. `body.detail`
 *  3. `body.title`
 *  4. Fallback: `"HTTP <status>"`
 */
function parseHorizonErrorMessage(status: number, body: unknown): string {
  if (body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;

    const extras = b["extras"];
    if (extras !== null && typeof extras === "object") {
      const resultCodes = (extras as Record<string, unknown>)["result_codes"];
      if (Array.isArray(resultCodes) && resultCodes.length > 0) {
        return resultCodes.map(String).join(", ");
      }
      if (typeof resultCodes === "string" && resultCodes.length > 0) {
        return resultCodes;
      }
    }

    if (typeof b["detail"] === "string" && b["detail"].length > 0) {
      return b["detail"];
    }

    if (typeof b["title"] === "string" && b["title"].length > 0) {
      return b["title"];
    }
  }

  return `HTTP ${status}`;
}

/**
 * Map an HTTP status code from a Horizon response to a `SorokitErrorCode`,
 * and parse the response body for a human-readable message.
 *
 * @param status - The HTTP status code from the Horizon response.
 * @param body   - The parsed JSON body of the Horizon error response (may be `null` or `undefined`).
 * @returns An object with a `code` (SorokitErrorCode) and a `message` string.
 *
 * Status mapping:
 * - 400 → INVALID_TRANSACTION (closest to "bad request" in the existing enum)
 * - 404 → NETWORK_ERROR
 * - 500, 503 → SERVICE_UNAVAILABLE
 * - all other statuses → NETWORK_ERROR (fallback)
 */
export function mapHorizonError(
  status: number,
  body: unknown,
): { code: SorokitErrorCode; message: string } {
  const message = parseHorizonErrorMessage(status, body);

  if (status === 400) {
    return { code: SorokitErrorCode.INVALID_TRANSACTION, message };
  }
  if (status === 404) {
    return { code: SorokitErrorCode.NETWORK_ERROR, message };
  }
  if (status === 500 || status === 503) {
    return { code: SorokitErrorCode.SERVICE_UNAVAILABLE, message };
  }
  return { code: SorokitErrorCode.NETWORK_ERROR, message };
}
