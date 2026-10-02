/**
 * Tests for submitTransaction (src/transaction/submitTransaction.ts) and
 * getTransactionStatus (src/transaction/status.ts) — Issue #249.
 *
 * Mocking strategy:
 *  - `createHorizonServer` (from shared/serverFactory) is mocked via
 *    `vi.mock("../shared/serverFactory")` so every code-path that calls
 *    `server.submitTransaction()` or `server.transactions().transaction().call()`
 *    is fully controlled without hitting the network.
 *  - `TransactionBuilder.fromXDR` is kept real for submitTransaction tests
 *    (we use a valid testnet XDR) so the actual parse/sign-check logic runs.
 *    For error-injection we simply supply intentionally malformed inputs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";

// ---------------------------------------------------------------------------
// Hoist mock helpers before vi.mock() calls
// ---------------------------------------------------------------------------

const { mockSubmit, mockTransactionCall } = vi.hoisted(() => ({
  mockSubmit: vi.fn(),
  mockTransactionCall: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the server factory so no real network calls are made
// ---------------------------------------------------------------------------

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    submitTransaction: mockSubmit,
    transactions: vi.fn(() => ({
      transaction: vi.fn(() => ({
        call: mockTransactionCall,
      })),
    })),
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A real signed testnet XDR (inflation op, signed for TESTNET passphrase).
 * Generated offline with Keypair.random() + TransactionBuilder.
 */
const VALID_TESTNET_XDR =
  "AAAAAgAAAAArg6xVmhrfK8Kf1L0wCEKReWNmDUacUNz/RAwldACowwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqO6RQAAAAAAAAAAEAAAAAAAAACQAAAAAAAAABdACowwAAAEBh9aFJaCgi8jCtB4tqReRPYyywWPIWl6v1+92iXCdqsKGvoxRafpQiAIdvHr6+Jw2Ybd4Vs89XDO0nDVtwip4K";

const MOCK_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    invalidate: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
}

function makeHorizonError(status: number, message = "Horizon error") {
  const err: any = new Error(message);
  err.response = { status };
  return err;
}

// ---------------------------------------------------------------------------
// submitTransaction
// ---------------------------------------------------------------------------

describe("submitTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful submission", () => {
    it("returns { status: 'ok' } with hash on successful Horizon response", async () => {
      mockSubmit.mockResolvedValueOnce({
        hash: MOCK_HASH,
        ledger: 42,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "AAAAAAAAAGQ=",
      });

      const result = await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        VALID_TESTNET_XDR,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.hash).toBe(MOCK_HASH);
        expect(result.data.status).toBe("success");
        expect(result.data.ledger).toBe(42);
      }
    });

    it("stores result in cache keyed by hash when cache is provided", async () => {
      mockSubmit.mockResolvedValueOnce({
        hash: MOCK_HASH,
        ledger: 10,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "",
      });

      const cache = makeCache();
      await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        VALID_TESTNET_XDR,
        cache,
      );

      expect(cache.set).toHaveBeenCalledWith(
        `tx:${MOCK_HASH}`,
        expect.objectContaining({ hash: MOCK_HASH, status: "success" }),
        expect.any(Number),
      );
    });
  });

  describe("malformed / invalid XDR", () => {
    it("returns TX_SUBMIT_FAILED for a completely malformed XDR string", async () => {
      const result = await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        "not-valid-xdr!!!",
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
      }
    });

    it("returns TX_SUBMIT_FAILED for an empty string", async () => {
      const result = await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        "",
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
      }
    });
  });

  describe("Horizon error response", () => {
    it("returns INVALID_TRANSACTION when Horizon rejects the transaction", async () => {
      mockSubmit.mockRejectedValueOnce(
        makeHorizonError(400, "Transaction submission failed"),
      );

      const result = await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        VALID_TESTNET_XDR,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_TRANSACTION);
      }
    });

    it("returns TX_SUBMIT_FAILED on a network connectivity error", async () => {
      const networkErr: any = new Error("fetch failed");
      networkErr.code = "ECONNREFUSED";
      mockSubmit.mockRejectedValueOnce(networkErr);

      const result = await submitTransaction(
        "https://horizon-testnet.stellar.org",
        Networks.TESTNET,
        VALID_TESTNET_XDR,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
      }
    });
  });

  describe("network passphrase mismatch", () => {
    /**
     * VALID_TESTNET_XDR was signed for Networks.TESTNET.
     * Submitting it to Networks.PUBLIC should be caught before hitting Horizon.
     */
    it("returns TX_SUBMIT_FAILED with passphrase mismatch message when testnet XDR is sent to mainnet", async () => {
      const result = await submitTransaction(
        "https://horizon.stellar.org",
        Networks.PUBLIC,
        VALID_TESTNET_XDR,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
        expect(result.error.message).toMatch(/passphrase mismatch/i);
      }
      // Horizon must NOT have been called — the rejection is client-side
      expect(mockSubmit).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// getTransactionStatus
// ---------------------------------------------------------------------------

describe("getTransactionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful lookup", () => {
    it("maps tx.successful === true to status 'success'", async () => {
      mockTransactionCall.mockResolvedValueOnce({
        hash: MOCK_HASH,
        successful: true,
        ledger_attr: 100,
        created_at: "2024-01-01T00:00:00Z",
        fee_charged: 100,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "",
      });

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("success");
        expect(result.data.hash).toBe(MOCK_HASH);
        expect(result.data.ledger).toBe(100);
      }
    });

    it("maps tx.successful === false to status 'failed'", async () => {
      mockTransactionCall.mockResolvedValueOnce({
        hash: MOCK_HASH,
        successful: false,
        ledger_attr: 101,
        created_at: "2024-01-01T00:00:00Z",
        fee_charged: 100,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "",
      });

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("failed");
      }
    });

    it("maps ledger_attr === 0 (pending) to status 'pending' with no ledger", async () => {
      mockTransactionCall.mockResolvedValueOnce({
        hash: MOCK_HASH,
        successful: true,
        ledger_attr: 0,
        created_at: "2024-01-01T00:00:00Z",
        fee_charged: 100,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "",
      });

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.status).toBe("pending");
        expect(result.data.ledger).toBeUndefined();
      }
    });
  });

  describe("cache behaviour", () => {
    it("returns cached value without hitting Horizon when a cache hit exists", async () => {
      const cachedTx = {
        hash: MOCK_HASH,
        status: "success" as const,
        ledger: 99,
      };
      const cache = makeCache();
      cache.get.mockReturnValueOnce(cachedTx);

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
        cache,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.ledger).toBe(99);
      }
      expect(mockTransactionCall).not.toHaveBeenCalled();
    });

    it("stores result in cache after a successful Horizon call", async () => {
      mockTransactionCall.mockResolvedValueOnce({
        hash: MOCK_HASH,
        successful: true,
        ledger_attr: 55,
        created_at: "2024-01-01T00:00:00Z",
        fee_charged: 100,
        envelope_xdr: VALID_TESTNET_XDR,
        result_xdr: "",
      });

      const cache = makeCache();
      cache.get.mockReturnValueOnce(undefined); // cache miss

      await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
        cache,
      );

      expect(cache.set).toHaveBeenCalledWith(
        `tx:${MOCK_HASH}`,
        expect.objectContaining({ hash: MOCK_HASH, status: "success" }),
      );
    });
  });

  describe("error paths", () => {
    it("returns TX_NOT_FOUND when Horizon responds with 404", async () => {
      mockTransactionCall.mockRejectedValueOnce(
        makeHorizonError(404, "Resource Missing"),
      );

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_NOT_FOUND);
      }
    });

    it("returns TX_NOT_FOUND when error message contains 'not found'", async () => {
      mockTransactionCall.mockRejectedValueOnce(
        new Error("Transaction not found"),
      );

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_NOT_FOUND);
      }
    });

    it("returns SERVICE_UNAVAILABLE for non-404 Horizon errors (e.g. 500)", async () => {
      mockTransactionCall.mockRejectedValueOnce(
        makeHorizonError(500, "Internal Server Error"),
      );

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
      }
    });

    it("returns TX_SUBMIT_FAILED for generic network errors", async () => {
      mockTransactionCall.mockRejectedValueOnce(new Error("fetch failed"));

      const result = await getTransactionStatus(
        "https://horizon-testnet.stellar.org",
        MOCK_HASH,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_FETCH_FAILED);
      }
    });
  });
});
