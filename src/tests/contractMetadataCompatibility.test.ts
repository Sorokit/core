/**
 * Tests for contract metadata versioning & compatibility validation (fix.md).
 *
 * Covers identical, compatible, incompatible, and missing metadata versions,
 * deterministic fingerprints, stale-metadata detection, migration hooks, and
 * stale-cache invalidation.
 */

import { describe, it, expect } from "vitest";
import type { SorokitCache } from "../shared/cache";
import type { ContractMethod } from "../soroban/types";
import type { ContractSchema } from "../soroban/contractMetadata";
import {
  computeContractMetadataFingerprint,
  buildContractMetadataSnapshot,
  checkContractMetadataCompatibility,
  checkStaleContractMetadata,
  applyContractMetadataMigration,
  invalidateContractMetadataForIncompatibility,
  type ContractMetadataSnapshot,
} from "../soroban/contractMetadataCompatibility";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function methods(overrides: Array<Partial<ContractMethod>>): ContractMethod[] {
  return overrides.map((m) => ({
    name: m.name ?? "default",
    inputs: m.inputs ?? [{ name: "value", type: "u32" }],
    returnType: m.returnType ?? "u32",
    ...(m.visibility !== undefined ? { visibility: m.visibility } : {}),
  }));
}

const BASE_METHODS = methods([
  { name: "transfer" },
  { name: "balance", inputs: [{ name: "account", type: "address" }], returnType: "i128" },
]);

function snapshot(contractId = CONTRACT_ID, ms = BASE_METHODS, version?: string): ContractMetadataSnapshot {
  return buildContractMetadataSnapshot({ contractId, methods: ms, ...(version ? { version } : {}) });
}

describe("computeContractMetadataFingerprint", () => {
  it("is deterministic for identical interfaces", () => {
    const a = computeContractMetadataFingerprint(BASE_METHODS);
    const b = computeContractMetadataFingerprint(BASE_METHODS);
    expect(a).toBe(b);
  });

  it("is identical regardless of method ordering", () => {
    const reversed = methods([
      { name: "balance", inputs: [{ name: "account", type: "address" }], returnType: "i128" },
      { name: "transfer" },
    ]);
    expect(computeContractMetadataFingerprint(reversed)).toBe(
      computeContractMetadataFingerprint(BASE_METHODS),
    );
  });

  it("differs when a method signature changes", () => {
    const changed = methods([
      { name: "transfer", inputs: [{ name: "value", type: "u64" }] },
      { name: "balance", inputs: [{ name: "account", type: "address" }], returnType: "i128" },
    ]);
    expect(computeContractMetadataFingerprint(changed)).not.toBe(
      computeContractMetadataFingerprint(BASE_METHODS),
    );
  });

  it("accepts a typed ContractSchema", () => {
    const schema: ContractSchema = {
      contractId: CONTRACT_ID,
      methods: [
        { name: "transfer", params: [{ name: "value", type: "u32" }], returnType: "u32" },
      ],
    };
    expect(computeContractMetadataFingerprint(schema)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not rely on semantic version strings", () => {
    // Two different versions with the same interface fingerprint match.
    const v1 = snapshot(CONTRACT_ID, BASE_METHODS, "1.0.0");
    const v2 = snapshot(CONTRACT_ID, BASE_METHODS, "2.0.0");
    expect(v1.fingerprint).toBe(v2.fingerprint);
  });
});

describe("buildContractMetadataSnapshot (#2 — associated with contract id)", () => {
  it("associates metadata with a contract identifier", () => {
    const snap = buildContractMetadataSnapshot({
      contractId: CONTRACT_ID,
      methods: BASE_METHODS,
      version: "3.1.0",
    });
    expect(snap.contractId).toBe(CONTRACT_ID);
    expect(snap.version).toBe("3.1.0");
    expect(snap.fingerprint).toBe(computeContractMetadataFingerprint(BASE_METHODS));
  });
});

describe("checkContractMetadataCompatibility", () => {
  it("reports identical when fingerprints match (#identical)", () => {
    const report = checkContractMetadataCompatibility({
      baseline: snapshot(),
      candidate: snapshot(),
    });
    expect(report.status).toBe("identical");
    expect(report.compatible).toBe(true);
    expect(report.changes).toEqual([]);
    expect(report.shouldInvalidate).toBe(false);
  });

  it("reports compatible for non-breaking changes (added method)", () => {
    const added = methods([
      ...BASE_METHODS,
      { name: "allowance" },
    ]);
    const report = checkContractMetadataCompatibility({
      baseline: snapshot(),
      candidate: snapshot(CONTRACT_ID, added),
    });
    expect(report.status).toBe("compatible");
    expect(report.compatible).toBe(true);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].kind).toBe("ADDED_METHOD");
    expect(report.changes[0].breaking).toBe(false);
    expect(report.shouldInvalidate).toBe(false);
  });

  it("reports incompatible for breaking changes (removed method)", () => {
    const removed = methods([{ name: "transfer" }]);
    const report = checkContractMetadataCompatibility({
      baseline: snapshot(),
      candidate: snapshot(CONTRACT_ID, removed),
    });
    expect(report.status).toBe("incompatible");
    expect(report.compatible).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.changes.some((c) => c.kind === "REMOVED_METHOD")).toBe(true);
    expect(report.shouldInvalidate).toBe(true);
  });

  it("reports incompatible when an argument type changes", () => {
    const changed = methods([
      { name: "transfer", inputs: [{ name: "value", type: "u64" }] },
      { name: "balance", inputs: [{ name: "account", type: "address" }], returnType: "i128" },
    ]);
    const report = checkContractMetadataCompatibility({
      baseline: snapshot(),
      candidate: snapshot(CONTRACT_ID, changed),
    });
    expect(report.status).toBe("incompatible");
    expect(report.changes.some((c) => c.kind === "CHANGED_ARG_TYPE")).toBe(true);
  });

  it("reports missing when no candidate and no expected fingerprint is provided", () => {
    const report = checkContractMetadataCompatibility({
      baseline: snapshot(),
    });
    expect(report.status).toBe("missing");
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.shouldInvalidate).toBe(false);
  });

  it("reports identical against an expected fingerprint", () => {
    const baseline = snapshot();
    const report = checkContractMetadataCompatibility({
      baseline,
      expectedFingerprint: baseline.fingerprint,
    });
    expect(report.status).toBe("identical");
    expect(report.compatible).toBe(true);
  });

  it("reports incompatible when cached fingerprint mismatches expected fingerprint", () => {
    const baseline = snapshot();
    const report = checkContractMetadataCompatibility({
      baseline,
      expectedFingerprint: computeContractMetadataFingerprint(
        methods([{ name: "entirely_different" }]),
      ),
    });
    expect(report.status).toBe("incompatible");
    expect(report.shouldInvalidate).toBe(true);
  });

  it("treats matching advisory versions as identical even if fingerprints differ", () => {
    const a = snapshot(CONTRACT_ID, BASE_METHODS, "1.0.0");
    const b = snapshot(CONTRACT_ID, methods([{ name: "transfer", inputs: [{ name: "x", type: "u64" }] }]), "1.0.0");
    const report = checkContractMetadataCompatibility({
      baseline: a,
      candidate: b,
    });
    expect(report.status).toBe("identical");
    expect(report.compatible).toBe(true);
  });
});

describe("checkStaleContractMetadata (#4 — detected before invocation)", () => {
  it("reports current when cached metadata matches fresh metadata", async () => {
    const result = await checkStaleContractMetadata({
      contractId: CONTRACT_ID,
      cachedMetadata: BASE_METHODS,
      freshMetadata: BASE_METHODS,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.current).toBe(true);
      expect(result.data.report.status).toBe("identical");
    }
  });

  it("reports stale when cached metadata no longer matches", async () => {
    const changed = methods([
      { name: "transfer", inputs: [{ name: "value", type: "u128" }] },
      { name: "balance", inputs: [{ name: "account", type: "address" }], returnType: "i128" },
    ]);
    const result = await checkStaleContractMetadata({
      contractId: CONTRACT_ID,
      cachedMetadata: BASE_METHODS,
      freshMetadata: changed,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.current).toBe(false);
      expect(result.data.report.status).toBe("incompatible");
      expect(result.data.message.length).toBeGreaterThan(0);
    }
  });

  it("reports missing when no cached metadata exists", async () => {
    const result = await checkStaleContractMetadata({
      contractId: CONTRACT_ID,
      freshMetadata: BASE_METHODS,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.current).toBe(false);
      expect(result.data.report.status).toBe("missing");
    }
  });

  it("returns current (non-fatal) when no reference is available", async () => {
    const result = await checkStaleContractMetadata({
      contractId: CONTRACT_ID,
      cachedMetadata: BASE_METHODS,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.current).toBe(true);
      expect(result.data.report.status).toBe("missing");
    }
  });
});

describe("applyContractMetadataMigration (#6 — migration hooks)", () => {
  it("applies the first hook that produces a snapshot", () => {
    const candidate = snapshot(CONTRACT_ID, methods([{ name: "new_api" }]), "2.0.0");
    const migrated: ContractMetadataSnapshot = buildContractMetadataSnapshot({
      contractId: CONTRACT_ID,
      methods: methods([{ name: "legacy_api" }]),
    });
    const result = applyContractMetadataMigration(candidate, [
      () => undefined, // no change
      () => migrated,
    ]);
    expect(result.blocked).toBe(false);
    expect(result.snapshot).toBe(migrated);
    expect(result.migrations).toHaveLength(2);
    expect(result.migrations[0].applied).toBe(false);
    expect(result.migrations[1].applied).toBe(true);
  });

  it("blocks when no hook can migrate the metadata", () => {
    const candidate = snapshot(CONTRACT_ID, methods([{ name: "new_api" }]));
    const result = applyContractMetadataMigration(candidate, [
      () => undefined,
    ]);
    expect(result.blocked).toBe(true);
    expect(result.snapshot).toBeNull();
  });
});

describe("invalidateContractMetadataForIncompatibility (#7)", () => {
  it("invalidates both metadata and schema caches for the contract", () => {
    const invalidated: string[] = [];
    const cache: SorokitCache = {
      get: () => undefined,
      set: () => undefined,
      invalidate: (key) => {
        invalidated.push(key);
      },
    };
    let resetCalled = false;

    invalidateContractMetadataForIncompatibility({
      contractId: CONTRACT_ID,
      cache,
      reset: () => {
        resetCalled = true;
      },
    });

    expect(resetCalled).toBe(true);
    expect(invalidated).toContain(`sorokit:contract-metadata:${CONTRACT_ID}`);
    expect(invalidated).toContain(`sorokit:contract-schema:${CONTRACT_ID}`);
  });
});
