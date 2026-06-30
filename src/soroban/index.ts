import crypto from "crypto";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ContractStateChangeReport } from "./types";

const MAX_WASM_SIZE = 256 * 1024;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00] as const;

function validateWasmCode(wasmCode: Buffer): SorokitResult<void> {
  if (wasmCode.length === 0) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "WASM code cannot be empty");
  }

  if (wasmCode.length > MAX_WASM_SIZE) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `WASM code exceeds max size of ${MAX_WASM_SIZE} bytes`,
    );
  }

  if (
    wasmCode.length < WASM_MAGIC.length + WASM_VERSION.length ||
    !WASM_MAGIC.every((byte, index) => wasmCode[index] === byte)
  ) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid WASM format: missing magic bytes",
    );
  }

  if (
    !WASM_VERSION.every(
      (byte, index) => wasmCode[WASM_MAGIC.length + index] === byte,
    )
  ) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid WASM format: unsupported WASM version",
    );
  }

  return ok(undefined);
}

/**
 * Build an XDR operation for a Soroban contract upgrade.
 *
 * Soroban upgrades are contract-mediated: upload the new WASM, then invoke the
 * target contract's `upgrade` function with the uploaded WASM SHA-256 hash.
 */
export function buildContractUpgrade(
  contractId: string,
  newWasmCode: Buffer | Uint8Array,
): SorokitResult<string> {
  if (!StrKey.isValidContract(contractId)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid contract ID: expected a Soroban contract address",
    );
  }

  const wasmCode = Buffer.from(newWasmCode);
  const validation = validateWasmCode(wasmCode);
  if (validation.status === "error") {
    return validation;
  }

  try {
    const wasmHash = crypto.createHash("sha256").update(wasmCode).digest();
    const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: "upgrade",
        args: [xdr.ScVal.scvBytes(wasmHash)],
      }),
    );
    const operation = new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.invokeHostFunction(
        new xdr.InvokeHostFunctionOp({
          hostFunction,
          auth: [],
        }),
      ),
    });

    return ok(operation.toXDR("base64"));
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build contract upgrade: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    );
  }
}

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
export { describeStorageSlot } from "./storageSlot";
export type { StorageSlotInfo, StorageSlotType } from "./storageSlot";
