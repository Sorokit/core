import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withExecutionPolicy, cleanupAllExecutionPolicies } from "../soroban/contractCallExecutionPolicy";
import { recordKeyRotation, getKeyRotationHistory, detectSuspiciousRotationPattern, clearKeyRotationAuditLog } from "../account/keyRotationAudit";
import { recordContractInvocation, queryContractAuditLog, exportAuditLogAsJson, exportAuditLogAsCsv, clearContractAuditLog } from "../soroban/contractAuditTrail";
import { verifyTransactionSignatures } from "../transaction/witnessValidation";
import { ok, err, SorokitErrorCode } from "../shared/response";

describe("Contract Call Execution Policy (#509)", () => {
  beforeEach(() => {
    cleanupAllExecutionPolicies();
  });

  afterEach(() => {
    cleanupAllExecutionPolicies();
  });

  it("returns result immediately when no policy provided", async () => {
    const result = await withExecutionPolicy(async () => ok("success"));
    expect(result.status).toBe("ok");
    expect(result.data).toBe("success");
  });

  it("returns timeout error when operation takes too long", async () => {
    const result = await withExecutionPolicy(
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return ok("late");
      },
      { timeoutMs: 50 },
    );
    expect(result.status).toBe("error");
    expect(result.error.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
  });

  it("returns result when operation completes within timeout", async () => {
    const result = await withExecutionPolicy(
      async () => ok("fast"),
      { timeoutMs: 1000 },
    );
    expect(result.status).toBe("ok");
    expect(result.data).toBe("fast");
  });

  it("returns abort error when signal is aborted", async () => {
    const controller = new AbortController();
    const result = withExecutionPolicy(
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return ok("late");
      },
      { abortSignal: controller.signal, timeoutMs: 5000 },
    );

    controller.abort();
    const resolved = await result;
    expect(resolved.status).toBe("error");
    expect(resolved.error.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
  });

  it("returns abort error when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await withExecutionPolicy(
      async () => ok("never"),
      { abortSignal: controller.signal },
    );
    expect(result.status).toBe("error");
    expect(result.error.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
  });

  it("uses default 30s timeout when not specified", async () => {
    const result = await withExecutionPolicy(async () => ok("ok"));
    expect(result.status).toBe("ok");
  });

  it("handles contract call errors gracefully", async () => {
    const result = await withExecutionPolicy(
      async () => { throw new Error("boom"); },
      { timeoutMs: 1000 },
    );
    expect(result.status).toBe("error");
    expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
  });
});

describe("Key Rotation Audit (#511)", () => {
  beforeEach(() => {
    clearKeyRotationAuditLog();
  });

  it("records a successful key rotation", () => {
    const entry = recordKeyRotation({
      account: "GABC123",
      previousSigner: "GOLD_KEY",
      newSigner: "GNEW_KEY",
      status: "success",
    });
    expect(entry.account).toBe("GABC123");
    expect(entry.previousSigner).toBe("GOLD_KEY");
    expect(entry.newSigner).toBe("GNEW_KEY");
    expect(entry.status).toBe("success");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("records a failed key rotation", () => {
    const entry = recordKeyRotation({
      account: "GABC123",
      previousSigner: "GOLD_KEY",
      newSigner: "GNEW_KEY",
      status: "failed",
      reason: "Invalid signature",
    });
    expect(entry.status).toBe("failed");
    expect(entry.reason).toBe("Invalid signature");
  });

  it("retrieves rotation history for an account", () => {
    recordKeyRotation({ account: "GABC", previousSigner: "K1", newSigner: "K2", status: "success" });
    recordKeyRotation({ account: "GABC", previousSigner: "K2", newSigner: "K3", status: "success" });
    recordKeyRotation({ account: "GXYZ", previousSigner: "K4", newSigner: "K5", status: "success" });

    const history = getKeyRotationHistory("GABC");
    expect(history).toHaveLength(2);
    expect(history[0].newSigner).toBe("K2");
    expect(history[1].newSigner).toBe("K3");
  });

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      recordKeyRotation({ account: "GABC", previousSigner: `K${i}`, newSigner: `K${i + 1}`, status: "success" });
    }

    const page1 = getKeyRotationHistory("GABC", { limit: 2, offset: 0 });
    const page2 = getKeyRotationHistory("GABC", { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
  });

  it("filters by status", () => {
    recordKeyRotation({ account: "GABC", previousSigner: "K1", newSigner: "K2", status: "success" });
    recordKeyRotation({ account: "GABC", previousSigner: "K2", newSigner: "K3", status: "failed" });

    const successes = getKeyRotationHistory("GABC", { status: "success" });
    const failures = getKeyRotationHistory("GABC", { status: "failed" });
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it("detects suspicious rotation pattern", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      recordKeyRotation({ account: "GABC", previousSigner: `K${i}`, newSigner: `K${i + 1}`, status: "success" });
    }
    expect(detectSuspiciousRotationPattern("GABC", 60000, 3)).toBe(true);
    expect(detectSuspiciousRotationPattern("GABC", 60000, 10)).toBe(false);
  });

  it("returns empty history for unknown account", () => {
    const history = getKeyRotationHistory("GUNKNOWN");
    expect(history).toHaveLength(0);
  });
});

describe("Contract Audit Trail (#516)", () => {
  beforeEach(() => {
    clearContractAuditLog();
  });

  it("records a contract invocation", () => {
    const entry = recordContractInvocation({
      caller: "GCALLER",
      contractId: "CABC123",
      functionName: "transfer",
      transactionId: "tx_hash_123",
      status: "success",
      durationMs: 150,
    });
    expect(entry.caller).toBe("GCALLER");
    expect(entry.functionName).toBe("transfer");
    expect(entry.status).toBe("success");
    expect(entry.durationMs).toBe(150);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("queries audit log with filters", () => {
    recordContractInvocation({ caller: "G1", contractId: "C1", functionName: "transfer", status: "success" });
    recordContractInvocation({ caller: "G1", contractId: "C2", functionName: "swap", status: "failed" });
    recordContractInvocation({ caller: "G2", contractId: "C1", functionName: "transfer", status: "success" });

    const filtered = queryContractAuditLog({ caller: "G1" });
    expect(filtered).toHaveLength(2);
  });

  it("supports pagination and ordering", () => {
    for (let i = 0; i < 5; i++) {
      recordContractInvocation({ caller: "G1", contractId: "C1", functionName: "fn", status: "success" });
    }

    const page = queryContractAuditLog({ limit: 2, offset: 2 });
    expect(page).toHaveLength(2);
  });

  it("exports as JSON", () => {
    recordContractInvocation({ caller: "G1", contractId: "C1", functionName: "fn", status: "success" });
    const json = exportAuditLogAsJson();
    expect(json).toContain("G1");
    expect(JSON.parse(json)).toHaveLength(1);
  });

  it("exports as CSV", () => {
    recordContractInvocation({ caller: "G1", contractId: "C1", functionName: "fn", status: "success" });
    const csv = exportAuditLogAsCsv();
    expect(csv).toContain("timestamp,caller,contractId");
    expect(csv).toContain("G1");
  });

  it("returns empty CSV for empty log", () => {
    expect(exportAuditLogAsCsv()).toBe("");
  });

  it("filters by date range", () => {
    const now = Date.now();
    recordContractInvocation({ caller: "G1", contractId: "C1", functionName: "fn", status: "success" });
    const recent = queryContractAuditLog({ since: now - 1000 });
    expect(recent).toHaveLength(1);
  });
});

describe("Transaction Witness Validation (#510)", () => {
  it("returns error for invalid XDR", () => {
    const result = verifyTransactionSignatures("invalid-xdr", "Test SDF Network ; September 2015");
    expect(result.status).toBe("error");
    expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
  });
});
