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
): Promise<ContractStateSnapshot> {
  if (!contractId.trim()) throw new Error("contractId must not be empty");
  const entries = canonicalEntries(await reader(contractId));
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  const normalized = [...unique.values()];
  return Object.freeze({
    contractId,
    capturedAt: Date.now(),
    entries: Object.freeze(normalized),
    digest: await digestEntries(normalized),
  });
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
): Promise<{ result: T; before: ContractStateSnapshot; after: ContractStateSnapshot; diff: ContractStateDiff }> {
  const before = await captureContractState(contractId, reader);
  const result = await invoke();
  const after = await captureContractState(contractId, reader);
  return { result, before, after, diff: diffContractState(before, after) };
}

export const snapshotContractState = captureContractState;
export const diffSnapshots = diffContractState;
