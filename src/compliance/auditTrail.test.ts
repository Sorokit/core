import { describe, expect, it } from "vitest";
import {
  clearAuditTrail,
  createAuditTrail,
  getAllEntries,
  queryAuditLog,
  recordAction,
  recordOperation,
} from "./auditTrail";
import type { AuditQueryOptions } from "./auditTrail";
import { SorokitErrorCode } from "../shared/response";

describe("audit trail", () => {
  it("records immutable snapshots and filters them", () => {
    const audit = createAuditTrail();
    const context = { before: { balance: 1 }, after: { balance: 2 } };
    const first = audit.recordOperation("payment", "alice", context);
    context.after.balance = 999;
    audit.recordOperation("contract", "bob", {});
    expect(first).toMatchObject({ status: "ok", data: { sequence: 1, action: "payment", operation: "payment" } });
    const filtered = audit.getAuditTrail({ actor: "alice" });
    expect(filtered.status === "ok" && filtered.data).toHaveLength(1);
    expect(filtered.status === "ok" && filtered.data[0]?.context.after).toEqual({ balance: 2 });
  });

  it("generates a date-range compliance report", () => {
    const audit = createAuditTrail();
    audit.recordOperation("payment", "alice", {});
    audit.recordOperation("payment", "bob", {});
    const report = audit.generateComplianceReport({ start: "2000-01-01", end: "2100-01-01" });
    expect(report).toMatchObject({ status: "ok", data: { totalOperations: 2, operationsByType: { payment: 2 } } });
  });

  describe("queryAuditLog date range queries (#774)", () => {
    const t1 = "2025-01-10T10:00:00.000Z";
    const t2 = "2025-02-15T12:00:00.000Z";
    const t3 = "2025-03-20T14:00:00.000Z";
    const t4 = "2025-04-25T16:00:00.000Z";

    function setupSampleAudit() {
      const audit = createAuditTrail();
      audit.recordOperation("payment", "alice", { amount: 100 }, t1);
      audit.recordOperation("transfer", "bob", { amount: 200 }, t2);
      audit.recordAction("payment", "charlie", { amount: 300 }, t3);
      audit.recordAction("contract_call", "alice", { fee: 5 }, t4);
      return audit;
    }

    it("queries logs using ISO string startTime and endTime", () => {
      const audit = setupSampleAudit();
      const options: AuditQueryOptions = {
        startTime: "2025-02-01T00:00:00.000Z",
        endTime: "2025-03-31T23:59:59.999Z",
      };
      const result = audit.queryAuditLog(options);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data.map((r) => r.actor)).toEqual(["bob", "charlie"]);
      }
    });

    it("queries logs using Date objects for startTime and endTime", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: new Date("2025-01-01T00:00:00.000Z"),
        endTime: new Date("2025-02-28T23:59:59.999Z"),
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data.map((r) => r.actor)).toEqual(["alice", "bob"]);
      }
    });

    it("queries logs using numeric epoch timestamps (ms)", () => {
      const audit = setupSampleAudit();
      const startMs = new Date(t2).getTime();
      const endMs = new Date(t3).getTime();
      const result = audit.queryAuditLog({
        startTime: startMs,
        endTime: endMs,
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data[0]?.actor).toBe("bob");
        expect(result.data[1]?.actor).toBe("charlie");
      }
    });

    it("supports open-ended range with only startTime", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-03-01T00:00:00.000Z",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data.map((r) => r.actor)).toEqual(["charlie", "alice"]);
      }
    });

    it("supports open-ended range with only endTime", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        endTime: "2025-02-01T00:00:00.000Z",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.actor).toBe("alice");
      }
    });

    it("returns all entries when no range or filters are provided", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(4);
      }
    });

    it("handles edge case: startTime === endTime matching exact entry", () => {
      const audit = setupSampleAudit();
      const exactTime = t2;
      const result = audit.queryAuditLog({
        startTime: exactTime,
        endTime: exactTime,
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.actor).toBe("bob");
        expect(result.data[0]?.timestamp).toBe(t2);
      }
    });

    it("handles edge case: startTime === endTime with no matching entry", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-02-15T12:00:00.001Z",
        endTime: "2025-02-15T12:00:00.001Z",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual([]);
      }
    });

    it("handles edge case: no entries in date range", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2024-01-01T00:00:00.000Z",
        endTime: "2024-12-31T23:59:59.999Z",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual([]);
      }
    });

    it("returns error when startTime is after endTime", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-05-01T00:00:00.000Z",
        endTime: "2025-01-01T00:00:00.000Z",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(result.error.message).toBe("Invalid audit date range");
      }
    });

    it("returns error when startTime or endTime is an invalid date string", () => {
      const audit = setupSampleAudit();
      const invalidStart = audit.queryAuditLog({ startTime: "invalid-date" });
      expect(invalidStart.status).toBe("error");
      if (invalidStart.status === "error") {
        expect(invalidStart.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }

      const invalidEnd = audit.queryAuditLog({ endTime: "not-a-date" });
      expect(invalidEnd.status).toBe("error");
      if (invalidEnd.status === "error") {
        expect(invalidEnd.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("combines date range with actor filter", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-01-01T00:00:00.000Z",
        endTime: "2025-03-31T23:59:59.999Z",
        actor: "alice",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.actor).toBe("alice");
        expect(result.data[0]?.timestamp).toBe(t1);
      }
    });

    it("combines date range with action filter", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-01-01T00:00:00.000Z",
        endTime: "2025-03-31T23:59:59.999Z",
        action: "payment",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
        expect(result.data.map((r) => r.actor)).toEqual(["alice", "charlie"]);
      }
    });

    it("combines date range with operation filter", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-01-01T00:00:00.000Z",
        endTime: "2025-04-30T23:59:59.999Z",
        operation: "payment",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(2);
      }
    });

    it("returns empty when actor matches but falls outside date range", () => {
      const audit = setupSampleAudit();
      const result = audit.queryAuditLog({
        startTime: "2025-02-01T00:00:00.000Z",
        endTime: "2025-03-01T00:00:00.000Z",
        actor: "alice",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual([]);
      }
    });

    it("getAllEntries returns all recorded entries", () => {
      const audit = setupSampleAudit();
      const result = audit.getAllEntries();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toHaveLength(4);
      }
    });

    it("clear resets audit trail entries", () => {
      const audit = setupSampleAudit();
      expect(audit.getAllEntries().status === "ok" && audit.getAllEntries().data).toHaveLength(4);
      audit.clear();
      expect(audit.getAllEntries().status === "ok" && audit.getAllEntries().data).toHaveLength(0);
    });

    it("default instance methods and clearAuditTrail work correctly", () => {
      clearAuditTrail();
      recordOperation("op1", "user1", {}, t1);
      recordAction("act2", "user2", {}, t2);

      const queryRes = queryAuditLog({ startTime: t1, endTime: t1 });
      expect(queryRes.status).toBe("ok");
      if (queryRes.status === "ok") {
        expect(queryRes.data).toHaveLength(1);
        expect(queryRes.data[0]?.actor).toBe("user1");
      }

      const all = getAllEntries();
      expect(all.status).toBe("ok");
      if (all.status === "ok") {
        expect(all.data).toHaveLength(2);
      }

      clearAuditTrail();
      const afterClear = getAllEntries();
      expect(afterClear.status === "ok" && afterClear.data).toHaveLength(0);
    });

    it("validates invalid customTimestamp on recordOperation", () => {
      const audit = createAuditTrail();
      const invalidRes = audit.recordOperation("op", "actor", {}, "not-a-timestamp");
      expect(invalidRes.status).toBe("error");
      if (invalidRes.status === "error") {
        expect(invalidRes.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(invalidRes.error.message).toBe("Invalid timestamp");
      }
    });

    it("rejects empty operation or actor", () => {
      const audit = createAuditTrail();
      const opErr = audit.recordOperation("   ", "alice");
      expect(opErr.status).toBe("error");
      if (opErr.status === "error") {
        expect(opErr.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }

      const actErr = audit.recordAction("payment", "  ");
      expect(actErr.status).toBe("error");
      if (actErr.status === "error") {
        expect(actErr.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("generateComplianceReport returns error when date range is invalid", () => {
      const audit = setupSampleAudit();
      const report = audit.generateComplianceReport({ start: "2025-12-31", end: "2025-01-01" });
      expect(report.status).toBe("error");
      if (report.status === "error") {
        expect(report.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("correctly handles epoch 0 timestamp", () => {
      const audit = createAuditTrail();
      audit.recordOperation("genesis", "system", {}, 0);
      const res = audit.queryAuditLog({ startTime: 0, endTime: 0 });
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data).toHaveLength(1);
        expect(res.data[0]?.actor).toBe("system");
      }
    });
  });

  describe("compliance index barrel re-exports", () => {
    it("exports all public compliance APIs and types", async () => {
      const compliance = await import("./index");
      expect(typeof compliance.createAuditTrail).toBe("function");
      expect(typeof compliance.queryAuditLog).toBe("function");
      expect(typeof compliance.getAllEntries).toBe("function");
      expect(typeof compliance.recordOperation).toBe("function");
      expect(typeof compliance.recordAction).toBe("function");
      expect(typeof compliance.getAuditTrail).toBe("function");
      expect(typeof compliance.clearAuditTrail).toBe("function");
      expect(typeof compliance.generateComplianceReport).toBe("function");
    });
  });
});


