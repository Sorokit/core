/**
 * REV9 API-compatibility regression suite.
 *
 * Covers the public-contract fixes required by the REV9 review:
 *  - submitBatch call shapes and option semantics (atomic, continueOnError, timeout)
 *  - explicit helper return types (no return-type-only overloads)
 *  - collision-safe EventIndex identity (framed parts, structural payloads)
 *  - decodeContractEvent legacy aliases/case normalisation and ABI mode
 *  - timeLocks legacy validation and sync vs sequence-aware shapes
 *
 * Submission is fully mocked: no live Horizon call is made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

const { mockSubmitTransaction } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
}));

vi.mock("../transaction/submitTransaction", () => ({
  submitTransaction: mockSubmitTransaction,
}));

import { err, ok, SorokitErrorCode } from "../shared/response";
import {
  buildRollbackInstructions,
  generateRollbackInstructions,
  isBatchAtomicComplete,
  recommendRetryStrategy,
  submitBatch,
  suggestRetryStrategy,
  wasAtomicExecuted,
} from "../transaction/batchSubmitter";
import type { BatchSubmissionResult } from "../transaction/batchSubmitter";
import { buildTimeLockTransaction } from "../transaction/timeLocks";
import {
  decodeContractEvent,
  decodeContractEventWithAbi,
} from "../soroban/decodeContractEvent";
import type { ContractEventDecoder } from "../soroban/decodeContractEvent";
import { EventIndex, canonicalEventKey } from "../soroban/eventIndex";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const TARGET = { horizonUrl: HORIZON_URL, networkPassphrase: Networks.TESTNET };

/** Valid testnet-format G-address; public value, no secret material. */
const VALID_KEY = "GCFQYP2MMXX2G2PLAQP5ASKP3WBDX6IDXVBOEQOBE7HC3W3N5YX5IGOB";
const XDR_1 = "AAAAAQAAAAA=";
const XDR_2 = "AAAABQAAAAA=";
const XDR_3 = "AAAACQAAAAA=";

function makeBatchResult(
  overrides: Partial<BatchSubmissionResult> = {},
): BatchSubmissionResult {
  return {
    submitted: 2,
    succeeded: 1,
    failed: 1,
    status: "partial_success",
    transactions: [
      { xdr: XDR_1, status: "success", hash: "hash-1" },
      { xdr: XDR_2, status: "failed", error: "tx_failed" },
    ],
    atomic: false,
    atomicSupported: false,
    rollbackOnFailure: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockSubmitTransaction.mockReset();
});

// ─── submitBatch call shapes and option semantics ────────────────────────────

describe("submitBatch call shapes", () => {
  it("submission mode returns a Promise and resolves through the mock", async () => {
    mockSubmitTransaction.mockResolvedValue(
      ok({ hash: "hash-1", status: "success", ledger: 7 }),
    );

    const pending = submitBatch([XDR_1], TARGET);
    expect(typeof (pending as Promise<unknown>).then).toBe("function");

    const result = await pending;
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.mode).toBe("submission");
    expect(result.data.summary).toBe("all_success");
    expect(result.data.atomicSupported).toBe(false);
  });

  it("planning mode is synchronous and never claims a submission", () => {
    const planned = submitBatch([XDR_1, XDR_2], { atomic: false });

    expect((planned as { then?: unknown }).then).toBeUndefined();
    expect(planned.status).toBe("ok");
    if (planned.status !== "ok") throw new Error("unreachable");
    expect(planned.data.mode).toBe("planning");
    expect(planned.data.status).toBe("planned");
    expect(planned.data.submitted).toBe(0);
    expect(planned.data.succeeded).toBe(0);
    expect(planned.data.failed).toBe(0);
    expect(planned.data.atomicSupported).toBe(false);
    expect(planned.data.transactions.every((tx) => tx.status === "pending")).toBe(true);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("atomic: true fails closed instead of claiming atomic submission", async () => {
    const result = await submitBatch([XDR_1], { ...TARGET, atomic: true });

    expect(result.status).toBe("error");
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("continueOnError: false stops after the first failure and marks the rest skipped", async () => {
    mockSubmitTransaction.mockResolvedValue(
      err(SorokitErrorCode.TX_SUBMIT_FAILED, "horizon rejected"),
    );

    const result = await submitBatch([XDR_1, XDR_2, XDR_3], {
      ...TARGET,
      continueOnError: false,
    });

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.skipped).toBe(2);
    expect(result.data.failed).toBe(1);
    expect(result.data.succeeded).toBe(0);
    expect(result.data.summary).toBe("partial_success");
    expect(result.data.transactions.map((tx) => tx.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
  });

  it("timeout marks a hanging submission as failed", async () => {
    mockSubmitTransaction.mockImplementation(() => new Promise(() => {}));

    const result = await submitBatch([XDR_1], { ...TARGET, timeout: 25 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.transactions[0]?.status).toBe("failed");
    expect(result.data.transactions[0]?.error).toContain("timed out");
    expect(result.data.summary).toBe("all_failed");
    expect(result.data.atomicSupported).toBe(false);
  });

  it("parallel + continueOnError: false is rejected instead of starting every submission", async () => {
    const result = await submitBatch([XDR_1, XDR_2], { ...TARGET, mode: "parallel", continueOnError: false });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
    expect(result.error.message).toMatch(/mode: "parallel"/);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it("timeout aborts the in-flight request and reports an unknown outcome", async () => {
    let seenSignal: AbortSignal | undefined;
    mockSubmitTransaction.mockImplementation((...args: unknown[]) => {
      const submissionOptions = args[4] as { signal?: AbortSignal } | undefined;
      seenSignal = submissionOptions?.signal;
      return new Promise((_resolve, reject) => {
        submissionOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")));
      });
    });

    const result = await submitBatch([XDR_1], { ...TARGET, timeout: 25 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    const entry = result.data.transactions[0];
    expect(entry?.status).toBe("failed");
    expect(String(entry?.error)).toMatch(/timed out after 25ms and was aborted/);
    expect(String(entry?.error)).toMatch(/do not auto-retry/);
    expect(seenSignal?.aborted).toBe(true);
  });
});

// ─── Helper return contracts ─────────────────────────────────────────────────

describe("rollback, atomic and retry helpers", () => {
  const partial = makeBatchResult();
  const allSuccess = makeBatchResult({
    submitted: 2,
    succeeded: 2,
    failed: 0,
    status: "all_success",
    transactions: [
      { xdr: XDR_1, status: "success", hash: "hash-1" },
      { xdr: XDR_2, status: "success", hash: "hash-2" },
    ],
  });
  const allFailed = makeBatchResult({
    submitted: 2,
    succeeded: 0,
    failed: 2,
    status: "all_failed",
    transactions: [
      { xdr: XDR_1, status: "failed", error: "tx_failed" },
      { xdr: XDR_2, status: "failed", error: "tx_failed" },
    ],
  });
  const planned = makeBatchResult({
    submitted: 0,
    succeeded: 0,
    failed: 0,
    status: "planned",
    mode: "planning",
    transactions: [
      { xdr: XDR_1, status: "pending" },
      { xdr: XDR_2, status: "pending" },
    ],
  });

  it("structured helpers return plain values while legacy helpers stay wrapped", () => {
    expect(buildRollbackInstructions(partial).map((entry) => entry.xdr)).toEqual([XDR_1]);
    expect(buildRollbackInstructions(allSuccess)).toEqual([]);
    expect(buildRollbackInstructions(allFailed)).toEqual([]);
    expect(buildRollbackInstructions(planned)).toEqual([]);

    expect(generateRollbackInstructions(partial).status).toBe("ok");
    expect(suggestRetryStrategy(partial).status).toBe("ok");
    expect(wasAtomicExecuted(partial).status).toBe("ok");
  });

  it("reports atomic completion and retry guidance from the summary", () => {
    expect(isBatchAtomicComplete(allSuccess)).toBe(true);
    expect(isBatchAtomicComplete(partial)).toBe(false);
    expect(isBatchAtomicComplete(allFailed)).toBe(false);

    expect(recommendRetryStrategy(allSuccess)).toBe("none");
    expect(recommendRetryStrategy(allFailed)).toBe("retry_all");
    expect(recommendRetryStrategy(partial)).toBe("retry_failed");
  });
});

// ─── EventIndex canonical identity ───────────────────────────────────────────

describe("EventIndex canonical identity", () => {
  it("does not conflate distinct nested payloads", () => {
    const index = new EventIndex();
    const first = {
      contractId: "C_A",
      ledger: 3,
      topics: ["transfer"],
      value: { amount: 1, to: "G1" },
    };
    const second = {
      contractId: "C_A",
      ledger: 3,
      topics: ["transfer"],
      value: { amount: 2, to: "G1" },
    };

    expect(index.add(first)).toBe(false);
    expect(index.add(second)).toBe(false);
    expect(index.size).toBe(2);
    expect(index.has(second)).toBe(true);
  });

  it("treats identical re-delivery as a duplicate", () => {
    const index = new EventIndex();
    const event = { id: "evt-1", pagingToken: "tok-1", contractId: "C_A", ledger: 1 };

    expect(index.add(event)).toBe(false);
    expect(index.add({ ...event })).toBe(true);
    expect(index.size).toBe(1);
  });

  it("keeps identifier boundaries unambiguous", () => {
    const index = new EventIndex();
    const left = { id: "ab", pagingToken: "c", contractId: "C_A", ledger: 1 };
    const right = { id: "b", pagingToken: "ac", contractId: "C_A", ledger: 1 };

    expect(index.add(left)).toBe(false);
    expect(index.add(right)).toBe(false);
    expect(index.size).toBe(2);
    expect(index.has(left)).toBe(true);
    expect(index.has(right)).toBe(true);
  });

  it("distinguishes payloads whose default stringification is identical", () => {
    const a = { contractId: "C_A", ledger: 2, topics: ["t"], value: { nested: { x: 1, y: 2 } } };
    const b = { contractId: "C_A", ledger: 2, topics: ["t"], value: { nested: { y: 2, x: 1 } } };
    const c = { contractId: "C_A", ledger: 2, topics: ["t"], value: { nested: { x: 1, y: 3 } } };

    expect(String(a.value)).toBe(String(b.value));
    expect(canonicalEventKey(a)).toBe(canonicalEventKey(b));
    expect(canonicalEventKey(a)).not.toBe(canonicalEventKey(c));
    expect(canonicalEventKey(a)).toBe(canonicalEventKey(a));
  });

  it("evicts the oldest entry once maxSize is reached", () => {
    const index = new EventIndex(2);
    const first = { id: "evt-1", contractId: "C_A", ledger: 1 };
    const second = { id: "evt-2", contractId: "C_A", ledger: 2 };
    const third = { id: "evt-3", contractId: "C_A", ledger: 3 };

    index.add(first);
    index.add(second);
    index.add(third);

    expect(index.size).toBe(2);
    expect(index.has(first)).toBe(false);
    expect(index.has(second)).toBe(true);
    expect(index.has(third)).toBe(true);
  });
});

// ─── decodeContractEvent contracts ───────────────────────────────────────────

describe("decodeContractEvent legacy decoder list", () => {
  it("normalises case and accepts the paircreated/created aliases", () => {
    const upper = decodeContractEvent({
      contractId: "C1",
      topics: ["PAIR_CREATED"],
      value: ["a", "b", "c"],
    });
    expect(upper?.type).toBe("factory.pair_created");

    const alias = decodeContractEvent({
      contractId: "C1",
      name: "paircreated",
      value: ["a", "b", "c"],
    });
    expect(alias?.type).toBe("factory.pair_created");

    const created = decodeContractEvent({
      contractId: "C1",
      name: "Created",
      value: ["a", "b", "c"],
    });
    expect(created?.type).toBe("factory.pair_created");
  });

  it("falls back to the trailing topic and keeps the raw event", () => {
    const event = {
      contractId: "C1",
      topics: ["factory", "PAIR_CREATED"],
      value: ["a", "b", "c"],
    };
    const decoded = decodeContractEvent(event);

    expect(decoded?.type).toBe("factory.pair_created");
    expect(decoded?.name).toBe("pair_created");
    expect(decoded?.raw).toBe(event);
  });

  it("accepts the router swap aliases and still requires a path array", () => {
    const swapped = decodeContractEvent({
      contractId: "C2",
      name: "swapped",
      value: ["G1", ["G1", "G2"], "10", "9"],
    });
    expect(swapped?.type).toBe("router.swap");

    const executed = decodeContractEvent({
      contractId: "C2",
      name: "SWAP_EXECUTED",
      value: ["G1", ["G1", "G2"], "10", "9"],
    });
    expect(executed?.type).toBe("router.swap");

    const noPath = decodeContractEvent({
      contractId: "C2",
      name: "swap",
      value: ["G1", "G2", "10", "9"],
    });
    expect(noPath).toBeNull();
  });

  it("lets a custom decoder take precedence over the built-ins", () => {
    const custom: ContractEventDecoder = (event) => ({
      type: "custom.event",
      contractId: "C9",
      data: { seen: true },
      raw: event,
    });

    const decoded = decodeContractEvent(
      { contractId: "C1", name: "pair_created", value: ["a", "b", "c"] },
      [custom],
    );

    expect(decoded?.type).toBe("custom.event");
  });

  it("returns null when no decoder matches", () => {
    expect(decodeContractEvent({ contractId: "C1", name: "unrelated", value: [] })).toBeNull();
  });
});

describe("decodeContractEventWithAbi", () => {
  it("returns a stable SorokitResult shape", () => {
    const result = decodeContractEventWithAbi({
      contractId: "C1",
      name: "transfer",
      topics: ["t"],
      value: [1],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.contractId).toBe("C1");
    expect(result.data.name).toBe("transfer");
    expect(result.data.type).toBe("unknown");
  });

  it("reports malformed input as an error result", () => {
    const result = decodeContractEventWithAbi("not-an-event");

    expect(result.status).toBe("error");
  });
});

// ─── timeLocks call shapes ───────────────────────────────────────────────────

describe("timeLocks call shapes", () => {
  it("legacy shape rejects an invalid public key with INVALID_ADDRESS", () => {
    const result = buildTimeLockTransaction(
      "not-a-key",
      [{}],
      { minTime: 1, maxTime: 2 },
      Networks.TESTNET,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("legacy shape rejects inverted, zero and negative bounds", () => {
    const inverted = buildTimeLockTransaction(
      VALID_KEY,
      [{}],
      { minTime: 10, maxTime: 5 },
      Networks.TESTNET,
    );
    const zeroed = buildTimeLockTransaction(
      VALID_KEY,
      [{}],
      { minTime: 0, maxTime: 0 },
      Networks.TESTNET,
    );
    const negative = buildTimeLockTransaction(
      VALID_KEY,
      [{}],
      { minTime: -1, maxTime: 10 },
      Networks.TESTNET,
    );

    expect(inverted.status).toBe("error");
    expect(zeroed.status).toBe("error");
    expect(negative.status).toBe("error");
  });

  it("legacy shape is synchronous while the sequence-aware shape is a Promise", async () => {
    const legacy = buildTimeLockTransaction(
      VALID_KEY,
      [{}],
      { minTime: 1, maxTime: 4_000_000_000 },
      Networks.TESTNET,
    );
    expect((legacy as { then?: unknown }).then).toBeUndefined();

    const pending = buildTimeLockTransaction(
      HORIZON_URL,
      { networkPassphrase: Networks.TESTNET } as never,
      VALID_KEY,
      { timeBounds: { minTime: 1, maxTime: 4_000_000_000 }, sequence: "1" },
    );
    expect(typeof (pending as Promise<unknown>).then).toBe("function");

    const settled = await pending;
    expect(settled.status).toBe("ok");
  });
});
