import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/**
 * A single point-in-time snapshot of a contract's state, recorded automatically
 * whenever the tracked state changes.
 */
export interface ContractStateSnapshot {
  /** The contract ID this snapshot belongs to. */
  contractId: string;
  /** ISO-8601 timestamp when the snapshot was captured. */
  timestamp: string;
  /** Complete state at the time of capture. */
  state: Record<string, unknown>;
  /** Optional metadata attached at capture time. */
  metadata?: Record<string, unknown>;
}

/**
 * Persistent storage backend for contract state history.
 * Implement this interface to persist history across process restarts.
 * When not provided, history is kept in memory only.
 */
export interface ContractStateHistoryStore {
  append(snapshot: ContractStateSnapshot): void;
  getAll(contractId: string): ContractStateSnapshot[];
  clear(contractId?: string): void;
}

/** Default in-memory implementation used when no store is provided. */
export class InMemoryContractStateHistoryStore
  implements ContractStateHistoryStore
{
  private readonly _history = new Map<string, ContractStateSnapshot[]>();

  append(snapshot: ContractStateSnapshot): void {
    const existing = this._history.get(snapshot.contractId) ?? [];
    this._history.set(snapshot.contractId, [...existing, { ...snapshot }]);
  }

  getAll(contractId: string): ContractStateSnapshot[] {
    return [...(this._history.get(contractId) ?? [])];
  }

  clear(contractId?: string): void {
    if (contractId === undefined) {
      this._history.clear();
    } else {
      this._history.delete(contractId);
    }
  }
}

// Default module-level store — used when callers do not supply their own.
const _defaultStore = new InMemoryContractStateHistoryStore();

/**
 * Record a contract state snapshot.
 *
 * A snapshot is only appended when the serialised state differs from the most
 * recent entry for the same contract, preventing duplicate entries for
 * identical consecutive states.
 *
 * @param contractId - The contract to track.
 * @param state      - Complete current state of the contract.
 * @param metadata   - Optional metadata to attach to the snapshot.
 * @param store      - Optional persistent store; defaults to the module-level in-memory store.
 * @returns The captured snapshot, or `null` when the state was unchanged.
 *
 * @example
 * const result = trackContractStateHistory("CABC...", { counter: 1 });
 * if (result.status === "ok") console.log(result.data); // snapshot | null
 */
export function trackContractStateHistory(
  contractId: string,
  state: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  store: ContractStateHistoryStore = _defaultStore,
): SorokitResult<ContractStateSnapshot | null> {
  if (!contractId || typeof contractId !== "string") {
    return ok(null);
  }

  const existing = store.getAll(contractId);
  const last = existing[existing.length - 1];

  // Skip duplicate consecutive state
  if (last !== undefined && JSON.stringify(last.state) === JSON.stringify(state)) {
    return ok(null);
  }

  const snapshot: ContractStateSnapshot = {
    contractId,
    timestamp: new Date().toISOString(),
    state: { ...state },
    ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
  };

  store.append(snapshot);
  return ok(snapshot);
}

/**
 * Retrieve the full chronological state history for a contract.
 *
 * Returns an empty array for unknown contract IDs.
 * The returned array is a copy — mutations do not affect the stored history.
 *
 * @param contractId - The contract whose history to retrieve.
 * @param store      - Optional persistent store; defaults to the module-level in-memory store.
 *
 * @example
 * const result = getStateHistory("CABC...");
 * if (result.status === "ok") console.log(result.data); // ContractStateSnapshot[]
 */
export function getStateHistory(
  contractId: string,
  store: ContractStateHistoryStore = _defaultStore,
): SorokitResult<ContractStateSnapshot[]> {
  return ok(store.getAll(contractId));
}

/** Clear all tracked history. Useful for test isolation. */
export function clearContractStateHistory(
  contractId?: string,
  store: ContractStateHistoryStore = _defaultStore,
): void {
  store.clear(contractId);
}
