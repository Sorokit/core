import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";

// ─── Mock submitTransaction ───────────────────────────────────────────────────

const { mockSubmitTransaction } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
}));

vi.mock("./submitTransaction", () => ({
  submitTransaction: mockSubmitTransaction,
}));

// Imports after vi.mock so they pick up the mock
import {
  submitBatch,
  isBatchAtomicComplete,
  recommendRetryStrategy,
  buildRollbackInstructions,
} from "./batchSubmitter";
import type { BatchSubmissionResult } from "./batchSubmitter";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const XDR_1 = "AAAAAQAAAAA=";
const XDR_2 = "AAAABQAAAAA=";
const XDR_3 = "AAAACQAAAAA=";

function makeSuccessResult(hash: string, ledger = 1000): TransactionResult {
  return { hash, status: "success", ledger };
}

function makeMockCache(): SorokitCache {
  return {
    get: vi.fn(),
    set: vi.fn(),
    invalidate: vi.fn(),
    clear: vi.fn(),
  };
}

// Clear mock call history before each test to prevent cross-test interference
beforeEach(() => {
  mockSubmitTransaction.mockClear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("submitBatch — input validation", () => {
  it("returns error when transactions array is empty", async () => {
    const result = await submitBatch([], TEST_CONFIG);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("returns error when horizonUrl is empty string", async () => {
    const result = await submitBatch([XDR_1], {
      ...TEST_CONFIG,
      horizonUrl: "",
    });
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("returns error when networkPassphrase is empty string", async () => {
    const result = await submitBatch([XDR_1], {
      ...TEST_CONFIG,
      networkPassphrase: "",
    });
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });
});

describe("submitBatch — all success", () => {
  beforeEach(() => {
    mockSubmitTransaction
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_1")))
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_2")));
  });

  it("calls submitTransaction once per XDR", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
  });

  it("passes correct args to submitTransaction for each XDR", async () => {
    await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(mockSubmitTransaction).toHaveBeenNthCalledWith(
      1,
      TEST_CONFIG.horizonUrl,
      TEST_CONFIG.networkPassphrase,
      XDR_1,
      undefined,
    );
    expect(mockSubmitTransaction).toHaveBeenNthCalledWith(
      2,
      TEST_CONFIG.horizonUrl,
      TEST_CONFIG.networkPassphrase,
      XDR_2,
      undefined,
    );
  });

  it("populates hash on each entry from TransactionResult.hash", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactions[0].hash).toBe("hash_1");
    expect(result.data.transactions[1].hash).toBe("hash_2");
  });

  it("sets status 'success' on each entry", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactions[0].status).toBe("success");
    expect(result.data.transactions[1].status).toBe("success");
  });

  it("returns summary 'all_success' and ok: true", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.summary).toBe("all_success");
    expect(result.data.ok).toBe(true);
  });

  it("returns succeeded === transactions.length and failed === 0", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.succeeded).toBe(2);
    expect(result.data.failed).toBe(0);
  });
});

describe("submitBatch — all failed", () => {
  beforeEach(() => {
    mockSubmitTransaction
      .mockResolvedValueOnce(
        err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon error A"),
      )
      .mockResolvedValueOnce(
        err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon error B"),
      );
  });

  it("calls submitTransaction once per XDR — does not short-circuit", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
  });

  it("sets status 'failed' and populates error message on each entry", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactions[0].status).toBe("failed");
    expect(result.data.transactions[0].error).toBe("Horizon error A");
    expect(result.data.transactions[1].status).toBe("failed");
    expect(result.data.transactions[1].error).toBe("Horizon error B");
  });

  it("returns summary 'all_failed' and ok: false", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.summary).toBe("all_failed");
    expect(result.data.ok).toBe(false);
  });

  it("returns failed === transactions.length and succeeded === 0", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.failed).toBe(2);
    expect(result.data.succeeded).toBe(0);
  });

  it("leaves hash undefined on failed entries", async () => {
    const result = await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactions[0].hash).toBeUndefined();
    expect(result.data.transactions[1].hash).toBeUndefined();
  });
});

describe("submitBatch — partial failure", () => {
  beforeEach(() => {
    mockSubmitTransaction
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_1")))
      .mockResolvedValueOnce(
        err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon error"),
      )
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_3")));
  });

  it("calls submitTransaction for all three XDRs — does not stop on failure", async () => {
    const result = await submitBatch([XDR_1, XDR_2, XDR_3], TEST_CONFIG);
    expect(result.status).toBe("ok");
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(3);
  });

  it("sets correct status per entry: success, failed, success", async () => {
    const result = await submitBatch([XDR_1, XDR_2, XDR_3], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.transactions[0].status).toBe("success");
    expect(result.data.transactions[1].status).toBe("failed");
    expect(result.data.transactions[2].status).toBe("success");
  });

  it("returns summary 'partial_success' and ok: false", async () => {
    const result = await submitBatch([XDR_1, XDR_2, XDR_3], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.summary).toBe("partial_success");
    expect(result.data.ok).toBe(false);
  });

  it("returns succeeded === 2, failed === 1", async () => {
    const result = await submitBatch([XDR_1, XDR_2, XDR_3], TEST_CONFIG);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.succeeded).toBe(2);
    expect(result.data.failed).toBe(1);
  });
});

describe("submitBatch — sequential ordering", () => {
  beforeEach(() => {
    mockSubmitTransaction
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_1")))
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_2")));
  });

  it("submits XDRs in the original array order", async () => {
    await submitBatch([XDR_1, XDR_2], TEST_CONFIG);
    expect(mockSubmitTransaction.mock.calls[0][2]).toBe(XDR_1);
    expect(mockSubmitTransaction.mock.calls[1][2]).toBe(XDR_2);
  });
});

describe("submitBatch — parallel mode", () => {
  it("submits all XDRs concurrently and returns all_success", async () => {
    mockSubmitTransaction
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_1")))
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_2")));

    const result = await submitBatch([XDR_1, XDR_2], {
      ...TEST_CONFIG,
      mode: "parallel",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    expect(result.data.summary).toBe("all_success");
    expect(result.data.transactions[0].hash).toBe("hash_1");
    expect(result.data.transactions[1].hash).toBe("hash_2");
  });

  it("handles partial failure in parallel mode the same as sequential", async () => {
    mockSubmitTransaction
      .mockResolvedValueOnce(ok(makeSuccessResult("hash_1")))
      .mockResolvedValueOnce(
        err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon error"),
      );

    const result = await submitBatch([XDR_1, XDR_2], {
      ...TEST_CONFIG,
      mode: "parallel",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.summary).toBe("partial_success");
    expect(result.data.transactions[0].status).toBe("success");
    expect(result.data.transactions[1].status).toBe("failed");
  });
});

describe("wasAtomicExecuted", () => {
  it("returns true when summary is all_success", () => {
    const result: BatchSubmissionResult = {
      ok: true,
      summary: "all_success",
      succeeded: 2,
      failed: 0,
      transactions: [],
    };
    expect(isBatchAtomicComplete(result)).toBe(true);
  });

  it("returns false when summary is partial_success", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "partial_success",
      succeeded: 1,
      failed: 1,
      transactions: [],
    };
    expect(isBatchAtomicComplete(result)).toBe(false);
  });

  it("returns false when summary is all_failed", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "all_failed",
      succeeded: 0,
      failed: 2,
      transactions: [],
    };
    expect(isBatchAtomicComplete(result)).toBe(false);
  });
});

describe("suggestRetryStrategy", () => {
  it("returns 'none' for all_success", () => {
    const result: BatchSubmissionResult = {
      ok: true,
      summary: "all_success",
      succeeded: 2,
      failed: 0,
      transactions: [],
    };
    expect(recommendRetryStrategy(result)).toBe("none");
  });

  it("returns 'retry_all' for all_failed", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "all_failed",
      succeeded: 0,
      failed: 2,
      transactions: [],
    };
    expect(recommendRetryStrategy(result)).toBe("retry_all");
  });

  it("returns 'retry_failed' for partial_success", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "partial_success",
      succeeded: 1,
      failed: 1,
      transactions: [],
    };
    expect(recommendRetryStrategy(result)).toBe("retry_failed");
  });
});

describe("generateRollbackInstructions", () => {
  it("returns empty array when summary is all_success", () => {
    const result: BatchSubmissionResult = {
      ok: true,
      summary: "all_success",
      succeeded: 2,
      failed: 0,
      transactions: [
        { xdr: XDR_1, status: "success", hash: "hash_1" },
        { xdr: XDR_2, status: "success", hash: "hash_2" },
      ],
    };
    expect(buildRollbackInstructions(result)).toEqual([]);
  });

  it("returns empty array when summary is all_failed", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "all_failed",
      succeeded: 0,
      failed: 2,
      transactions: [
        { xdr: XDR_1, status: "failed", error: "Horizon error" },
        { xdr: XDR_2, status: "failed", error: "Horizon error" },
      ],
    };
    expect(buildRollbackInstructions(result)).toEqual([]);
  });

  it("returns one instruction per successful tx when summary is partial_success", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "partial_success",
      succeeded: 2,
      failed: 1,
      transactions: [
        { xdr: XDR_1, status: "success", hash: "hash_1" },
        { xdr: XDR_2, status: "failed", error: "Horizon error" },
        { xdr: XDR_3, status: "success", hash: "hash_3" },
      ],
    };
    const instructions = buildRollbackInstructions(result);
    expect(instructions).toHaveLength(2);
    expect(instructions[0].hash).toBe("hash_1");
    expect(instructions[0].xdr).toBe(XDR_1);
    expect(instructions[0].reason).toBeTruthy();
    expect(instructions[1].hash).toBe("hash_3");
    expect(instructions[1].xdr).toBe(XDR_3);
  });

  it("does not include failed entries in rollback instructions", () => {
    const result: BatchSubmissionResult = {
      ok: false,
      summary: "partial_success",
      succeeded: 1,
      failed: 1,
      transactions: [
        { xdr: XDR_1, status: "success", hash: "hash_1" },
        { xdr: XDR_2, status: "failed", error: "Horizon error" },
      ],
    };
    const instructions = buildRollbackInstructions(result);
    expect(instructions.every((i) => i.xdr !== XDR_2)).toBe(true);
    expect(instructions).toHaveLength(1);
  });
});

describe("submitBatch — stub verification", () => {
  it("fails the test if submitTransaction is not called when batch has items", async () => {
    mockSubmitTransaction.mockResolvedValueOnce(
      ok(makeSuccessResult("hash_1")),
    );
    await submitBatch([XDR_1], TEST_CONFIG);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it("passes the cache option through to submitTransaction when provided", async () => {
    const cache = makeMockCache();
    mockSubmitTransaction.mockResolvedValueOnce(
      ok(makeSuccessResult("hash_1")),
    );
    await submitBatch([XDR_1], { ...TEST_CONFIG, cache });
    expect(mockSubmitTransaction).toHaveBeenCalledWith(
      TEST_CONFIG.horizonUrl,
      TEST_CONFIG.networkPassphrase,
      XDR_1,
      cache,
    );
  });
});
