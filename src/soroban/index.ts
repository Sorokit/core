import { StrKey, xdr } from "@stellar/stellar-sdk";
import type { ContractResultType } from "./types";

export type ContractDataType = ContractResultType;

export interface ContractDataValidationIssue {
  field: "contractId" | "key" | "value" | "type";
  message: string;
}

export interface ContractDataValidationResult {
  valid: boolean;
  issues: ContractDataValidationIssue[];
  type?: ContractDataType;
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
export type { InvokeContractOptions } from "./invokeContract";
export { invokeBatchContracts } from "./invokeBatchContracts";
export { subscribeContractEvents, queryContractEvents } from "./subscribeContractEvents";
export { getContractMethods } from "./contractMetadata";
export { ContractInteractionBuilder } from "./contractInteractionBuilder";
export type {
  ContractInteractionBuilderConfig,
  ArgumentField,
  MethodSelection,
  GeneratedCallCode,
  BuilderState,
  BuilderStateListener,
  BuilderStateUnsubscribe,
} from "./contractInteractionBuilder";
export { subscribeContractEvents, queryContractEvents, streamContractEvents } from "./subscribeContractEvents";
export { getContractMethods, parseContractSchema, validateContractArgs } from "./contractMetadata";
export type { ContractSchema, ContractMethodSchema, ContractMethodParam } from "./contractMetadata";
export { validateContractAbi } from "./validateContractAbi";
export { SorobanSimulator } from "./simulator";
export type { SimulatedMethodResult, SorobanSimulatorOptions } from "./simulator";
export { buildContractDeploy } from "./deployContract";
export {
  decodeContractEvent,
  decodeFactoryEvent,
  decodeRouterEvent,
} from "./decodeContractEvent";
export type {
  ContractEventDecoder,
  DecodedContractEvent,
  PairCreatedEvent,
  SwapEvent,
} from "./decodeContractEvent";
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
} from "./types";

const CONTRACT_DATA_TYPES = new Set<ContractDataType>([
  "address",
  "bool",
  "bytes",
  "i128",
  "i32",
  "i64",
  "map",
  "string",
  "symbol",
  "u128",
  "u32",
  "u64",
  "vec",
  "void",
]);

const SCV_NAME_TO_CONTRACT_DATA_TYPE: Record<string, ContractDataType> = {
  scvAddress: "address",
  scvBool: "bool",
  scvBytes: "bytes",
  scvI128: "i128",
  scvI32: "i32",
  scvI64: "i64",
  scvMap: "map",
  scvString: "string",
  scvSymbol: "symbol",
  scvU128: "u128",
  scvU32: "u32",
  scvU64: "u64",
  scvVec: "vec",
  scvVoid: "void",
};

export function validateContractData(
  contractId: string,
  key: unknown,
  value: unknown,
  type?: ContractDataType | string,
): ContractDataValidationResult {
  const issues: ContractDataValidationIssue[] = [];

  if (!isValidContractId(contractId)) {
    issues.push({
      field: "contractId",
      message: "contractId must be a valid Soroban contract address",
    });
  }

  const keyResult = validateUntypedContractValue(key, "key");
  issues.push(...keyResult.issues);

  let resolvedType: ContractDataType | undefined;
  if (type !== undefined) {
    const normalizedType = normalizeContractDataType(type);
    if (normalizedType === undefined) {
      issues.push({
        field: "type",
        message: `Unsupported contract data type "${type}"`,
      });
    } else {
      resolvedType = normalizedType;
      issues.push(...validateTypedContractValue(value, normalizedType, "value"));
    }
  } else {
    const valueResult = validateUntypedContractValue(value, "value");
    resolvedType = valueResult.type;
    issues.push(...valueResult.issues);
  }

  return {
    valid: issues.length === 0,
    issues,
    ...(resolvedType !== undefined ? { type: resolvedType } : {}),
  };
}

function validateUntypedContractValue(
  value: unknown,
  field: "key" | "value",
): { type?: ContractDataType; issues: ContractDataValidationIssue[] } {
  const type = inferContractDataType(value);
  if (type === undefined) {
    return {
      issues: [
        {
          field,
          message: `${field} must be a valid Soroban contract data value`,
        },
      ],
    };
  }
  if (field === "key" && type === "void") {
    return {
      type,
      issues: [
        {
          field,
          message: "key must not be void",
        },
      ],
    };
  }
  return { type, issues: validateTypedContractValue(value, type, field) };
}

function validateTypedContractValue(
  value: unknown,
  type: ContractDataType,
  field: "key" | "value",
): ContractDataValidationIssue[] {
  if (isScVal(value)) {
    const actualType = scValContractDataType(value);
    return actualType === type
      ? []
      : [
          {
            field,
            message: `${field} must be ${type}, got ${actualType ?? "unknown"}`,
          },
        ];
  }

  switch (type) {
    case "address":
      return typeof value === "string" && isValidSorobanAddress(value)
        ? []
        : [{ field, message: `${field} must be a valid Stellar account or contract address` }];
    case "bool":
      return typeof value === "boolean"
        ? []
        : [{ field, message: `${field} must be a boolean` }];
    case "bytes":
      return isBytesLike(value)
        ? []
        : [{ field, message: `${field} must be bytes as Uint8Array, Buffer, or base64 string` }];
    case "i32":
      return isIntegerInRange(value, -2147483648n, 2147483647n)
        ? []
        : [{ field, message: `${field} must be an i32 integer` }];
    case "u32":
      return isIntegerInRange(value, 0n, 4294967295n)
        ? []
        : [{ field, message: `${field} must be a u32 integer` }];
    case "i64":
      return isIntegerInRange(value, -(1n << 63n), (1n << 63n) - 1n)
        ? []
        : [{ field, message: `${field} must be an i64 integer` }];
    case "u64":
      return isIntegerInRange(value, 0n, (1n << 64n) - 1n)
        ? []
        : [{ field, message: `${field} must be a u64 integer` }];
    case "i128":
      return isIntegerInRange(value, -(1n << 127n), (1n << 127n) - 1n)
        ? []
        : [{ field, message: `${field} must be an i128 integer` }];
    case "u128":
      return isIntegerInRange(value, 0n, (1n << 128n) - 1n)
        ? []
        : [{ field, message: `${field} must be a u128 integer` }];
    case "map":
      return isPlainObject(value) || value instanceof Map
        ? []
        : [{ field, message: `${field} must be a map object` }];
    case "string":
      return typeof value === "string"
        ? []
        : [{ field, message: `${field} must be a string` }];
    case "symbol":
      return typeof value === "string" && value.length > 0 && value.length <= 32
        ? []
        : [{ field, message: `${field} must be a non-empty Soroban symbol up to 32 characters` }];
    case "vec":
      return Array.isArray(value)
        ? []
        : [{ field, message: `${field} must be an array` }];
    case "void":
      return value === undefined || value === null
        ? []
        : [{ field, message: `${field} must be undefined or null for void` }];
  }
}

function inferContractDataType(value: unknown): ContractDataType | undefined {
  if (isScVal(value)) return scValContractDataType(value);
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return value >= 0n ? "u128" : "i128";
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value <= 0xffffffff ? "u32" : "i128";
  }
  if (typeof value === "string") {
    if (isValidSorobanAddress(value)) return "address";
    return "string";
  }
  if (isBytesLike(value)) return "bytes";
  if (Array.isArray(value)) return "vec";
  if (isPlainObject(value) || value instanceof Map) return "map";
  if (value === undefined || value === null) return "void";
  return undefined;
}

function scValContractDataType(value: xdr.ScVal): ContractDataType | undefined {
  return SCV_NAME_TO_CONTRACT_DATA_TYPE[value.switch().name];
}

function normalizeContractDataType(type: string): ContractDataType | undefined {
  const normalized = type.toLowerCase().trim() as ContractDataType;
  return CONTRACT_DATA_TYPES.has(normalized) ? normalized : undefined;
}

function isValidContractId(contractId: string): boolean {
  if (typeof contractId !== "string" || contractId.length === 0) return false;
  try {
    StrKey.decodeContract(contractId);
    return true;
  } catch {
    return false;
  }
}

function isValidSorobanAddress(value: string): boolean {
  try {
    StrKey.decodeContract(value);
    return true;
  } catch {
    try {
      StrKey.decodeEd25519PublicKey(value);
      return true;
    } catch {
      return false;
    }
  }
}

function isScVal(value: unknown): value is xdr.ScVal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { switch?: unknown }).switch === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function isBytesLike(value: unknown): boolean {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return true;
  return typeof value === "string" && isBase64(value);
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isIntegerInRange(value: unknown, min: bigint, max: bigint): boolean {
  const parsed = parseInteger(value);
  return parsed !== undefined && parsed >= min && parsed <= max;
}

function parseInteger(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
}
