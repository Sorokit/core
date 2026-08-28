import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ───

/**
 * A recorded contract state snapshot.
 *
 * A snapshot is SDK-managed: it holds the state that was supplied to
 * {@link ContractStateHistory.captureSnapshot} at the moment of capture. It is
 * not a claim that this state can be reconstructed from the network later — see
 * {@link ContractStateHistory} for the distinction.
 */
export interface ContractStateSnapshotRecord {
  /** Stable identifier, unique within the history. */
  id: string;
  contractId: string;
  /** Ledger sequence the state was read at, used as the version identifier. */
  ledger: number;
  /** Epoch milliseconds at which the snapshot was captured. */
  timestamp: number;
  /** Captured state, stored as supplied. */
  state: Readonly<Record<string, unknown>>;
  /** Deterministic fingerprint of `state` — see {@link fingerprintState}. */
  fingerprint: string;
  /** Optional human-readable label. */
  label?: string;
}

export interface CaptureSnapshotInput {
  contractId: string;
  ledger: number;
  state: Record<string, unknown>;
  /** Epoch milliseconds. Defaults to `Date.now()`. */
  timestamp?: number;
  label?: string;
}

/** A pin marking one snapshot as the active version for a contract. */
export interface ContractStatePin {
  contractId: string;
  snapshotId: string;
  ledger: number;
  pinnedAt: number;
}

export type StateEntryChangeKind = "added" | "removed" | "changed";

export interface StateEntryChange {
  key: string;
  kind: StateEntryChangeKind;
  /** Value in the earlier snapshot. Absent when the entry was added. */
  from?: unknown;
  /** Value in the later snapshot. Absent when the entry was removed. */
  to?: unknown;
}

export interface ContractStateComparison {
  contractId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  fromLedger: number;
  toLedger: number;
  /** True when both snapshots carry the same fingerprint. */
  identical: boolean;
  changes: readonly StateEntryChange[];
}

export interface SnapshotIntegrityReport {
  snapshotId: string;
  valid: boolean;
  expectedFingerprint: string;
  actualFingerprint: string;
}

export interface SnapshotQuery {
  contractId?: string;
  /** Only snapshots at or after this ledger. */
  fromLedger?: number;
  /** Only snapshots at or before this ledger. */
  toLedger?: number;
}

// ─── Fingerprinting ───

/**
 * Canonical JSON encoding: object keys are emitted in sorted order at every
 * depth so that two structurally equal states always encode identically,
 * regardless of the insertion order of their keys.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic fingerprint of a contract state object.
 *
 * This is a non-cryptographic FNV-1a digest over the canonical encoding. It
 * detects accidental drift and lets two snapshots be compared cheaply; it is
 * not collision-resistant and must not be used as a security boundary.
 */
export function fingerprintState(state: Record<string, unknown>): string {
  const encoded = canonicalize(state);
  let hash = 0x811c9dc5n;
  const PRIME = 0x01000193n;
  const MASK = 0xffffffffn;

  for (let index = 0; index < encoded.length; index += 1) {
    hash = ((hash ^ BigInt(encoded.charCodeAt(index))) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── History ───

/**
 * Registry of SDK-managed contract state snapshots.
 *
 * Scope: this class stores state that was captured through it and can pin,
 * query and compare those records. It cannot reconstruct arbitrary historical
 * ledger state — Stellar RPC nodes retain contract data for a limited retention
 * window, and any ledger outside that window (or never captured here) is simply
 * unavailable. Queries for such state report a clear error rather than
 * returning an empty or synthesized result.
 */
export class ContractStateHistory {
  private readonly snapshots = new Map<string, ContractStateSnapshotRecord>();
  private readonly pins = new Map<string, ContractStatePin>();
  private sequence = 0;

  /**
   * Record a snapshot of contract state at a given ledger.
   *
   * The state is fingerprinted at capture time. Capturing the same contract at
   * the same ledger twice is allowed and produces two independent records.
   */
  captureSnapshot(input: CaptureSnapshotInput): SorokitResult<ContractStateSnapshotRecord> {
    if (!input.contractId.trim()) {
      return err(SorokitErrorCode.INVALID_CONFIG, "captureSnapshot: contractId is required.");
    }
    if (!Number.isInteger(input.ledger) || input.ledger < 0) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `captureSnapshot: ledger must be a non-negative integer (got ${input.ledger}).`,
      );
    }
    if (input.state === null || typeof input.state !== "object") {
      return err(SorokitErrorCode.INVALID_CONFIG, "captureSnapshot: state must be an object.");
    }

    this.sequence += 1;
    const state = Object.freeze({ ...input.state });
    const record: ContractStateSnapshotRecord = {
      id: `${input.contractId}:${input.ledger}:${this.sequence}`,
      contractId: input.contractId,
      ledger: input.ledger,
      timestamp: input.timestamp ?? Date.now(),
      state,
      fingerprint: fingerprintState(state),
      ...(input.label !== undefined ? { label: input.label } : {}),
    };

    this.snapshots.set(record.id, record);
    return ok(record);
  }

  /**
   * Pin a contract to a specific captured version.
   *
   * `version` is a ledger sequence. The most recently captured snapshot at that
   * ledger becomes the pinned state. Pinning a ledger that was never captured
   * fails, rather than silently pinning the nearest one.
   */
  pinContractState(contractId: string, version: number): SorokitResult<ContractStatePin> {
    const candidates = [...this.snapshots.values()]
      .filter((snapshot) => snapshot.contractId === contractId && snapshot.ledger === version)
      .sort((a, b) => a.timestamp - b.timestamp);

    const target = candidates[candidates.length - 1];
    if (!target) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `pinContractState: no snapshot captured for contract ${contractId} at ledger ${version}. ` +
          "Historical state outside the captured set is not retrievable from this SDK — capture it first.",
      );
    }

    const pin: ContractStatePin = {
      contractId,
      snapshotId: target.id,
      ledger: target.ledger,
      pinnedAt: Date.now(),
    };
    this.pins.set(contractId, pin);
    return ok(pin);
  }

  /** Return the active pin for a contract, if one is set. */
  getPin(contractId: string): ContractStatePin | undefined {
    return this.pins.get(contractId);
  }

  /** Resolve the snapshot a contract is pinned to. */
  getPinnedState(contractId: string): SorokitResult<ContractStateSnapshotRecord> {
    const pin = this.pins.get(contractId);
    if (!pin) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `getPinnedState: contract ${contractId} is not pinned to any version.`,
      );
    }
    const snapshot = this.snapshots.get(pin.snapshotId);
    if (!snapshot) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `getPinnedState: pinned snapshot ${pin.snapshotId} is no longer available.`,
      );
    }
    return ok(snapshot);
  }

  /** Remove a contract's pin. Returns true when one was removed. */
  unpinContractState(contractId: string): boolean {
    return this.pins.delete(contractId);
  }

  /** Look up one snapshot by id. */
  getSnapshot(snapshotId: string): SorokitResult<ContractStateSnapshotRecord> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `getSnapshot: snapshot ${snapshotId} was not found in this history.`,
      );
    }
    return ok(snapshot);
  }

  /**
   * Query captured snapshots, newest ledger first.
   *
   * Returns only what this history holds. An empty result means nothing was
   * captured for that range — not that the contract had no state.
   */
  querySnapshots(query: SnapshotQuery = {}): ContractStateSnapshotRecord[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => {
        if (query.contractId !== undefined && snapshot.contractId !== query.contractId) return false;
        if (query.fromLedger !== undefined && snapshot.ledger < query.fromLedger) return false;
        if (query.toLedger !== undefined && snapshot.ledger > query.toLedger) return false;
        return true;
      })
      .sort((a, b) => b.ledger - a.ledger || b.timestamp - a.timestamp);
  }

  /**
   * Return the snapshot for a contract at an exact ledger.
   *
   * Reports an explicit error when that ledger was never captured, so callers
   * can distinguish "unavailable" from "empty state".
   */
  getSnapshotAtLedger(contractId: string, ledger: number): SorokitResult<ContractStateSnapshotRecord> {
    const matches = this.querySnapshots({ contractId, fromLedger: ledger, toLedger: ledger });
    const snapshot = matches[0];
    if (!snapshot) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        `getSnapshotAtLedger: no snapshot captured for contract ${contractId} at ledger ${ledger}. ` +
          "This SDK reports only snapshots it captured; it does not reconstruct historical ledger state.",
      );
    }
    return ok(snapshot);
  }

  /**
   * Recompute a snapshot's fingerprint and compare it to the stored value.
   *
   * A mismatch means the stored state was mutated after capture.
   */
  verifySnapshotIntegrity(snapshotId: string): SorokitResult<SnapshotIntegrityReport> {
    const found = this.getSnapshot(snapshotId);
    if (found.status === "error") return found;

    const snapshot = found.data;
    const actual = fingerprintState(snapshot.state as Record<string, unknown>);
    return ok({
      snapshotId,
      valid: actual === snapshot.fingerprint,
      expectedFingerprint: snapshot.fingerprint,
      actualFingerprint: actual,
    });
  }

  /**
   * Compare two captured snapshots key by key.
   *
   * Both snapshots must belong to the same contract; comparing across contracts
   * is rejected as a programming error rather than producing a diff of
   * unrelated state.
   */
  compareSnapshots(fromSnapshotId: string, toSnapshotId: string): SorokitResult<ContractStateComparison> {
    const fromResult = this.getSnapshot(fromSnapshotId);
    if (fromResult.status === "error") return fromResult;
    const toResult = this.getSnapshot(toSnapshotId);
    if (toResult.status === "error") return toResult;

    const from = fromResult.data;
    const to = toResult.data;

    if (from.contractId !== to.contractId) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `compareSnapshots: snapshots belong to different contracts (${from.contractId} vs ${to.contractId}).`,
      );
    }

    const changes: StateEntryChange[] = [];
    const keys = new Set([...Object.keys(from.state), ...Object.keys(to.state)]);

    for (const key of [...keys].sort()) {
      const hadKey = Object.prototype.hasOwnProperty.call(from.state, key);
      const hasKey = Object.prototype.hasOwnProperty.call(to.state, key);
      const before = from.state[key];
      const after = to.state[key];

      if (!hadKey && hasKey) {
        changes.push({ key, kind: "added", to: after });
      } else if (hadKey && !hasKey) {
        changes.push({ key, kind: "removed", from: before });
      } else if (canonicalize(before) !== canonicalize(after)) {
        changes.push({ key, kind: "changed", from: before, to: after });
      }
    }

    return ok({
      contractId: from.contractId,
      fromSnapshotId,
      toSnapshotId,
      fromLedger: from.ledger,
      toLedger: to.ledger,
      identical: from.fingerprint === to.fingerprint,
      changes,
    });
  }

  /** Discard all snapshots and pins. */
  clear(): void {
    this.snapshots.clear();
    this.pins.clear();
    this.sequence = 0;
  }
}

/** Construct a {@link ContractStateHistory}. */
export function createContractStateHistory(): ContractStateHistory {
  return new ContractStateHistory();
}
