/** A serializable Soroban contract state entry. Keys and values are XDR strings. */
export interface ContractStateEntry {
  key: string;
  value: string;
  lastModifiedLedger?: number;
}

/** Immutable representation of the state selected for inspection. */
export interface ContractStateSnapshot {
  contractId: string;
  capturedAt: number;
  entries: readonly ContractStateEntry[];
  digest: string;
}

export type StateChangeKind = "added" | "removed" | "changed";

export interface ContractStateChange {
  kind: StateChangeKind;
  key: string;
  before?: ContractStateEntry;
  after?: ContractStateEntry;
}

export interface ContractStateDiff {
  contractId: string;
  beforeDigest: string;
  afterDigest: string;
  changes: readonly ContractStateChange[];
  added: number;
  removed: number;
  changed: number;
}

export type ContractStateReader = (
  contractId: string,
) => Promise<readonly ContractStateEntry[]>;

function canonicalEntries(entries: readonly ContractStateEntry[]): ContractStateEntry[] {
  return [...entries]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

async function digestEntries(entries: readonly ContractStateEntry[]): Promise<string> {
  const canonical = canonicalEntries(entries)
    .map((entry) => `${entry.key}\u0000${entry.value}\u0000${entry.lastModifiedLedger ?? ""}`)
    .join("\n");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical) as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Capture a deterministic snapshot from a reader supplied by the RPC adapter. */
export async function captureContractState(
  contractId: string,
  reader: ContractStateReader,
  store?: StateSnapshotStore,
): Promise<ContractStateSnapshot> {
  if (!contractId.trim()) throw new Error("contractId must not be empty");
  const entries = canonicalEntries(await reader(contractId));
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  const normalized = [...unique.values()];
  const snapshot = Object.freeze({
    contractId,
    capturedAt: Date.now(),
    entries: Object.freeze(normalized),
    digest: await digestEntries(normalized),
  });
  // When a retention-managed store is supplied, register the snapshot so
  // old entries are pruned automatically instead of growing unbounded (#707).
  store?.track(snapshot);
  return snapshot;
}

/** Compare two snapshots and classify every key-level state transition. */
export function diffContractState(
  before: ContractStateSnapshot,
  after: ContractStateSnapshot,
): ContractStateDiff {
  if (before.contractId !== after.contractId) {
    throw new Error("cannot diff snapshots from different contracts");
  }
  const left = new Map(before.entries.map((entry) => [entry.key, entry]));
  const right = new Map(after.entries.map((entry) => [entry.key, entry]));
  const changes: ContractStateChange[] = [];

  for (const [key, entry] of right) {
    const previous = left.get(key);
    if (!previous) changes.push({ kind: "added", key, after: entry });
    else if (
      previous.value !== entry.value ||
      previous.lastModifiedLedger !== entry.lastModifiedLedger
    ) {
      changes.push({ kind: "changed", key, before: previous, after: entry });
    }
  }
  for (const [key, entry] of left) {
    if (!right.has(key)) changes.push({ kind: "removed", key, before: entry });
  }
  changes.sort((a, b) => a.key.localeCompare(b.key));
  return {
    contractId: before.contractId,
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changes,
    added: changes.filter((change) => change.kind === "added").length,
    removed: changes.filter((change) => change.kind === "removed").length,
    changed: changes.filter((change) => change.kind === "changed").length,
  };
}

/** Capture the state transition caused by an invocation callback. */
export async function inspectContractInvocation<T>(
  contractId: string,
  reader: ContractStateReader,
  invoke: () => Promise<T>,
  store?: StateSnapshotStore,
): Promise<{ result: T; before: ContractStateSnapshot; after: ContractStateSnapshot; diff: ContractStateDiff }> {
  const before = await captureContractState(contractId, reader, store);
  const result = await invoke();
  const after = await captureContractState(contractId, reader, store);
  return { result, before, after, diff: diffContractState(before, after) };
}

export const snapshotContractState = captureContractState;
export const diffSnapshots = diffContractState;

// ─── Retention-managed snapshot store (#707) ────────────────────────────────
// Long-running apps that call captureContractState() in a loop previously had
// no place to bound retained snapshots, so memory grew without limit. This
// store tracks snapshots per contract and prunes them automatically using a
// configurable retention policy (count + age), with dev-mode memory warnings.

/** Retention policy for tracked contract state snapshots. */
export interface SnapshotRetentionPolicy {
  /** Max snapshots kept per contract. Older ones are evicted first. Default: 50. */
  maxSnapshotsPerContract?: number;
  /** Max snapshots kept across all contracts. Default: 500. */
  maxTotalSnapshots?: number;
  /** Max age (ms) before a snapshot is evicted. Omit for no age limit. */
  maxAgeMs?: number;
  /** Emit console.warn when estimated retained size exceeds this (bytes). Default: 5 MiB. */
  warnBytesThreshold?: number;
}

export interface SnapshotStoreStats {
  totalSnapshots: number;
  contractsTracked: number;
  estimatedBytes: number;
  lastPrunedAt?: number;
}

function estimateSnapshotBytes(snapshot: ContractStateSnapshot): number {
  let bytes = snapshot.contractId.length * 2 + 64 + 16;
  for (const entry of snapshot.entries) {
    bytes += entry.key.length * 2 + entry.value.length * 2 + 16;
  }
  return bytes;
}

/** Retention-managed registry for contract state snapshots. */
export class StateSnapshotStore {
  private readonly snapshots = new Map<string, ContractStateSnapshot[]>();
  private lastPrunedAt?: number;
  private warned = false;

  constructor(private readonly policy: SnapshotRetentionPolicy = {}) {}

  /** Register a snapshot; prunes automatically per the retention policy. */
  track(snapshot: ContractStateSnapshot): void {
    const list = this.snapshots.get(snapshot.contractId) ?? [];
    list.push(snapshot);
    this.snapshots.set(snapshot.contractId, list);
    this.prune();
  }

  /** Snapshots for a contract, oldest first. */
  getSnapshots(contractId: string): ContractStateSnapshot[] {
    return [...(this.snapshots.get(contractId) ?? [])];
  }

  /** Remove snapshots for one contract. Returns the number removed. */
  clearContract(contractId: string): number {
    const list = this.snapshots.get(contractId);
    if (!list) return 0;
    this.snapshots.delete(contractId);
    this.warned = false;
    return list.length;
  }

  /** Remove all tracked snapshots. */
  clear(): void {
    this.snapshots.clear();
    this.lastPrunedAt = Date.now();
    this.warned = false;
  }

  /** Evict snapshots that exceed count/age limits. Returns evicted count. */
  prune(now: number = Date.now()): number {
    const maxPerContract = this.policy.maxSnapshotsPerContract ?? 50;
    const maxTotal = this.policy.maxTotalSnapshots ?? 500;
    const maxAgeMs = this.policy.maxAgeMs;
    let evicted = 0;

    for (const [contractId, list] of this.snapshots) {
      let kept = maxAgeMs === undefined
        ? list
        : list.filter((s) => now - s.capturedAt <= maxAgeMs);
      evicted += list.length - kept.length;
      if (kept.length > maxPerContract) {
        evicted += kept.length - maxPerContract;
        kept = kept.slice(kept.length - maxPerContract);
      }
      if (kept.length === 0) this.snapshots.delete(contractId);
      else this.snapshots.set(contractId, kept);
    }

    const total = this.size();
    if (total > maxTotal) {
      const all: Array<{ contractId: string; snapshot: ContractStateSnapshot }> = [];
      for (const [contractId, list] of this.snapshots) {
        for (const snapshot of list) all.push({ contractId, snapshot });
      }
      all.sort((a, b) => a.snapshot.capturedAt - b.snapshot.capturedAt);
      const excess = total - maxTotal;
      for (let i = 0; i < excess; i++) {
        const entry = all[i];
        if (!entry) break;
        const list = this.snapshots.get(entry.contractId);
        if (!list) continue;
        const idx = list.indexOf(entry.snapshot);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.snapshots.delete(entry.contractId);
        evicted++;
      }
    }

    this.lastPrunedAt = now;
    this.maybeWarn();
    return evicted;
  }

  size(): number {
    let total = 0;
    for (const list of this.snapshots.values()) total += list.length;
    return total;
  }

  stats(): SnapshotStoreStats {
    let bytes = 0;
    for (const list of this.snapshots.values()) {
      for (const s of list) bytes += estimateSnapshotBytes(s);
    }
    return {
      totalSnapshots: this.size(),
      contractsTracked: this.snapshots.size,
      estimatedBytes: bytes,
      ...(this.lastPrunedAt !== undefined ? { lastPrunedAt: this.lastPrunedAt } : {}),
    };
  }

  private maybeWarn(): void {
    const threshold = this.policy.warnBytesThreshold ?? 5 * 1024 * 1024;
    if (this.warned) return;
    const { estimatedBytes, totalSnapshots } = this.stats();
    if (estimatedBytes > threshold && typeof console !== "undefined") {
      this.warned = true;
      console.warn(
        `[sorokit] StateSnapshotStore holding ~${Math.round(estimatedBytes / 1024)} KiB ` +
        `across ${totalSnapshots} snapshots; consider lowering maxSnapshotsPerContract/maxTotalSnapshots.`,
      );
    }
  }
}

/** Create a retention-managed snapshot store (see {@link StateSnapshotStore}). */
export function createStateSnapshotStore(policy?: SnapshotRetentionPolicy): StateSnapshotStore {
  return new StateSnapshotStore(policy);
}
