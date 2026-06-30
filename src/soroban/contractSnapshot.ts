import { Contract, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

export interface ContractSnapshot {
  /** Unique snapshot identifier */
  id: string;
  contractId: string;
  label: string;
  /** ISO-8601 timestamp when snapshot was taken */
  timestamp: string;
  /** Serializable contract state extracted from ledger */
  state: Record<string, unknown>;
}

export interface SnapshotDiff {
  label1: string;
  label2: string;
  /** Keys present in snapshot2 but not in snapshot1 */
  added: Record<string, unknown>;
  /** Keys present in snapshot1 but not in snapshot2 */
  removed: Record<string, unknown>;
  /** Keys whose values differ between the two snapshots */
  changed: Record<string, { from: unknown; to: unknown }>;
}

// In-memory snapshot store indexed by label
const _snapshots = new Map<string, ContractSnapshot>();

/** Clear all stored snapshots. Useful for test isolation. */
export function clearSnapshots(): void {
  _snapshots.clear();
}

/** Return all stored snapshots, optionally filtered by contractId. */
export function listSnapshots(contractId?: string): ContractSnapshot[] {
  const all = Array.from(_snapshots.values());
  if (contractId === undefined) return all;
  return all.filter((s) => s.contractId === contractId);
}

function extractState(entry: unknown): Record<string, unknown> {
  try {
    const contractData = (entry as { val: { contractData: () => unknown } }).val.contractData();
    const instance = (contractData as { val: () => { instance: () => unknown } }).val().instance();
    const executable = (instance as { executable: () => unknown }).executable();
    const execName = (executable as { switch: () => { name: string } }).switch().name;

    if (execName === "contractExecutableWasm") {
      const wasmHash = (executable as { wasmHash: () => Buffer }).wasmHash();
      return {
        executable: "wasm",
        wasmHash: Buffer.from(wasmHash).toString("hex"),
      };
    }
    if (execName === "contractExecutableStellarAsset") {
      return { executable: "stellar_asset" };
    }
    return { executable: execName };
  } catch {
    return {};
  }
}

function diffObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Pick<SnapshotDiff, "added" | "removed" | "changed"> {
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of Object.keys(b)) {
    if (!(key in a)) {
      added[key] = b[key];
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changed[key] = { from: a[key], to: b[key] };
    }
  }
  for (const key of Object.keys(a)) {
    if (!(key in b)) {
      removed[key] = a[key];
    }
  }

  return { added, removed, changed };
}

/**
 * Capture a snapshot of a contract's current on-chain state.
 *
 * Reads the contract instance from the Soroban RPC and stores it under
 * the given `label`. Re-using the same label overwrites the previous snapshot.
 * When no label is provided, one is generated from the current timestamp.
 *
 * @example
 * const snap = await snapshotContractState(rpcUrl, networkConfig, contractId, "before-upgrade");
 */
export async function snapshotContractState(
  rpcUrl: string,
  contractId: string,
  label?: string,
): Promise<SorokitResult<ContractSnapshot>> {
  const snapshotLabel = label ?? `snapshot-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const id = `${contractId.slice(0, 8)}-${Date.now()}`;

  try {
    const rpc = new SorobanRpc.Server(rpcUrl);
    const contract = new Contract(contractId);
    const instanceResult = await rpc.getLedgerEntries(contract.getFootprint());
    const instanceEntry = instanceResult.entries[0];

    const state: Record<string, unknown> = instanceEntry
      ? extractState(instanceEntry)
      : {};

    const snapshot: ContractSnapshot = { id, contractId, label: snapshotLabel, timestamp, state };
    _snapshots.set(snapshotLabel, snapshot);
    return ok(snapshot);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to snapshot contract state: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Compare two stored snapshots and return a structured diff.
 *
 * @param label1 - Label of the baseline snapshot.
 * @param label2 - Label of the comparison snapshot.
 *
 * @example
 * const diff = compareSnapshots("before-upgrade", "after-upgrade");
 */
export function compareSnapshots(
  label1: string,
  label2: string,
): SorokitResult<SnapshotDiff> {
  const snap1 = _snapshots.get(label1);
  const snap2 = _snapshots.get(label2);

  if (!snap1) {
    return err(SorokitErrorCode.UNKNOWN, `Snapshot not found: ${label1}`);
  }
  if (!snap2) {
    return err(SorokitErrorCode.UNKNOWN, `Snapshot not found: ${label2}`);
  }

  return ok({
    label1,
    label2,
    ...diffObjects(snap1.state, snap2.state),
  });
}
