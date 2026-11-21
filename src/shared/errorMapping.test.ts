import { describe, it, expect } from "vitest";
import { mapHorizonError } from "./errorMapping";
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
