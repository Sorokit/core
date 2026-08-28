import { describe, expect, it } from "vitest";
import {
  createContractStateHistory,
  fingerprintState,
  ContractStateHistory,
} from "../soroban/contractStateHistory";

const CONTRACT_A = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const CONTRACT_B = "CDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function historyWith(): ContractStateHistory {
  return createContractStateHistory();
}

describe("fingerprintState", () => {
  it("is stable for the same state", () => {
    expect(fingerprintState({ a: 1, b: "two" })).toBe(fingerprintState({ a: 1, b: "two" }));
  });

  it("ignores key insertion order", () => {
    expect(fingerprintState({ a: 1, b: 2 })).toBe(fingerprintState({ b: 2, a: 1 }));
  });

  it("ignores key order at nested depth", () => {
    expect(fingerprintState({ outer: { x: 1, y: 2 } })).toBe(
      fingerprintState({ outer: { y: 2, x: 1 } }),
    );
  });

  it("changes when a value changes", () => {
    expect(fingerprintState({ a: 1 })).not.toBe(fingerprintState({ a: 2 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(fingerprintState({ a: 1 })).not.toBe(fingerprintState({ a: "1" }));
  });

  it("preserves array order", () => {
    expect(fingerprintState({ a: [1, 2] })).not.toBe(fingerprintState({ a: [2, 1] }));
  });

  it("handles bigint values without throwing", () => {
    expect(() => fingerprintState({ total: 10n })).not.toThrow();
    expect(fingerprintState({ total: 10n })).toBe(fingerprintState({ total: 10n }));
  });

  it("treats an empty state as valid", () => {
    expect(fingerprintState({})).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("captureSnapshot", () => {
  it("records contract id, ledger, timestamp and fingerprint", () => {
    const history = historyWith();
    const result = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 100,
      state: { counter: 1 },
      timestamp: 1_700_000_000_000,
    });

    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({
      contractId: CONTRACT_A,
      ledger: 100,
      timestamp: 1_700_000_000_000,
      fingerprint: fingerprintState({ counter: 1 }),
    });
    expect(result.data?.id).toBeTruthy();
  });

  it("stores an optional label", () => {
    const history = historyWith();
    const result = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 1,
      state: {},
      label: "pre-migration",
    });

    expect(result.data?.label).toBe("pre-migration");
  });

  it("rejects an empty contract id", () => {
    const result = historyWith().captureSnapshot({ contractId: "  ", ledger: 1, state: {} });
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects a negative or non-integer ledger", () => {
    const history = historyWith();
    expect(history.captureSnapshot({ contractId: CONTRACT_A, ledger: -1, state: {} }).status).toBe(
      "error",
    );
    expect(history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1.5, state: {} }).status).toBe(
      "error",
    );
  });

  it("copies the supplied state so later mutation cannot alter the snapshot", () => {
    const history = historyWith();
    const state: Record<string, unknown> = { counter: 1 };
    const snapshot = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state });

    state["counter"] = 999;

    expect(snapshot.data?.state["counter"]).toBe(1);
    expect(history.verifySnapshotIntegrity(snapshot.data!.id).data?.valid).toBe(true);
  });

  it("supports multiple snapshots for the same contract", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: { v: 1 } });
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 2, state: { v: 2 } });
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 3, state: { v: 3 } });

    expect(history.querySnapshots({ contractId: CONTRACT_A })).toHaveLength(3);
  });

  it("gives distinct ids to two captures at the same ledger", () => {
    const history = historyWith();
    const first = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 5, state: { v: 1 } });
    const second = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 5, state: { v: 2 } });

    expect(first.data?.id).not.toBe(second.data?.id);
  });
});

describe("querySnapshots", () => {
  function seeded(): ContractStateHistory {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 10, state: { v: 1 } });
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 20, state: { v: 2 } });
    history.captureSnapshot({ contractId: CONTRACT_B, ledger: 30, state: { v: 3 } });
    return history;
  }

  it("filters by contract", () => {
    expect(seeded().querySnapshots({ contractId: CONTRACT_B })).toHaveLength(1);
  });

  it("filters by ledger range inclusively", () => {
    const found = seeded().querySnapshots({ contractId: CONTRACT_A, fromLedger: 10, toLedger: 10 });
    expect(found.map((s) => s.ledger)).toEqual([10]);
  });

  it("returns newest ledger first", () => {
    expect(seeded().querySnapshots().map((s) => s.ledger)).toEqual([30, 20, 10]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(seeded().querySnapshots({ contractId: "CUNKNOWN" })).toEqual([]);
  });
});

describe("getSnapshotAtLedger", () => {
  it("returns the snapshot captured at that ledger", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 42, state: { v: 1 } });

    expect(history.getSnapshotAtLedger(CONTRACT_A, 42).data?.ledger).toBe(42);
  });

  it("reports unavailable history clearly rather than returning empty state", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 42, state: { v: 1 } });
    const result = history.getSnapshotAtLedger(CONTRACT_A, 41);

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CONTRACT_READ_FAILED");
    expect(result.error?.message).toContain("does not reconstruct historical ledger state");
  });
});

describe("pinContractState", () => {
  it("pins a contract to a captured version", () => {
    const history = historyWith();
    const snapshot = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 7, state: { v: 1 } });
    const pin = history.pinContractState(CONTRACT_A, 7);

    expect(pin.status).toBe("ok");
    expect(pin.data).toMatchObject({ contractId: CONTRACT_A, snapshotId: snapshot.data!.id, ledger: 7 });
  });

  it("resolves the pinned snapshot", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 7, state: { v: 1 } });
    history.pinContractState(CONTRACT_A, 7);

    expect(history.getPinnedState(CONTRACT_A).data?.state).toEqual({ v: 1 });
  });

  it("refuses to pin a ledger that was never captured", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 7, state: { v: 1 } });
    const result = history.pinContractState(CONTRACT_A, 8);

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("no snapshot captured");
  });

  it("does not fall back to the nearest ledger when the exact one is missing", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 5, state: { v: 1 } });
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 9, state: { v: 2 } });

    expect(history.pinContractState(CONTRACT_A, 7).status).toBe("error");
  });

  it("pins the most recent capture when a ledger was captured twice", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 5, state: { v: 1 }, timestamp: 1 });
    const later = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 5,
      state: { v: 2 },
      timestamp: 2,
    });

    expect(history.pinContractState(CONTRACT_A, 5).data?.snapshotId).toBe(later.data?.id);
  });

  it("reports an unpinned contract", () => {
    const result = historyWith().getPinnedState(CONTRACT_A);

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("not pinned");
  });

  it("moves the pin when re-pinned to another version", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: { v: 1 } });
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 2, state: { v: 2 } });
    history.pinContractState(CONTRACT_A, 1);
    history.pinContractState(CONTRACT_A, 2);

    expect(history.getPinnedState(CONTRACT_A).data?.ledger).toBe(2);
  });

  it("unpins a contract", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: {} });
    history.pinContractState(CONTRACT_A, 1);

    expect(history.unpinContractState(CONTRACT_A)).toBe(true);
    expect(history.unpinContractState(CONTRACT_A)).toBe(false);
    expect(history.getPin(CONTRACT_A)).toBeUndefined();
  });

  it("keeps pins independent across contracts", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: { a: 1 } });
    history.captureSnapshot({ contractId: CONTRACT_B, ledger: 2, state: { b: 1 } });
    history.pinContractState(CONTRACT_A, 1);
    history.pinContractState(CONTRACT_B, 2);

    expect(history.getPinnedState(CONTRACT_A).data?.state).toEqual({ a: 1 });
    expect(history.getPinnedState(CONTRACT_B).data?.state).toEqual({ b: 1 });
  });
});

describe("verifySnapshotIntegrity", () => {
  it("validates an untouched snapshot", () => {
    const history = historyWith();
    const snapshot = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 1,
      state: { balance: 500 },
    });
    const report = history.verifySnapshotIntegrity(snapshot.data!.id);

    expect(report.data?.valid).toBe(true);
    expect(report.data?.actualFingerprint).toBe(report.data?.expectedFingerprint);
  });

  it("reports an unknown snapshot as an error", () => {
    const result = historyWith().verifySnapshotIntegrity("missing");

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CONTRACT_READ_FAILED");
  });
});

describe("compareSnapshots", () => {
  it("detects added, removed and changed entries", () => {
    const history = historyWith();
    const before = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 1,
      state: { kept: 1, dropped: 2, moved: 3 },
    });
    const after = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 2,
      state: { kept: 1, moved: 4, fresh: 5 },
    });

    const comparison = history.compareSnapshots(before.data!.id, after.data!.id);

    expect(comparison.data?.identical).toBe(false);
    expect(comparison.data?.changes).toEqual([
      { key: "dropped", kind: "removed", from: 2 },
      { key: "fresh", kind: "added", to: 5 },
      { key: "moved", kind: "changed", from: 3, to: 4 },
    ]);
  });

  it("reports identical snapshots with no changes", () => {
    const history = historyWith();
    const first = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: { v: 1 } });
    const second = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 2, state: { v: 1 } });

    const comparison = history.compareSnapshots(first.data!.id, second.data!.id);

    expect(comparison.data?.identical).toBe(true);
    expect(comparison.data?.changes).toEqual([]);
  });

  it("does not report a change when only nested key order differs", () => {
    const history = historyWith();
    const first = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 1,
      state: { cfg: { a: 1, b: 2 } },
    });
    const second = history.captureSnapshot({
      contractId: CONTRACT_A,
      ledger: 2,
      state: { cfg: { b: 2, a: 1 } },
    });

    expect(history.compareSnapshots(first.data!.id, second.data!.id).data?.changes).toEqual([]);
  });

  it("carries both ledger references in the comparison", () => {
    const history = historyWith();
    const first = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 10, state: {} });
    const second = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 20, state: {} });

    expect(history.compareSnapshots(first.data!.id, second.data!.id).data).toMatchObject({
      fromLedger: 10,
      toLedger: 20,
      contractId: CONTRACT_A,
    });
  });

  it("rejects a comparison across two different contracts", () => {
    const history = historyWith();
    const a = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: {} });
    const b = history.captureSnapshot({ contractId: CONTRACT_B, ledger: 1, state: {} });

    const result = history.compareSnapshots(a.data!.id, b.data!.id);

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("different contracts");
  });

  it("reports an unknown snapshot id", () => {
    const history = historyWith();
    const known = history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: {} });

    expect(history.compareSnapshots("missing", known.data!.id).status).toBe("error");
    expect(history.compareSnapshots(known.data!.id, "missing").status).toBe("error");
  });
});

describe("clear", () => {
  it("discards snapshots and pins", () => {
    const history = historyWith();
    history.captureSnapshot({ contractId: CONTRACT_A, ledger: 1, state: {} });
    history.pinContractState(CONTRACT_A, 1);
    history.clear();

    expect(history.querySnapshots()).toEqual([]);
    expect(history.getPin(CONTRACT_A)).toBeUndefined();
  });
});
