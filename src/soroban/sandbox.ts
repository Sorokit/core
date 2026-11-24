/**
 * Local contract sandbox.
 *
 * This is a deterministic mock environment, not a Soroban VM. It is intended
 * for local SDK development and unit tests without an RPC or ledger.
 */

import {
  err,
  ok,
  SorokitErrorCode,
  type SorokitResult,
} from "../shared/response";

export interface SandboxResult {
  contractId?: string;
  result?: unknown;
  state?: Record<string, unknown>;
}

interface SandboxContract {
  wasmBytes: Uint8Array;
  state: Record<string, unknown>;
}

export interface ContractSandbox {
  deployContract(wasmBytes: Uint8Array | ArrayBuffer): SorokitResult<SandboxResult>;
  invokeContract(
    contractId: string,
    method: string,
    args?: unknown[],
  ): SorokitResult<SandboxResult>;
  getContractState(contractId: string): SorokitResult<SandboxResult>;
}

function copyState(state: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === null || typeof value !== "object") {
      copy[key] = value;
      continue;
    }
    try {
      copy[key] = JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      copy[key] = value;
    }
  }
  return copy;
}

function wasmBytesFrom(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array
    ? new Uint8Array(input)
    : new Uint8Array(input);
}

function contractIdFor(bytes: Uint8Array, sequence: number): string {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= sequence;
  hash = Math.imul(hash, 16777619);
  return `C${(hash >>> 0).toString(16).padStart(8, "0").repeat(7).slice(0, 55)}`;
}

/** Create an isolated mock contract ledger and invocation environment. */
export function createSandbox(): ContractSandbox {
  const contracts = new Map<string, SandboxContract>();
  let sequence = 0;

  return {
    deployContract(wasmBytes) {
      if (
        !(wasmBytes instanceof Uint8Array) &&
        !(wasmBytes instanceof ArrayBuffer)
      ) {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          "wasmBytes must be a Uint8Array or ArrayBuffer",
        );
      }

      const bytes = wasmBytesFrom(wasmBytes);
      if (bytes.length === 0) {
        return err(
          SorokitErrorCode.INVALID_CONFIG,
          "wasmBytes must not be empty",
        );
      }

      let contractId = contractIdFor(bytes, sequence++);
      while (contracts.has(contractId)) {
        contractId = contractIdFor(bytes, sequence++);
      }
      contracts.set(contractId, { wasmBytes: bytes, state: {} });
      return ok({ contractId });
    },

    invokeContract(contractId, method, args = []) {
      if (typeof contractId !== "string" || contractId.trim().length === 0) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Contract ID must be a non-empty string",
        );
      }
      if (typeof method !== "string" || method.trim().length === 0) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Contract method must be a non-empty string",
        );
      }
      if (!Array.isArray(args)) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Contract arguments must be an array",
        );
      }

      const contract = contracts.get(contractId);
      if (contract === undefined) {
        return err(
          SorokitErrorCode.CONTRACT_INVOKE_FAILED,
          `Contract not found in sandbox: ${contractId}`,
        );
      }

      let result: unknown;
      if (method === "set" || method === "set_state") {
        if (args.length >= 2) {
          contract.state[String(args[0])] = args[1];
          result = args[1];
        } else if (args.length === 1 && args[0] !== null && typeof args[0] === "object") {
          Object.assign(contract.state, args[0] as Record<string, unknown>);
          result = copyState(contract.state);
        } else {
          result = null;
        }
      } else if (method === "get" || method === "get_state") {
        if (args.length > 0) {
          result = contract.state[String(args[0])];
        } else {
          result = copyState(contract.state);
        }
      } else {
        contract.state[method] = args.length <= 1 ? args[0] : args;
        result = contract.state[method];
      }

      return ok({ contractId, result });
    },

    getContractState(contractId) {
      if (typeof contractId !== "string" || contractId.trim().length === 0) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Contract ID must be a non-empty string",
        );
      }
      const contract = contracts.get(contractId);
      if (contract === undefined) {
        return err(
          SorokitErrorCode.CONTRACT_READ_FAILED,
          `Contract not found in sandbox: ${contractId}`,
        );
      }
      return ok({ contractId, state: copyState(contract.state) });
    },
  };
}
