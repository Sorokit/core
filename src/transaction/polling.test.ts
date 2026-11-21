import { describe, it, expect, vi } from "vitest";
import {
  waitForTransaction,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "./polling";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { TransactionResult } from "./types";

const HASH = "a".repeat(64);

function tx(status: TransactionResult["status"]): SorokitResult<TransactionResult> {
  return ok({
    hash: HASH,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    fee: "100",
    envelopeXdr: "env",
    resultXdr: "res",
    ...(status === "pending" || status === "not_found" ? {} : { ledger: 42 }),
  } as TransactionResult);
}

const notFound = (): SorokitResult<TransactionResult> =>
  err(SorokitErrorCode.TX_NOT_FOUND, `Transaction not found: ${HASH}`);

describe("waitForTransaction", () => {
  it("documents the defaults: 30s timeout, 1s interval", () => {
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(1_000);
  });

  describe("success", () => {
    it("returns immediately when the transaction is already confirmed", async () => {
      const fetchStatus = vi.fn(async () => tx("success"));
      const res = await waitForTransaction(HASH, 1_000, 10, { fetchStatus });

      expect(res.status).toBe("ok");
      expect(res.data?.status).toBe("success");
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(fetchStatus).toHaveBeenCalledWith(HASH);
    });

    it("polls through not-found and pending until it is confirmed", async () => {
      const fetchStatus = vi
        .fn<(hash: string) => Promise<SorokitResult<TransactionResult>>>()
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(tx("pending"))
        .mockResolvedValueOnce(tx("success"));

      const res = await waitForTransaction(HASH, 5_000, 5, { fetchStatus });

      expect(res.status).toBe("ok");
      expect(res.data?.ledger).toBe(42);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
    });

    it("treats an on-ledger failed transaction as confirmed", async () => {
      const res = await waitForTransaction(HASH, 1_000, 10, {
        fetchStatus: async () => tx("failed"),
      });
      expect(res.status).toBe("ok");
      expect(res.data?.status).toBe("failed");
    });

    it("recovers from a transient lookup error", async () => {
      const fetchStatus = vi
        .fn<(hash: string) => Promise<SorokitResult<TransactionResult>>>()
        .mockResolvedValueOnce(err(SorokitErrorCode.TX_FETCH_FAILED, "network blip"))
        .mockResolvedValueOnce(tx("success"));

      const res = await waitForTransaction(HASH, 5_000, 5, { fetchStatus });
      expect(res.status).toBe("ok");
      expect(fetchStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe("timeout", () => {
    it("returns OPERATION_TIMEOUT when the transaction stays pending", async () => {
      const fetchStatus = vi.fn(async () => tx("pending"));
      const started = Date.now();
      const res = await waitForTransaction(HASH, 120, 20, { fetchStatus });

      expect(res.status).toBe("error");
      expect(res.error?.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(fetchStatus.mock.calls.length).toBeGreaterThan(1);
    });

    it("never sleeps past the deadline even with a long interval", async () => {
      const started = Date.now();
      const res = await waitForTransaction(HASH, 100, 60_000, {
        fetchStatus: async () => tx("pending"),
      });
      expect(res.error?.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("surfaces the last lookup error when lookups keep failing", async () => {
      const res = await waitForTransaction(HASH, 80, 10, {
        fetchStatus: async () => err(SorokitErrorCode.TX_FETCH_FAILED, "horizon down"),
      });
      expect(res.error?.code).toBe(SorokitErrorCode.TX_FETCH_FAILED);
      expect(res.error?.message).toBe("horizon down");
    });
  });

  describe("not found", () => {
    it("returns TX_NOT_FOUND when the hash never appears", async () => {
      const fetchStatus = vi.fn(async () => notFound());
      const res = await waitForTransaction(HASH, 80, 10, { fetchStatus });

      expect(res.status).toBe("error");
      expect(res.error?.code).toBe(SorokitErrorCode.TX_NOT_FOUND);
      expect(res.error?.message).toContain(HASH);
    });

    it("treats a not_found status result like a missing transaction", async () => {
      const res = await waitForTransaction(HASH, 60, 10, {
        fetchStatus: async () => tx("not_found"),
      });
      expect(res.error?.code).toBe(SorokitErrorCode.TX_NOT_FOUND);
    });
  });

  describe("interval and retries", () => {
    it("honours the configured interval", async () => {
      const fetchStatus = vi
        .fn<(hash: string) => Promise<SorokitResult<TransactionResult>>>()
        .mockResolvedValueOnce(tx("pending"))
        .mockResolvedValueOnce(tx("success"));

      const started = Date.now();
      await waitForTransaction(HASH, 5_000, 150, { fetchStatus });
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    });

    it("stops after maxRetries lookups", async () => {
      const fetchStatus = vi.fn(async () => tx("pending"));
      const res = await waitForTransaction(HASH, 60_000, 5, { fetchStatus, maxRetries: 3 });

      expect(fetchStatus).toHaveBeenCalledTimes(3);
      expect(res.error?.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
    });

    it("maxRetries of 1 performs a single lookup", async () => {
      const fetchStatus = vi.fn(async () => notFound());
      const res = await waitForTransaction(HASH, 60_000, 5, { fetchStatus, maxRetries: 1 });
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(res.error?.code).toBe(SorokitErrorCode.TX_NOT_FOUND);
    });
  });

  describe("abort", () => {
    it("stops polling when the signal is aborted", async () => {
      const controller = new AbortController();
      const fetchStatus = vi.fn(async () => {
        controller.abort();
        return tx("pending");
      });
      const res = await waitForTransaction(HASH, 60_000, 5, {
        fetchStatus,
        signal: controller.signal,
      });
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(res.error?.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
    });

    it("does not poll at all if already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchStatus = vi.fn(async () => tx("success"));
      const res = await waitForTransaction(HASH, 1_000, 5, {
        fetchStatus,
        signal: controller.signal,
      });
      expect(fetchStatus).not.toHaveBeenCalled();
      expect(res.status).toBe("error");
    });
  });

  describe("validation", () => {
    const fetchStatus = async () => tx("success");

    it("requires a hash", async () => {
      const res = await waitForTransaction("", 1_000, 10, { fetchStatus });
      expect(res.error?.code).toBe(SorokitErrorCode.VALIDATION);
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects invalid timeout %s",
      async (timeout) => {
        const res = await waitForTransaction(HASH, timeout, 10, { fetchStatus });
        expect(res.error?.code).toBe(SorokitErrorCode.VALIDATION);
      },
    );

    it.each([0, -5, Number.NaN])("rejects invalid interval %s", async (interval) => {
      const res = await waitForTransaction(HASH, 1_000, interval, { fetchStatus });
      expect(res.error?.code).toBe(SorokitErrorCode.VALIDATION);
    });

    it.each([0, -1, 1.5])("rejects invalid maxRetries %s", async (maxRetries) => {
      const res = await waitForTransaction(HASH, 1_000, 10, { fetchStatus, maxRetries });
      expect(res.error?.code).toBe(SorokitErrorCode.VALIDATION);
    });

    it("needs a horizonUrl or a custom fetchStatus", async () => {
      const res = await waitForTransaction(HASH, 1_000, 10);
      expect(res.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    });
  });
});
