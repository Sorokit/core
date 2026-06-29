import type { ContractStateChangeReport } from "./types";

export { readContract } from "./readContract";
export { decodeContractValue, encodeContractArgs } from "./contractEncoding";
export { parseContractResult } from "./parseContractResult";
export { prepareContractCall } from "./prepareCall";
export { simulateTransaction } from "./simulateTransaction";
export { simulateContractSafe } from "./simulateContractSafe";
export type {
  SimulateContractSafeOptions,
  SafeSimulationResult,
} from "./simulateContractSafe";
export { executeContract } from "./executeContract";
export { invokeContract } from "./invokeContract";
export { invokeBatchContracts } from "./invokeBatchContracts";
export { subscribeContractEvents } from "./subscribeContractEvents";
export { getContractMethods } from "./contractMetadata";
export { validateContractAbi } from "./validateContractAbi";
export { buildContractDeploy } from "./deployContract";
export {
  snapshotContractState,
  compareSnapshots,
  listSnapshots,
  clearSnapshots,
} from "./contractSnapshot";
export type { ContractSnapshot, SnapshotDiff } from "./contractSnapshot";
export type { BuildContractDeployOptions } from "./deployContract";
export type {
  ContractEvent,
  ContractEventFilter,
  ContractEventSubscriptionOptions,
} from "./subscribeContractEvents";
export type {
  ContractMethod,
  ContractMethodInput,
  ContractAbi,
  ContractAbiMethod,
  ContractInvokeParams,
  ContractReadParams,
  ContractCallResult,
  PreparedContractCall,
  ContractResultType,
  ParsedContractResult,
  SorobanPollConfig,
  SimulateTransactionResult,
  BatchContractInvocation,
  BatchContractResult,
  ContractStateChangeReport,
} from "./types";

/**
 * Detect changes between two contract states.
 * Compares oldState and newState, returning a detailed report of added, removed, and modified fields.
 *
 * @param oldState - The previous state object
 * @param newState - The new state object
 * @returns A report detailing all state changes
 */
export function detectContractStateChanges(
  oldState: Record<string, unknown>,
  newState: Record<string, unknown>,
): ContractStateChangeReport {
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const modified: Record<string, { oldValue: unknown; newValue: unknown }> = {};

  for (const key of Object.keys(newState)) {
    if (!(key in oldState)) {
      added[key] = newState[key];
    } else if (JSON.stringify(oldState[key]) !== JSON.stringify(newState[key])) {
      modified[key] = { oldValue: oldState[key], newValue: newState[key] };
    }
  }

  for (const key of Object.keys(oldState)) {
    if (!(key in newState)) {
      removed[key] = oldState[key];
    }
  }

  return { added, removed, modified };
}
