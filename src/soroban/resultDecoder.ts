import { xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { decodeContractValue } from "./contractEncoding";

export type ContractResultPrimitive =
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "string"
  | "symbol"
  | "bytes"
  | "address"
  | "void";

export interface ContractResultStructSchema {
  [field: string]: ContractResultSchema;
}

export type ContractResultSchema =
  | ContractResultPrimitive
  | { type: "array"; items: ContractResultSchema }
  | { type: "struct"; fields: Record<string, ContractResultSchema> }
  | { type: "enum"; variants: Record<string, ContractResultSchema | undefined> }
  | { type: "custom"; decode: (value: unknown, raw: xdr.ScVal) => unknown }
  | ContractResultStructSchema;

export type DecodedContractResult<S> =
  S extends "bool" ? boolean
    : S extends "u32" | "i32" ? number
      : S extends "u64" | "i64" | "u128" | "i128" ? bigint
        : S extends "string" | "symbol" | "address" ? string
          : S extends "bytes" ? Buffer
            : S extends "void" ? undefined
              : S extends { type: "array"; items: infer I } ? DecodedContractResult<I>[]
                : S extends { type: "struct"; fields: infer F }
                  ? { [K in keyof F]: DecodedContractResult<F[K]> }
                  : S extends { type: "enum"; variants: infer V }
                    ? { [K in keyof V]: V[K] extends ContractResultSchema ? { type: K; value: DecodedContractResult<V[K]> } : { type: K } }[keyof V]
                    : S extends { type: "custom"; decode: (...args: never[]) => infer R } ? R
                      : S extends Record<string, infer V> ? { [K in keyof S]: DecodedContractResult<V> }
                        : unknown;

export type ContractResultInput =
  | xdr.ScVal
  | string
  | { retval?: xdr.ScVal | string; result?: { retval?: xdr.ScVal | string } };

const PRIMITIVE_SCVAL: Record<ContractResultPrimitive, string> = {
  bool: "scvBool",
  u32: "scvU32",
  i32: "scvI32",
  u64: "scvU64",
  i64: "scvI64",
  u128: "scvU128",
  i128: "scvI128",
  string: "scvString",
  symbol: "scvSymbol",
  bytes: "scvBytes",
  address: "scvAddress",
  void: "scvVoid",
};

function extractScVal(input: ContractResultInput): xdr.ScVal {
  const value = typeof input === "object" && !(input instanceof xdr.ScVal)
    ? input.retval ?? input.result?.retval
    : input;
  if (value instanceof xdr.ScVal) return value;
  if (typeof value === "string") return xdr.ScVal.fromXDR(value, "base64");
  throw new TypeError("Contract result must be an ScVal, base64 XDR, or an object containing retval.");
}

function isSchemaRecord(schema: ContractResultSchema): schema is Record<string, ContractResultSchema> {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema) && !("type" in schema);
}

function decodeWithSchema(raw: xdr.ScVal, schema: ContractResultSchema): unknown {
  if (typeof schema === "string") {
    const expected = PRIMITIVE_SCVAL[schema as ContractResultPrimitive];
    if (raw.switch().name !== expected) {
      throw new TypeError(`Expected ${schema}, received ${raw.switch().name}.`);
    }
    const decoded = decodeContractValue(raw);
    return schema === "bytes" ? Buffer.from(decoded as Uint8Array) : decoded;
  }

  if (isSchemaRecord(schema)) {
    const decoded = decodeContractValue(raw);
    if (Array.isArray(decoded)) {
      const keys = Object.keys(schema);
      if (decoded.length !== keys.length) throw new TypeError("Struct tuple length does not match schema.");
      return Object.fromEntries(keys.map((key, index) => {
        const item = raw.vec()?.[index];
        if (!item) throw new TypeError(`Struct field ${key} is missing.`);
        return [key, decodeWithSchema(item, schema[key]!)];
      }));
    }
    if (typeof decoded !== "object" || decoded === null) throw new TypeError("Expected a struct/map result.");
    const rawEntries = raw.map();
    const rawByKey = new Map<string, xdr.ScVal>();
    for (const entry of rawEntries ?? []) rawByKey.set(String(decodeContractValue(entry.key())), entry.val());
    return Object.fromEntries(Object.entries(schema).map(([key, child]) => {
      const value = rawByKey.get(key);
      if (!value) throw new TypeError(`Struct field ${key} is missing.`);
      return [key, decodeWithSchema(value, child)];
    }));
  }

  switch (schema.type) {
    case "custom":
      return schema.decode(decodeContractValue(raw), raw);
    case "array": {
      if (raw.switch().name !== "scvVec") throw new TypeError("Expected a vector result.");
      return (raw.vec() ?? []).map((item) => decodeWithSchema(item, schema.items));
    }
    case "struct":
      return decodeWithSchema(raw, schema.fields);
    case "enum": {
      if (raw.switch().name !== "scvVec") throw new TypeError("Expected an enum vector result.");
      const parts = raw.vec() ?? [];
      if (parts.length === 0) throw new TypeError("Enum result is empty.");
      const variantName = String(decodeContractValue(parts[0]!));
      if (!Object.prototype.hasOwnProperty.call(schema.variants, variantName)) {
        throw new TypeError(`Unknown enum variant: ${variantName}.`);
      }
      const variantSchema = schema.variants[variantName];
      if (variantSchema === undefined) return { type: variantName };
      if (parts.length !== 2) throw new TypeError(`Enum variant ${variantName} must contain one payload.`);
      return { type: variantName, value: decodeWithSchema(parts[1]!, variantSchema) };
    }
  }
}

export function decodeContractResult<S extends ContractResultSchema>(
  result: ContractResultInput,
  schema: S,
): SorokitResult<DecodedContractResult<S>> {
  try {
    const decoded = decodeWithSchema(extractScVal(result), schema);
    return ok(decoded as DecodedContractResult<S>);
  } catch (cause) {
    return err(SorokitErrorCode.XDR_INVALID, "Failed to decode contract invocation result.", cause);
  }
}

export function createDecoder<S extends ContractResultSchema>(schema: S): (
  result: ContractResultInput,
) => SorokitResult<DecodedContractResult<S>> {
  return (result) => decodeContractResult(result, schema);
}