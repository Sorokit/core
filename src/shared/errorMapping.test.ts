import { describe, it, expect } from "vitest";
import { mapHorizonError, mapRpcError } from "./errorMapping";
import { SorokitErrorCode } from "./response";

describe("mapHorizonError", () => {
  it("maps 404 with no body to NETWORK_ERROR", () => {
    const result = mapHorizonError(404, null);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
    expect(result.message).toBe("HTTP 404");
  });

  it("maps 400 with body.extras.result_codes array to INVALID_TRANSACTION and joins codes", () => {
    const body = {
      type: "https://stellar.org/horizon-errors/transaction_failed",
      title: "Transaction Failed",
      status: 400,
      detail: "The transaction failed when tried to be applied on the stellar network.",
      extras: {
        result_codes: { transaction: "tx_failed", operations: ["op_bad_auth", "op_no_trust"] },
      },
    };
    // result_codes is an object here, but the extras.result_codes being an array is the key case
    const bodyWithArray = {
      extras: { result_codes: ["tx_failed", "op_bad_auth"] },
    };
    const result = mapHorizonError(400, bodyWithArray);
    expect(result.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
    expect(result.message).toBe("tx_failed, op_bad_auth");
  });

  it("maps 500 with body.detail to SERVICE_UNAVAILABLE and returns detail as message", () => {
    const body = {
      title: "Internal Server Error",
      detail: "An error occurred while processing the request.",
      status: 500,
    };
    const result = mapHorizonError(500, body);
    expect(result.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
    expect(result.message).toBe("An error occurred while processing the request.");
  });

  it("maps 503 with body.title (no detail) to SERVICE_UNAVAILABLE and returns title as message", () => {
    const body = {
      title: "Service Unavailable",
      status: 503,
    };
    const result = mapHorizonError(503, body);
    expect(result.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
    expect(result.message).toBe("Service Unavailable");
  });

  it("maps unknown status (418) to NETWORK_ERROR fallback", () => {
    const result = mapHorizonError(418, null);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  it("falls back to 'HTTP <status>' when body has no recognised message fields", () => {
    const body = { foo: "bar" };
    const result = mapHorizonError(400, body);
    expect(result.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
    expect(result.message).toBe("HTTP 400");
  });

  it("falls back to 'HTTP <status>' when body is undefined", () => {
    const result = mapHorizonError(503, undefined);
    expect(result.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
    expect(result.message).toBe("HTTP 503");
  });

  it("prefers extras.result_codes over detail over title", () => {
    const body = {
      title: "Transaction Failed",
      detail: "Some detail text.",
      extras: { result_codes: ["tx_bad_seq"] },
    };
    const result = mapHorizonError(400, body);
    expect(result.message).toBe("tx_bad_seq");
  });

  it("falls back from result_codes to detail when result_codes is empty", () => {
    const body = {
      title: "Transaction Failed",
      detail: "Some detail text.",
      extras: { result_codes: [] },
    };
    const result = mapHorizonError(400, body);
    expect(result.message).toBe("Some detail text.");
  });
});

describe("mapRpcError", () => {
  // ── Standard JSON-RPC codes ────────────────────────────────────────────────

  it("maps -32700 (Parse error) to INVALID_TRANSACTION", () => {
    const error = { code: -32700, message: "Parse error" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });

  it("maps -32600 (Invalid Request) to INVALID_TRANSACTION", () => {
    const error = { code: -32600, message: "Invalid Request" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });

  it("maps -32601 (Method not found) to INVALID_CONFIG", () => {
    const error = { code: -32601, message: "Method not found" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.INVALID_CONFIG);
  });

  it("maps -32602 (Invalid params) to INVALID_TRANSACTION", () => {
    const error = { code: -32602, message: "Invalid params" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
  });

  it("maps -32603 (Internal error) to NETWORK_ERROR", () => {
    const error = { code: -32603, message: "Internal error" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  // ── Soroban server error range (-32000 to -32099) ─────────────────────────

  it("maps a Soroban server error with contract invocation message to CONTRACT_INVOKE_FAILED", () => {
    const error = { code: -32000, message: "contract invocation failed" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
  });

  it("maps a Soroban server error with tx submit message to TX_SUBMIT_FAILED", () => {
    const error = { code: -32001, message: "tx submit failed" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
  });

  it("maps an unrecognised Soroban server error code to SERVICE_UNAVAILABLE", () => {
    const error = { code: -32050, message: "some unknown soroban error" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
  });

  it("maps the boundary code -32099 to SERVICE_UNAVAILABLE when message is unrecognised", () => {
    const error = { code: -32099, message: "unrecognised" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
  });

  // ── Unknown code fallback ──────────────────────────────────────────────────

  it("maps an unknown positive code to NETWORK_ERROR", () => {
    const error = { code: 999, message: "Unknown" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  it("maps a code outside the standard ranges to NETWORK_ERROR", () => {
    const error = { code: -100, message: "Some error" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  it("maps an error without a code to NETWORK_ERROR", () => {
    const error = { message: "No code here" };
    const result = mapRpcError(error);
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  // ── Message extraction ─────────────────────────────────────────────────────

  it("extracts message from error.message when present", () => {
    const error = { code: -32602, message: "Invalid parameter: amount" };
    const result = mapRpcError(error);
    expect(result.message).toBe("Invalid parameter: amount");
  });

  it("falls back to String(error) when error.message is absent", () => {
    const error = { code: -32602 };
    const result = mapRpcError(error);
    expect(result.message).toBe(String(error));
  });

  it("uses String(error) for a plain string error", () => {
    const result = mapRpcError("RPC failure");
    expect(result.message).toBe("RPC failure");
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  it("uses String(error) for null", () => {
    const result = mapRpcError(null);
    expect(result.message).toBe("null");
    expect(result.code).toBe(SorokitErrorCode.NETWORK_ERROR);
  });

  // ── originalError preserved ────────────────────────────────────────────────

  it("preserves originalError as-is", () => {
    const error = { code: -32603, message: "Internal error", data: { detail: "heap overflow" } };
    const result = mapRpcError(error);
    expect(result.originalError).toBe(error);
  });

  it("preserves originalError for a plain Error instance", () => {
    const error = new Error("network issue");
    const result = mapRpcError(error);
    expect(result.originalError).toBe(error);
  });
});
