import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  ContractStateHistory,
  createContractStateHistory,
} from "./contractStateHistory";
import type {
  ContractStateComparison,
  ContractStateSnapshotRecord,
} from "./contractStateHistory";
import { fingerprintState } from "./contractStateHistory";

export interface ContractStateRead {
  ledger: number;
  state: Record<string, unknown>;
}

export type ContractStateSource = (contractId: string) => Promise<ContractStateRead>;

export interface WatchContractStateOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

const defaultHistory = createContractStateHistory();

function captureRead(
  contractId: string,
  read: ContractStateRead,
  history: ContractStateHistory,
): SorokitResult<ContractStateSnapshotRecord> {
  return history.captureSnapshot({
    contractId,
    ledger: read.ledger,
    state: read.state,
  });
}

export async function getContractState(
  contractId: string,
  source: ContractStateSource,
  history: ContractStateHistory = defaultHistory,
): Promise<SorokitResult<ContractStateSnapshotRecord>> {
  try {
    return captureRead(contractId, await source(contractId), history);
  } catch (cause) {
    return err(SorokitErrorCode.CONTRACT_READ_FAILED, "Failed to read contract state.", cause);
  }
}

export function getContractStateAt(
  contractId: string,
  ledger: number,
  history: ContractStateHistory = defaultHistory,
): SorokitResult<ContractStateSnapshotRecord> {
  if (!Number.isInteger(ledger) || ledger < 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "ledger must be a non-negative integer.");
  }
  return history.getSnapshotAtLedger(contractId, ledger);
}

export function getStateChanges(
  contractId: string,
  fromLedger: number,
  toLedger: number,
  history: ContractStateHistory = defaultHistory,
): SorokitResult<ContractStateComparison> {
  if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger) || fromLedger < 0 || toLedger < fromLedger) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Ledger range must be an ordered pair of non-negative integers.");
  }
  const from = history.getSnapshotAtLedger(contractId, fromLedger);
  if (from.status === "error") return from;
  const to = history.getSnapshotAtLedger(contractId, toLedger);
  if (to.status === "error") return to;
  return history.compareSnapshots(from.data.id, to.data.id);
}

export async function* watchContractState(
  contractId: string,
  source: ContractStateSource,
  options: WatchContractStateOptions = {},
  history: ContractStateHistory = defaultHistory,
): AsyncGenerator<SorokitResult<ContractStateSnapshotRecord>> {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    yield err(SorokitErrorCode.INVALID_CONFIG, "intervalMs must be a positive finite number.");
    return;
  }

  let lastLedger: number | undefined;
  let lastFingerprint: string | undefined;
  while (!options.signal?.aborted) {
    try {
      const read = await source(contractId);
      const fingerprint = fingerprintState(read.state);
      if (read.ledger !== lastLedger || fingerprint !== lastFingerprint) {
        const current = captureRead(contractId, read, history);
        yield current;
        if (current.status === "ok") {
          lastLedger = current.data.ledger;
          lastFingerprint = current.data.fingerprint;
        }
      }
    } catch (cause) {
      yield err(SorokitErrorCode.CONTRACT_READ_FAILED, "Failed to read contract state.", cause);
    }
    if (options.signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}