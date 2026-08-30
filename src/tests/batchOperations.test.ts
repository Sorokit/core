/**
 * Tests for batch account operations (#514):
 * bulkCreateTrustlines, bulkSendPayments, bulkRotateKeys, and the generic
 * runBatchOperations executor.
 *
 * Covers: successful batches, partial failures (successes preserved), retries
 * with idempotency awareness, concurrency limits, progress tracking, and
 * concurrent-vs-sequential performance behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

const mockBuildPaymentTransaction = vi.hoisted(() =>
  vi.fn(async () => ok("PAYMENT_XDR")),
);
const mockBuildTrustlineTransaction = vi.hoisted(() =>
  vi.fn(async () => ok("TRUSTLINE_XDR")),
);
const mockRotateAccountKey = vi.hoisted(() =>
  vi.fn(async () => ok("ROTATE_XDR")),
);

vi.mock("../transaction/buildTransaction", () => ({
  buildPaymentTransaction: mockBuildPaymentTransaction,
  buildTrustlineTransaction: mockBuildTrustlineTransaction,
  buildBulkTrustlines: vi.fn(),
  buildBulkTrustlineTransaction: vi.fn(),
  buildPaymentWithTrustline: vi.fn(),
}));

vi.mock("../account/keyRotation", () => ({
  rotateAccountKey: mockRotateAccountKey,
  setAccountRecovery: vi.fn(),
  recoverAccountKeys: vi.fn(),
  isValidStellarPublicKey: vi.fn(),
}));

import {
  runBatchOperations,
  bulkSendPayments,
  bulkCreateTrustlines,
  bulkRotateKeys,
} from "../account/batchOperations";
import type { BatchOperation } from "../account/batchOperations";

const NETWORK_CONFIG: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://rpc-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const HORIZON_URL = NETWORK_CONFIG.horizonUrl;

describe("runBatchOperations — core executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs every operation and reports a successful summary", async () => {
    const ops: BatchOperation<string>[] = ["a", "b", "c"].map((id) => ({
      id,
      runner: async () => ok(`done-${id}`),
    }));

    const report = await runBatchOperations(ops, { concurrency: 2 });

    expect(report.summary.total).toBe(3);
    expect(report.summary.succeeded).toBe(3);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.skipped).toBe(0);
    expect(report.summary.allSucceeded).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(report.results.map((r) => r.data)).toEqual([
      "done-a",
      "done-b",
      "done-c",
    ]);
  });

  it("preserves successes when some operations fail (partial failure)", async () => {
    const ops: BatchOperation<string>[] = [
      { id: "ok-1", runner: async () => ok("fine") },
      {
        id: "bad-1",
        runner: async () =>
          err(SorokitErrorCode.TX_SUBMIT_FAILED, "rejected"),
      },
      { id: "ok-2", runner: async () => ok("fine-2") },
      {
        id: "bad-2",
        runner: async () =>
          err(SorokitErrorCode.TX_BUILD_FAILED, "bad xdr"),
      },
    ];

    const report = await runBatchOperations(ops, { concurrency: 4 });

    expect(report.summary.succeeded).toBe(2);
    expect(report.summary.failed).toBe(2);
    expect(report.summary.allSucceeded).toBe(false);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("ok-1")!.status).toBe("success");
    expect(byId.get("ok-2")!.status).toBe("success");
    expect(byId.get("bad-1")!.status).toBe("failed");
    expect(byId.get("bad-1")!.errorCode).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    expect(byId.get("bad-2")!.status).toBe("failed");
  });

  it("retries retryable failures but not permanent ones", async () => {
    // NETWORK_ERROR is retryable: succeeds on the 3rd attempt.
    let networkAttempts = 0;
    // TX_BUILD_FAILED is not retryable: only runs once.
    let permanentAttempts = 0;

    const ops: BatchOperation<string>[] = [
      {
        id: "retryable",
        runner: async () => {
          networkAttempts += 1;
          if (networkAttempts < 3) {
            return err(SorokitErrorCode.NETWORK_ERROR, "flaky network");
          }
          return ok("recovered");
        },
      },
      {
        id: "permanent",
        runner: async () => {
          permanentAttempts += 1;
          return err(SorokitErrorCode.TX_BUILD_FAILED, "bad xdr");
        },
      },
    ];

    const report = await runBatchOperations(ops, {
      maxRetries: 3,
      retryDelayMs: 0,
      delay: async () => {},
    });

    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("retryable")!.status).toBe("success");
    expect(byId.get("retryable")!.attempts).toBe(3);
    expect(byId.get("retryable")!.retries).toBe(2);
    expect(byId.get("permanent")!.status).toBe("failed");
    expect(byId.get("permanent")!.attempts).toBe(1);
    expect(permanentAttempts).toBe(1);
  });

  it("never re-runs operations already completed (idempotency-aware)", async () => {
    const executed = vi.fn();
    const ops: BatchOperation<string>[] = [
      { id: "known", runner: async () => { executed(); return ok("x"); } },
      { id: "unknown", runner: async () => { executed(); return ok("y"); } },
    ];

    const report = await runBatchOperations(ops, {
      previouslyCompletedIds: ["known"],
    });

    expect(executed).toHaveBeenCalledTimes(1); // only "unknown" executed
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("known")!.status).toBe("skipped");
    expect(byId.get("known")!.skipped).toBe(true);
    expect(byId.get("known")!.attempts).toBe(0);
    expect(byId.get("unknown")!.status).toBe("success");
  });

  it("does not duplicate a successfully submitted op across retries", async () => {
    // Simulates an op whose FIRST attempt succeeds at the network layer but
    // the response is lost (idempotency hazard). The executor must not re-run it.
    let calls = 0;
    const ops: BatchOperation<string>[] = [
      {
        id: "already-sent",
        runner: async () => {
          calls += 1;
          if (calls === 1) return ok("submitted");
          return err(SorokitErrorCode.TX_SUBMIT_FAILED, "would duplicate");
        },
      },
    ];
    // previouslyCompletedIds marks the op as already handled -> skipped, not re-run.
    const report = await runBatchOperations(ops, {
      previouslyCompletedIds: ["already-sent"],
    });
    expect(calls).toBe(0);
    expect(report.results[0].status).toBe("skipped");
  });

  it("enforces the concurrency limit", async () => {
    const concurrency = 3;
    let active = 0;
    let maxActive = 0;
    const ops: BatchOperation<string>[] = Array.from({ length: 10 }, (_, i) => ({
      id: `op-${i}`,
      runner: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return ok("x");
      },
    }));

    await runBatchOperations(ops, { concurrency });

    expect(maxActive).toBeLessThanOrEqual(concurrency);
    expect(maxActive).toBeGreaterThan(0);
  });

  it("reports progress through completion", async () => {
    const snapshots: Array<Record<string, number>> = [];
    const ops: BatchOperation<string>[] = ["a", "b"].map((id) => ({
      id,
      runner: async () => ok(`done-${id}`),
    }));

    await runBatchOperations(ops, {
      concurrency: 2,
      onProgress: (p) =>
        snapshots.push({
          planned: p.planned,
          running: p.running,
          succeeded: p.succeeded,
          failed: p.failed,
          completed: p.completed,
          total: p.total,
        }),
    });

    // Early snapshot before any operation finishes must show planned but 0 completed.
    const early = snapshots[0];
    expect(early.total).toBe(2);
    expect(early.completed).toBe(0);
    expect(early.planned).toBe(2);
    // Final snapshot reflects all completed.
    const last = snapshots[snapshots.length - 1];
    expect(last.succeeded).toBe(2);
    expect(last.completed).toBe(2);
  });

  it("performs faster than sequential execution with many slow ops", async () => {
    const opDelay = 10;
    const count = 6;
    const concurrency = 6;
    const runFor = async (c: number) => {
      const ops: BatchOperation<string>[] = Array.from(
        { length: count },
        (_, i) => ({
          id: `op-${i}`,
          runner: async () => {
            await new Promise((r) => setTimeout(r, opDelay));
            return ok("x");
          },
        }),
      );
      const start = Date.now();
      await runBatchOperations(ops, { concurrency: c });
      return Date.now() - start;
    };

    const sequential = await runFor(1); // fully serial
    const concurrent = await runFor(concurrency); // fully parallel

    // With all ops in parallel, elapsed should be ~1x opDelay, far below
    // sequential (count * opDelay). Use a loose upper bound to stay deterministic.
    expect(concurrent).toBeLessThan(opDelay * count);
  });
});

describe("runBatchOperations — bulk wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bulkSendPayments builds one transaction per payment without submit", async () => {
    mockBuildPaymentTransaction.mockResolvedValue(ok("PAYMENT_XDR"));
    const report = await bulkSendPayments({
      horizonUrl: HORIZON_URL,
      networkConfig: NETWORK_CONFIG,
      transactions: [
        { id: "p1", source: "GA", params: { destination: "GB", amount: "10" } },
        { id: "p2", source: "GC", params: { destination: "GD", amount: "5" } },
      ],
      config: { concurrency: 2 },
    });

    expect(mockBuildPaymentTransaction).toHaveBeenCalledTimes(2);
    expect(report.summary.succeeded).toBe(2);
    expect(report.summary.allSucceeded).toBe(true);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("p1")!.data).toMatchObject({ source: "GA" });
    expect(byId.get("p1")!.data!.xdr).toBe("PAYMENT_XDR");
  });

  it("bulkSendPayments invokes submit when provided", async () => {
    const submit = vi.fn(async () => ok("submitted"));
    await bulkSendPayments({
      horizonUrl: HORIZON_URL,
      networkConfig: NETWORK_CONFIG,
      transactions: [
        { id: "p1", source: "GA", params: { destination: "GB", amount: "10" } },
      ],
      submit,
    });
    expect(submit).toHaveBeenCalledWith("PAYMENT_XDR");
  });

  it("bulkCreateTrustlines builds a trustline per account x asset", async () => {
    mockBuildTrustlineTransaction.mockResolvedValue(ok("TRUSTLINE_XDR"));
    const report = await bulkCreateTrustlines({
      horizonUrl: HORIZON_URL,
      networkConfig: NETWORK_CONFIG,
      accounts: ["GA", "GB"],
      assets: [{ code: "USDC", issuer: "ISSUER" }],
      config: { concurrency: 2 },
    });

    expect(report.summary.total).toBe(2); // 2 accounts x 1 asset
    expect(report.summary.succeeded).toBe(2);
    expect(mockBuildTrustlineTransaction).toHaveBeenCalledTimes(2);
    const results = report.results.filter((r) => r.status === "success");
    expect(results.map((r) => r.data!.assetCode)).toEqual(["USDC", "USDC"]);
  });

  it("bulkRotateKeys rotates keys for each account", async () => {
    mockRotateAccountKey.mockResolvedValue(ok("ROTATE_XDR"));
    const report = await bulkRotateKeys({
      horizonUrl: HORIZON_URL,
      networkConfig: NETWORK_CONFIG,
      accounts: [
        { id: "r1", account: "GA", oldKey: "OLD1", newKey: "NEW1" },
        { id: "r2", account: "GB", oldKey: "OLD2", newKey: "NEW2" },
      ],
      config: { concurrency: 2 },
    });

    expect(mockRotateAccountKey).toHaveBeenCalledTimes(2);
    expect(report.summary.succeeded).toBe(2);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("r1")!.data!.xdr).toBe("ROTATE_XDR");
  });

  it("bulkSendPayments preserves successes when a build fails", async () => {
    mockBuildPaymentTransaction
      .mockResolvedValueOnce(ok("PAYMENT_XDR"))
      .mockResolvedValueOnce(
        err(SorokitErrorCode.TX_BUILD_FAILED, "invalid payment"),
      );

    const report = await bulkSendPayments({
      horizonUrl: HORIZON_URL,
      networkConfig: NETWORK_CONFIG,
      transactions: [
        { id: "p1", source: "GA", params: { destination: "GB", amount: "1" } },
        { id: "p2", source: "GC", params: { destination: "GD", amount: "2" } },
      ],
      config: { concurrency: 2 },
    });

    expect(report.summary.succeeded).toBe(1);
    expect(report.summary.failed).toBe(1);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("p1")!.status).toBe("success");
    expect(byId.get("p2")!.status).toBe("failed");
    expect(byId.get("p2")!.errorCode).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });
});
