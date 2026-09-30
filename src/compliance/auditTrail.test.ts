import { describe, expect, it } from "vitest";
import { createAuditTrail } from "./auditTrail";

describe("audit trail", () => {
  it("records immutable snapshots and filters them", () => {
    const audit = createAuditTrail();
    const context = { before: { balance: 1 }, after: { balance: 2 } };
    const first = audit.recordOperation("payment", "alice", context);
    context.after.balance = 999;
    audit.recordOperation("contract", "bob", {});
    expect(first).toMatchObject({ status: "ok", data: { sequence: 1 } });
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
});
