import { SorokitErrorCode } from "./response";

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
