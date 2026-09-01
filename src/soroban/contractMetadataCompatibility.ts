/**
 * Contract metadata version tracking and compatibility validation.
 *
 * Problem (fix.md)
 * ----------------
 * Contract metadata can evolve as contracts are upgraded. Before using cached
 * metadata the SDK should validate that it corresponds to the deployed contract
 * interface, distinguishing breaking from non-breaking changes, exposing
 * migration hooks, and invalidating stale cached metadata.
 *
 * Design notes
 * ------------
 * - Fingerprints, not semantic version strings, drive compatibility: the
 *   interface of a contract is reduced to a deterministic fingerprint so
 *   identical metadata always yields the same fingerprint. Semantic version
 *   strings are treated as advisory only.
 * - Metadata is always associated with a contract identifier.
 * - The subsystem is standalone and additive: it consumes the existing
 *   `ContractMethod[]` / `ContractSchema` shapes and existing cache
 *   invalidation helpers, so existing metadata consumers remain untouched.
 */

import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { ContractMethod } from "./types";
import type {
  ContractSchema,
} from "./contractMetadata";

/**
 * A metadata fingerprint plus its associated contract identifier.
 * This is the version identity used for compatibility checks — it does NOT
 * rely on semantic version strings.
 */
export interface ContractMetadataVersion {
  /** Stellar contract address (C...). */
  contractId: string;
  /** Deterministic fingerprint of the contract interface. */
  fingerprint: string;
  /**
   * Optional advisory version string (e.g. from `contractmetav0`). Used only
   * as a fast-path hint; the fingerprint is authoritative.
   */
  version?: string;
}

/** Metadata that is pinned to a contract identifier. */
export interface ContractMetadataSnapshot {
  /** Contract identifier the metadata belongs to. */
  contractId: string;
  /** The discovered contract interface (methods). */
  methods: ContractMethod[];
  /** Deterministic fingerprint of `methods`. */
  fingerprint: string;
  /** Optional advisory version string. */
  version?: string;
}

/** Canonicalized method descriptor used to derive fingerprints. */
interface NormalizedMethod {
  name: string;
  args: string[];
  return: string;
}

/** Kind of interface difference detected between two metadata snapshots. */
export type ContractMetadataChangeKind =
  | "ADDED_METHOD"
  | "REMOVED_METHOD"
  | "CHANGED_ARG_TYPE"
  | "CHANGED_ARG_COUNT"
  | "CHANGED_RETURN_TYPE";

/** A single detected difference between two metadata snapshots. */
export interface ContractMetadataChange {
  kind: ContractMetadataChangeKind;
  /** The method the change affects, when applicable. */
  method: string;
  /** Human-readable description of the change. */
  message: string;
  /** Whether this change is breaking for existing callers. */
  breaking: boolean;
}

/** Compatibility outcome between two metadata versions. */
export type ContractMetadataCompatibilityStatus =
  | "identical"
  | "compatible"
  | "incompatible"
  | "missing";

/** Structured report from a metadata compatibility check. */
export interface ContractMetadataCompatibilityReport {
  /** Overall compatibility classification. */
  status: ContractMetadataCompatibilityStatus;
  /** Convenience boolean: `true` for identical/compatible. */
  compatible: boolean;
  /** Every detected interface difference (empty when identical/missing). */
  changes: ContractMetadataChange[];
  /** Non-fatal advisories (e.g. missing version, metadata absent). */
  warnings: string[];
  /** Fatal explanation when status is `incompatible`. */
  errors: string[];
  /** True when stale/incompatible cached metadata must be invalidated. */
  shouldInvalidate: boolean;
}

/** A single migration step transforming candidate metadata. */
export interface ContractMetadataMigration {
  /** When true (and the transformation preserves compatibility), the metadata is considered migrated. */
  applied: boolean;
  /** Human-readable description of the migration performed. */
  description: string;
}

/**
 * Application-defined migration hook.
 *
 * Receives the candidate metadata snapshot and may transform it to a newer
 * interface. Return `null` when the hook cannot migrate the metadata (the
 * change is treated as incompatible).
 */
export type ContractMetadataMigrationHook = (
  candidate: ContractMetadataSnapshot,
) => ContractMetadataSnapshot | null | void;

/** Result of applying migration hooks to incompatible metadata. */
export interface ContractMetadataMigrationResult {
  /** The metadata after migrations were applied, if a hook produced one. */
  snapshot: ContractMetadataSnapshot | null;
  /** Migrations that were applied, in order. */
  migrations: ContractMetadataMigration[];
  /** True when the original metadata was left un-migratable (incompatible). */
  blocked: boolean;
}

// ─── Fingerprint computation ──────────────────────────────────────────────────

/**
 * Reduce any supported metadata shape to a canonical list of normalized
 * methods. Accepts the raw array of discovered methods or a typed schema.
 */
function normalizeMethods(
  source: ContractMethod[] | ContractSchema,
): NormalizedMethod[] {
  const methods: ContractMethod[] = Array.isArray(source)
    ? source
    : source.methods.map((m) => ({
        name: m.name,
        inputs: (m.params ?? []).map((p) => ({ name: p.name, type: p.type })),
        returnType: m.returnType,
      }));

  return methods.map((m) => ({
    name: m.name,
    args: (m.inputs ?? []).map((input) => `${input.name}:${input.type}`),
    return: m.returnType ?? "void",
  }));
}

/** Deterministic 32-bit hash (FNV-1a) — stable across runs and runtimes. */
function fnv1a(data: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Compute a deterministic fingerprint of a contract interface.
 *
 * The fingerprint is derived from the sorted, canonicalized method signatures
 * (name, argument types, return type) — NOT from semantic version strings — so
 * identical interfaces always produce identical fingerprints. This is the
 * authoritative identity used for compatibility validation.
 */
export function computeContractMetadataFingerprint(
  source: ContractMethod[] | ContractSchema,
): string {
  const methods = normalizeMethods(source)
    .map(
      (m) =>
        `${m.name}(${m.args.join(",")}):${m.return}`,
    )
    .sort();
  return fnv1a(methods.join("|"));
}

/** Normalize a fingerprint to a stable hex string (empty → "missing"). */
function normalizeFingerprint(fingerprint: string | undefined | null): string {
  return typeof fingerprint === "string" && fingerprint.length > 0
    ? fingerprint
    : "";
}

// ─── Snapshot construction ────────────────────────────────────────────────────

export interface BuildMetadataSnapshotInput {
  contractId: string;
  methods: ContractMethod[] | ContractSchema;
  /** Optional advisory version string. */
  version?: string;
  /** Override fingerprint when the caller has a precomputed one. */
  fingerprint?: string;
}

/**
 * Build a fingerprint-pinned metadata snapshot associated with a contract
 * identifier.
 *
 * @returns A {@link ContractMetadataSnapshot} with the fingerprint computed
 * deterministically from the interface (or the caller-supplied override).
 */
export function buildContractMetadataSnapshot(
  input: BuildMetadataSnapshotInput,
): ContractMetadataSnapshot {
  const methods: ContractMethod[] = Array.isArray(input.methods)
    ? input.methods
    : (input.methods as ContractSchema).methods.map((m) => ({
        name: m.name,
        inputs: (m.params ?? []).map((p) => ({ name: p.name, type: p.type })),
        returnType: m.returnType,
      }));

  return {
    contractId: input.contractId,
    methods,
    fingerprint:
      input.fingerprint ?? computeContractMetadataFingerprint(input.methods),
    ...(input.version !== undefined ? { version: input.version } : {}),
  };
}

// ─── Compatibility diffing ────────────────────────────────────────────────────

function diffMethods(
  baseline: NormalizedMethod[],
  candidate: NormalizedMethod[],
): ContractMetadataChange[] {
  const changes: ContractMetadataChange[] = [];
  const baselineByName = new Map(baseline.map((m) => [m.name, m]));
  const candidateByName = new Map(candidate.map((m) => [m.name, m]));

  for (const method of baseline) {
    const next = candidateByName.get(method.name);
    if (!next) {
      changes.push({
        kind: "REMOVED_METHOD",
        method: method.name,
        message: `Method '${method.name}' was removed from the contract interface.`,
        breaking: true,
      });
      continue;
    }

    if (next.args.length !== method.args.length) {
      changes.push({
        kind: "CHANGED_ARG_COUNT",
        method: method.name,
        message: `Method '${method.name}' argument count changed from ${method.args.length} to ${next.args.length}.`,
        breaking: true,
      });
    } else if (next.args.join("|") !== method.args.join("|")) {
      changes.push({
        kind: "CHANGED_ARG_TYPE",
        method: method.name,
        message: `Method '${method.name}' argument types changed from [${method.args.join(", ")}] to [${next.args.join(", ")}].`,
        breaking: true,
      });
    }

    if (next.return !== method.return) {
      changes.push({
        kind: "CHANGED_RETURN_TYPE",
        method: method.name,
        message: `Method '${method.name}' return type changed from '${method.return}' to '${next.return}'.`,
        breaking: true,
      });
    }
  }

  for (const method of candidate) {
    if (!baselineByName.has(method.name)) {
      changes.push({
        kind: "ADDED_METHOD",
        method: method.name,
        message: `Method '${method.name}' was added to the contract interface (non-breaking).`,
        breaking: false,
      });
    }
  }

  return changes;
}

// ─── Public compatibility check ───────────────────────────────────────────────

export interface CheckCompatibilityInput {
  /** The metadata the application currently relies on (baseline). */
  baseline: ContractMetadataSnapshot;
  /** Freshly discovered metadata (candidate) for the same contract. */
  candidate?: ContractMetadataSnapshot;
  /** Expected fingerprint for the baseline contract, when the caller has one. */
  expectedFingerprint?: string;
}

/**
 * Compare two contract interface versions and classify the result.
 *
 * Distinguishes:
 *  - `identical`  — fingerprints (or both declared versions) match exactly.
 *  - `compatible` — only non-breaking changes (added methods).
 *  - `incompatible` — breaking changes (removed methods, changed signatures).
 *  - `missing`    — the candidate/expected metadata could not be resolved.
 *
 * `shouldInvalidate` is `true` when the baseline (cached) metadata must be
 * discarded because it no longer matches the deployed interface.
 *
 * @param input - Baseline snapshot plus candidate/expected identity.
 * @returns A structured {@link ContractMetadataCompatibilityReport}.
 */
export function checkContractMetadataCompatibility(
  input: CheckCompatibilityInput,
): ContractMetadataCompatibilityReport {
  const warnings: string[] = [];
  const errors: string[] = [];

  const candidateFingerprint = normalizeFingerprint(
    input.candidate?.fingerprint ?? input.expectedFingerprint,
  );
  const baselineFingerprint = normalizeFingerprint(input.baseline.fingerprint);

  // Missing candidate metadata → cannot confirm the cached metadata is valid.
  if (
    !input.candidate &&
    (input.expectedFingerprint === undefined || candidateFingerprint === "")
  ) {
    return {
      status: "missing",
      compatible: false,
      changes: [],
      warnings: ["No candidate metadata was provided; cannot confirm the cached metadata is current."],
      errors: [],
      shouldInvalidate: false,
    };
  }

  // Fast path: identical fingerprint → identical interface.
  if (baselineFingerprint !== "" && baselineFingerprint === candidateFingerprint) {
    return {
      status: "identical",
      compatible: true,
      changes: [],
      warnings,
      errors,
      shouldInvalidate: false,
    };
  }

  // Fast path: both declare the same advisory version string.
  if (
    input.baseline.version !== undefined &&
    input.candidate?.version !== undefined &&
    input.baseline.version === input.candidate.version
  ) {
    return {
      status: "identical",
      compatible: true,
      changes: [],
      warnings: [
        `Matched on advisory version '${input.baseline.version}'; fingerprints differ (${baselineFingerprint} vs ${candidateFingerprint}).`,
      ],
      errors,
      shouldInvalidate: false,
    };
  }

  if (!input.candidate) {
    // Candidate metadata missing but an expected fingerprint was supplied.
    if (candidateFingerprint === baselineFingerprint) {
      return {
        status: "identical",
        compatible: true,
        changes: [],
        warnings,
        errors,
        shouldInvalidate: false,
      };
    }
    return {
      status: "incompatible",
      compatible: false,
      changes: [],
      warnings,
      errors: [
        `Cached metadata fingerprint '${baselineFingerprint}' does not match expected fingerprint '${candidateFingerprint}'.`,
      ],
      shouldInvalidate: true,
    };
  }

  const changes = diffMethods(
    normalizeMethods(input.baseline.methods),
    normalizeMethods(input.candidate.methods),
  );

  const breaking = changes.filter((c) => c.breaking);
  if (breaking.length > 0) {
    return {
      status: "incompatible",
      compatible: false,
      changes,
      warnings,
      errors: breaking.map((c) => c.message),
      shouldInvalidate: true,
    };
  }

  if (changes.length > 0) {
    return {
      status: "compatible",
      compatible: true,
      changes,
      warnings: changes.map((c) => c.message),
      errors,
      shouldInvalidate: false,
    };
  }

  // Fingerprints differ but the diff found no structural change (e.g. only
  // ordering or visibility nuances) — treat as compatible.
  return {
    status: "compatible",
    compatible: true,
    changes,
    warnings: ["Fingerprints differ but no breaking interface change was detected."],
    errors,
    shouldInvalidate: false,
  };
}

// ─── Stale metadata detection before invocation ───────────────────────────────

export interface StaleMetadataCheckInput {
  contractId: string;
  /** Cached metadata the application is about to use. */
  cachedMetadata?: ContractMethod[];
  /** Fingerprint of the expected/deployed interface. */
  expectedFingerprint?: string;
  /** Freshly discovered metadata for the contract, when available. */
  freshMetadata?: ContractMethod[] | ContractSchema;
}

export interface StaleMetadataCheckResult {
  /** True when the cached metadata is current and safe to use. */
  current: boolean;
  /** Human-readable explanation when stale. */
  message: string;
  /** Compatibility report backing the decision. */
  report: ContractMetadataCompatibilityReport;
}

/**
 * Detect stale cached metadata before a contract invocation.
 *
 * When the caller supplies either an expected fingerprint or freshly discovered
 * metadata, this returns a decision on whether the cached metadata is still
 * valid. Missing cached metadata or missing reference metadata resolve to a
 * non-fatal "missing" result (the invocation may still proceed).
 *
 * @param input - Contract identity plus cached and reference metadata.
 * @returns An always-`ok` {@link StaleMetadataCheckResult}; use the `current`
 * flag to decide whether to re-fetch before invoking.
 */
export function checkStaleContractMetadata(
  input: StaleMetadataCheckInput,
): SorokitResult<StaleMetadataCheckResult> {
  if (!input.cachedMetadata || input.cachedMetadata.length === 0) {
    return ok({
      current: false,
      message: "No cached metadata available for this contract.",
      report: {
        status: "missing",
        compatible: false,
        changes: [],
        warnings: ["Cached metadata is absent."],
        errors: [],
        shouldInvalidate: false,
      },
    });
  }

  if (
    input.expectedFingerprint === undefined &&
    !input.freshMetadata
  ) {
    return ok({
      current: true,
      message: "No reference metadata to compare against; assuming cached metadata is current.",
      report: {
        status: "missing",
        compatible: true,
        changes: [],
        warnings: ["No reference fingerprint provided."],
        errors: [],
        shouldInvalidate: false,
      },
    });
  }

  const baseline = buildContractMetadataSnapshot({
    contractId: input.contractId,
    methods: input.cachedMetadata,
  });

  const report = checkContractMetadataCompatibility({
    baseline,
    ...(input.freshMetadata
      ? {
          candidate: buildContractMetadataSnapshot({
            contractId: input.contractId,
            methods: input.freshMetadata,
          }),
        }
      : {}),
    ...(input.expectedFingerprint !== undefined
      ? { expectedFingerprint: input.expectedFingerprint }
      : {}),
  });

  if (report.status === "identical") {
    return ok({
      current: true,
      message: "Cached metadata matches the deployed contract interface.",
      report,
    });
  }

  return ok({
    current: false,
    message:
      report.status === "missing"
        ? "Cached metadata could not be verified against a reference."
        : report.errors[0] ??
          "Cached metadata is incompatible with the deployed contract interface.",
    report,
  });
}

// ─── Migration hooks ──────────────────────────────────────────────────────────

/**
 * Apply migration hooks to incompatible metadata.
 *
 * Hooks run in order against a copy of the candidate snapshot. The first hook
 * that returns a snapshot is considered the migration result. If no hook
 * produces a migrated snapshot the metadata is left blocked (incompatible).
 *
 * @param candidate - The freshly discovered (newer) metadata.
 * @param hooks     - Application-provided migration hooks.
 * @returns A {@link ContractMetadataMigrationResult}.
 */
export function applyContractMetadataMigration(
  candidate: ContractMetadataSnapshot,
  hooks: ContractMetadataMigrationHook[],
): ContractMetadataMigrationResult {
  const migrations: ContractMetadataMigration[] = [];

  for (const hook of hooks) {
    const result = hook(candidate);
    if (result && result.fingerprint) {
      migrations.push({
        applied: true,
        description: `A migration hook produced a metadata snapshot with fingerprint '${result.fingerprint}'.`,
      });
      return { snapshot: result, migrations, blocked: false };
    }
    migrations.push({ applied: false, description: "A migration hook made no change." });
  }

  return { snapshot: null, migrations, blocked: true };
}

// ─── Cache invalidation integration ───────────────────────────────────────────

export interface InvalidateMetadataInput {
  contractId: string;
  /** In-memory metadata cache (from `contractMetadata`). */
  cache?: SorokitCache;
  /** Invalidate the fallback memory state as well. */
  reset?: () => void;
}

/**
 * Invalidate cached metadata for a contract after an incompatible interface
 * change is detected. Safe to call unconditionally.
 */
export function invalidateContractMetadataForIncompatibility(
  input: InvalidateMetadataInput,
): void {
  input.reset?.();
  input.cache?.invalidate(`sorokit:contract-metadata:${input.contractId}`);
  input.cache?.invalidate(`sorokit:contract-schema:${input.contractId}`);
}

// Re-export the standard invalidation helper so callers can keep a single
// import surface without relying on `contractMetadata` internals.
export { invalidateContractCache as invalidateCachedContractMetadata } from "./contractMetadata";
