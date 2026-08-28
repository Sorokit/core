import { describe, expect, it } from "vitest";
import {
  createSpendingPolicyEngine,
  SpendingPolicyEngine,
} from "../transaction/spendingPolicy";
import type { SpendingPolicyConfig } from "../transaction/spendingPolicy";

const NATIVE = "native";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST_A = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const DEST_B = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function engineWith(config?: SpendingPolicyConfig): SpendingPolicyEngine {
  return createSpendingPolicyEngine(config);
}

// A fixed instant so daily/monthly window maths stay deterministic.
const T = Date.UTC(2026, 4, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("setSpendingLimit", () => {
  it("stores a limit and returns the normalized amount", () => {
    const engine = engineWith();
    const result = engine.setSpendingLimit(NATIVE, "100.5000000", "daily");

    expect(result.status).toBe("ok");
    expect(result.data).toEqual({ asset: NATIVE, amount: "100.5", period: "daily" });
    expect(engine.listSpendingLimits()).toHaveLength(1);
  });

  it("rejects a malformed amount", () => {
    const engine = engineWith();
    const result = engine.setSpendingLimit(NATIVE, "not-a-number", "daily");

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects an amount with more precision than stroops allow", () => {
    const engine = engineWith();
    expect(engine.setSpendingLimit(NATIVE, "1.123456789", "daily").status).toBe("error");
  });

  it("rejects an empty asset", () => {
    expect(engineWith().setSpendingLimit("  ", "10", "daily").status).toBe("error");
  });

  it("replaces the ceiling when the same asset and period are reconfigured", () => {
    const engine = engineWith();
    engine.setSpendingLimit(NATIVE, "100", "daily");
    engine.setSpendingLimit(NATIVE, "250", "daily");

    expect(engine.listSpendingLimits()).toEqual([
      { asset: NATIVE, amount: "250", period: "daily" },
    ]);
  });

  it("removes a configured limit", () => {
    const engine = engineWith();
    engine.setSpendingLimit(NATIVE, "100", "daily");

    expect(engine.removeSpendingLimit(NATIVE, "daily")).toBe(true);
    expect(engine.removeSpendingLimit(NATIVE, "daily")).toBe(false);
    expect(engine.listSpendingLimits()).toHaveLength(0);
  });
});

describe("per-transaction limits", () => {
  it("allows a transaction at exactly the limit", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "per_transaction" }] });
    const result = engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });

    expect(result.data?.decision).toBe("allowed");
    expect(result.data?.violations).toEqual([]);
  });

  it("denies a transaction above the limit with a structured violation", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "per_transaction" }] });
    const result = engine.evaluate({ id: "r1", asset: NATIVE, amount: "100.0000001", timestamp: T });

    expect(result.data?.decision).toBe("denied");
    expect(result.data?.violations[0]).toMatchObject({
      code: "PER_TRANSACTION_LIMIT_EXCEEDED",
      asset: NATIVE,
      limit: "100",
      requested: "100.0000001",
    });
  });

  it("does not accumulate across separate transactions", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "per_transaction" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });
    const second = engine.evaluate({ id: "r2", asset: NATIVE, amount: "100", timestamp: T });

    expect(second.data?.decision).toBe("allowed");
  });
});

describe("cumulative daily and monthly limits", () => {
  it("denies the request that would push the day over its ceiling", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "60", timestamp: T });
    const second = engine.evaluate({ id: "r2", asset: NATIVE, amount: "50", timestamp: T });

    expect(second.data?.decision).toBe("denied");
    expect(second.data?.violations[0]).toMatchObject({
      code: "DAILY_LIMIT_EXCEEDED",
      used: "60",
      requested: "50",
      limit: "100",
    });
  });

  it("resets the daily window on the next UTC day", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });
    const nextDay = engine.evaluate({ id: "r2", asset: NATIVE, amount: "100", timestamp: T + DAY });

    expect(nextDay.data?.decision).toBe("allowed");
  });

  it("keeps the monthly window accruing across days", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "150", period: "monthly" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });
    const nextDay = engine.evaluate({ id: "r2", asset: NATIVE, amount: "100", timestamp: T + DAY });

    expect(nextDay.data?.decision).toBe("denied");
    expect(nextDay.data?.violations[0]?.code).toBe("MONTHLY_LIMIT_EXCEEDED");
  });

  it("resets the monthly window in the following month", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "150", period: "monthly" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });
    const nextMonth = engine.evaluate({
      id: "r2",
      asset: NATIVE,
      amount: "150",
      timestamp: Date.UTC(2026, 5, 1, 0, 0, 0),
    });

    expect(nextMonth.data?.decision).toBe("allowed");
  });

  it("reports every breached window at once", () => {
    const engine = engineWith({
      limits: [
        { asset: NATIVE, amount: "10", period: "per_transaction" },
        { asset: NATIVE, amount: "10", period: "daily" },
        { asset: NATIVE, amount: "10", period: "monthly" },
      ],
    });
    const result = engine.evaluate({ id: "r1", asset: NATIVE, amount: "50", timestamp: T });

    expect(result.data?.violations.map((v) => v.code)).toEqual([
      "PER_TRANSACTION_LIMIT_EXCEEDED",
      "DAILY_LIMIT_EXCEEDED",
      "MONTHLY_LIMIT_EXCEEDED",
    ]);
  });
});

describe("per-asset limit isolation", () => {
  it("does not let one asset consume another asset's ceiling", () => {
    const engine = engineWith({
      limits: [
        { asset: NATIVE, amount: "100", period: "daily" },
        { asset: USDC, amount: "100", period: "daily" },
      ],
    });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });
    const usdc = engine.evaluate({ id: "r2", asset: USDC, amount: "100", timestamp: T });

    expect(usdc.data?.decision).toBe("allowed");
    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("100");
    expect(engine.getSpendingUsage(USDC, T).daily).toBe("100");
  });

  it("leaves an unconfigured asset unconstrained", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "1", period: "daily" }] });
    const result = engine.evaluate({ id: "r1", asset: USDC, amount: "999999", timestamp: T });

    expect(result.data?.decision).toBe("allowed");
  });
});

describe("concurrent requests", () => {
  it("counts an authorized-but-unsubmitted request against the ceiling", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });

    // Neither request has been submitted yet — the second must still see the first.
    const first = engine.evaluate({ id: "r1", asset: NATIVE, amount: "70", timestamp: T });
    const second = engine.evaluate({ id: "r2", asset: NATIVE, amount: "70", timestamp: T });

    expect(first.data?.decision).toBe("allowed");
    expect(second.data?.decision).toBe("denied");
  });

  it("counts a pending-approval request against the ceiling", () => {
    const engine = engineWith({
      limits: [{ asset: NATIVE, amount: "100", period: "daily" }],
      approvalThresholds: [{ asset: NATIVE, amount: "10" }],
    });
    const first = engine.evaluate({ id: "r1", asset: NATIVE, amount: "70", timestamp: T });
    const second = engine.evaluate({ id: "r2", asset: NATIVE, amount: "70", timestamp: T });

    expect(first.data?.decision).toBe("requires_approval");
    expect(second.data?.decision).toBe("denied");
  });

  it("releases reserved capacity when a request is rejected", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "70", timestamp: T });
    engine.rejectRequest("r1");

    const retry = engine.evaluate({ id: "r2", asset: NATIVE, amount: "70", timestamp: T });
    expect(retry.data?.decision).toBe("allowed");
  });

  it("releases reserved capacity when a request fails", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "70", timestamp: T });
    engine.markFailed("r1");

    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("0");
    expect(engine.evaluate({ id: "r2", asset: NATIVE, amount: "70", timestamp: T }).data?.decision).toBe(
      "allowed",
    );
  });

  it("keeps capacity consumed once a request completes", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "70", timestamp: T });
    engine.markCompleted("r1");

    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("70");
    expect(engine.evaluate({ id: "r2", asset: NATIVE, amount: "70", timestamp: T }).data?.decision).toBe(
      "denied",
    );
  });

  it("rejects a duplicate request id rather than double-reserving", () => {
    const engine = engineWith();
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", timestamp: T });
    const duplicate = engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", timestamp: T });

    expect(duplicate.status).toBe("error");
    expect(duplicate.error?.message).toContain("already been evaluated");
  });

  it("does not reserve capacity for a denied request", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "10", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "50", timestamp: T });

    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("0");
  });
});

describe("destination restrictions", () => {
  it("denies a destination outside the allow list", () => {
    const engine = engineWith({
      destinationRestriction: { mode: "allow", destinations: [DEST_A] },
    });
    const result = engine.evaluate({
      id: "r1",
      asset: NATIVE,
      amount: "1",
      destination: DEST_B,
      timestamp: T,
    });

    expect(result.data?.decision).toBe("denied");
    expect(result.data?.violations[0]?.code).toBe("DESTINATION_NOT_ALLOWED");
  });

  it("permits a destination inside the allow list", () => {
    const engine = engineWith({
      destinationRestriction: { mode: "allow", destinations: [DEST_A] },
    });
    const result = engine.evaluate({
      id: "r1",
      asset: NATIVE,
      amount: "1",
      destination: DEST_A,
      timestamp: T,
    });

    expect(result.data?.decision).toBe("allowed");
  });

  it("denies a destination on the deny list and permits others", () => {
    const engine = engineWith({
      destinationRestriction: { mode: "deny", destinations: [DEST_A] },
    });

    expect(
      engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", destination: DEST_A, timestamp: T }).data
        ?.violations[0]?.code,
    ).toBe("DESTINATION_DENIED");
    expect(
      engine.evaluate({ id: "r2", asset: NATIVE, amount: "1", destination: DEST_B, timestamp: T }).data
        ?.decision,
    ).toBe("allowed");
  });

  it("clears a restriction when set to undefined", () => {
    const engine = engineWith({
      destinationRestriction: { mode: "allow", destinations: [DEST_A] },
    });
    engine.setDestinationRestriction(undefined);

    expect(
      engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", destination: DEST_B, timestamp: T }).data
        ?.decision,
    ).toBe("allowed");
  });
});

describe("approval workflow", () => {
  it("routes a transaction above the threshold into an approval state", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    const result = engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });

    expect(result.data?.decision).toBe("requires_approval");
    expect(result.data?.requiredApprovers).toBe(1);
    expect(engine.getRequest("r1")?.status).toBe("pending_approval");
  });

  it("leaves a transaction at or below the threshold immediately allowed", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    const result = engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });

    expect(result.data?.decision).toBe("allowed");
    expect(result.data?.requiredApprovers).toBeUndefined();
  });

  it("authorizes once a single approval arrives", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });
    const approved = engine.approveRequest("r1", "alice");

    expect(approved.data?.status).toBe("authorized");
    expect(approved.data?.approvals).toEqual(["alice"]);
  });

  it("holds a multi-approver request until every approval is collected", () => {
    const engine = engineWith({
      approvalThresholds: [{ asset: NATIVE, amount: "100", requiredApprovers: 3 }],
    });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });

    expect(engine.approveRequest("r1", "alice").data?.status).toBe("pending_approval");
    expect(engine.approveRequest("r1", "bob").data?.status).toBe("pending_approval");
    expect(engine.approveRequest("r1", "carol").data?.status).toBe("authorized");
    expect(engine.getRequest("r1")?.approvals).toEqual(["alice", "bob", "carol"]);
  });

  it("rejects a duplicate approval so one approver cannot satisfy the threshold alone", () => {
    const engine = engineWith({
      approvalThresholds: [{ asset: NATIVE, amount: "100", requiredApprovers: 2 }],
    });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });
    engine.approveRequest("r1", "alice");
    const duplicate = engine.approveRequest("r1", "alice");

    expect(duplicate.status).toBe("error");
    expect(duplicate.error?.message).toContain("already approved");
    expect(engine.getRequest("r1")?.status).toBe("pending_approval");
  });

  it("rejects an approver outside the configured approver set", () => {
    const engine = engineWith({
      approvalThresholds: [{ asset: NATIVE, amount: "100", approvers: ["alice"] }],
    });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });
    const result = engine.approveRequest("r1", "mallory");

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("not an authorized approver");
  });

  it("rejects an approval for an unknown request", () => {
    expect(engineWith().approveRequest("nope", "alice").status).toBe("error");
  });

  it("rejects an approval for a request that is not pending", () => {
    const engine = engineWith();
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", timestamp: T });
    const result = engine.approveRequest("r1", "alice");

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("not pending approval");
  });

  it("rejects a configured threshold with fewer than one approver", () => {
    const engine = engineWith();
    expect(engine.setApprovalThreshold({ asset: NATIVE, amount: "10", requiredApprovers: 0 }).status).toBe(
      "error",
    );
  });

  it("can reject a pending request outright", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });

    expect(engine.rejectRequest("r1").data?.status).toBe("rejected");
    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("0");
  });

  it("refuses to complete a request still awaiting approval", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "150", timestamp: T });
    const result = engine.markCompleted("r1");

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("only authorized requests can complete");
  });
});

describe("usage reporting and lifecycle", () => {
  it("reports the largest single spend as per-transaction usage", () => {
    const engine = engineWith();
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "10", timestamp: T });
    engine.evaluate({ id: "r2", asset: NATIVE, amount: "45", timestamp: T });

    const usage = engine.getSpendingUsage(NATIVE, T);
    expect(usage.perTransaction).toBe("45");
    expect(usage.daily).toBe("55");
    expect(usage.monthly).toBe("55");
  });

  it("filters listed requests by status", () => {
    const engine = engineWith({ approvalThresholds: [{ asset: NATIVE, amount: "100" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "1", timestamp: T });
    engine.evaluate({ id: "r2", asset: NATIVE, amount: "150", timestamp: T });

    expect(engine.listRequests("authorized").map((r) => r.id)).toEqual(["r1"]);
    expect(engine.listRequests("pending_approval").map((r) => r.id)).toEqual(["r2"]);
    expect(engine.listRequests()).toHaveLength(2);
  });

  it("clears records but retains limits on reset", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "100", period: "daily" }] });
    engine.evaluate({ id: "r1", asset: NATIVE, amount: "100", timestamp: T });
    engine.reset();

    expect(engine.listRequests()).toHaveLength(0);
    expect(engine.listSpendingLimits()).toHaveLength(1);
    expect(engine.evaluate({ id: "r2", asset: NATIVE, amount: "100", timestamp: T }).data?.decision).toBe(
      "allowed",
    );
  });

  it("rejects a malformed request amount", () => {
    const result = engineWith().evaluate({ id: "r1", asset: NATIVE, amount: "-5", timestamp: T });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects an empty request id", () => {
    expect(engineWith().evaluate({ id: "  ", asset: NATIVE, amount: "1" }).status).toBe("error");
  });

  it("preserves precision on large amounts beyond the safe integer range", () => {
    const engine = engineWith({ limits: [{ asset: NATIVE, amount: "922337203685.4775807", period: "daily" }] });
    const result = engine.evaluate({
      id: "r1",
      asset: NATIVE,
      amount: "922337203685.4775807",
      timestamp: T,
    });

    expect(result.data?.decision).toBe("allowed");
    expect(engine.getSpendingUsage(NATIVE, T).daily).toBe("922337203685.4775807");
  });
});
