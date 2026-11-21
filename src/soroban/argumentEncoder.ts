/**
 * Soroban contract argument encoder (#976).
 *
 * `encodeArg(value, type)` validates a JS value against a Soroban type and,
 * only if it is valid, encodes it to an `xdr.ScVal`. Invalid input never
 * throws: it returns a `VALIDATION` error that names the offending path
 * (e.g. `args[1].amount`), so callers can surface it directly.
 *
 * Type names follow the Soroban `ScSpecType` names used in contract specs
 * (https://developers.stellar.org/docs/learn/fundamentals/contract-development/types):
 *
 * | Type                  | Accepted JS values                                     | ScVal          |
 * | --------------------- | ------------------------------------------------------ | -------------- |
 * | `bool`                | `boolean`                                              | `scvBool`      |
 * | `void`                | `null` / `undefined`                                   | `scvVoid`      |
 * | `u32` / `i32`         | integer `number`/`bigint`/decimal string in range      | `scvU32/I32`   |
 * | `u64` / `i64`         | integer `number`/`bigint`/decimal string in range      | `scvU64/I64`   |
 * | `u128` / `i128`       | integer `number`/`bigint`/decimal string in range      | `scvU128/I128` |
 * | `u256` / `i256`       | integer `number`/`bigint`/decimal string in range      | `scvU256/I256` |
 * | `timepoint`/`duration`| like `u64` (seconds)                                   | `scvTimepoint` / `scvDuration` |
 * | `string`              | `string`                                               | `scvString`    |
 * | `symbol`              | `string`, ≤ 32 chars of `[A-Za-z0-9_]`                 | `scvSymbol`    |
 * | `bytes`               | `Uint8Array` / `Buffer` / hex string (`0x` optional)   | `scvBytes`     |
 * | `{ type: "bytesN", length }` | as `bytes`, exactly `length` bytes (1–2^32)     | `scvBytes`     |
 * | `address`             | `G…` account or `C…` contract strkey                   | `scvAddress`   |
 * | `{ type: "vec", element }`       | array, each item encoded as `element`       | `scvVec`       |
 * | `{ type: "map", key, value }`    | `Map` or plain object / entry array          | `scvMap` (keys sorted) |
 * | `{ type: "option", inner }`      | `null`/`undefined` → void, else `inner`      | `scvVoid` or inner |
 * | `{ type: "tuple", elements }`    | array of exact length                        | `scvVec`       |
 *
 * Numbers above `Number.MAX_SAFE_INTEGER` are rejected (they have already
 * lost precision); pass a `bigint` or decimal string for large values.
 *
 * Out of scope: parsing a contract ABI/spec into these descriptors.
 */
import { Address, nativeToScVal, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Integer Soroban types and their inclusive bounds. */
export type SorobanIntegerType =
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "u256"
  | "i256"
  | "timepoint"
  | "duration";

/** Soroban types that need no extra parameters. */
export type SorobanScalarType =
  | SorobanIntegerType
  | "bool"
  | "void"
  | "string"
  | "symbol"
  | "bytes"
  | "address";

/** A Soroban type: a scalar name or a parameterised descriptor. */
export type SorobanArgType =
  | SorobanScalarType
  | { type: "bytesN"; length: number }
  | { type: "vec"; element: SorobanArgType }
  | { type: "map"; key: SorobanArgType; value: SorobanArgType }
  | { type: "option"; inner: SorobanArgType }
  | { type: "tuple"; elements: SorobanArgType[] };

/** One positional argument for {@link encodeArgs}. */
export interface SorobanArgSpec {
  value: unknown;
  type: SorobanArgType;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INTEGER_BOUNDS: Record<SorobanIntegerType, { min: bigint; max: bigint; scvType: string }> = {
  u32: { min: 0n, max: 2n ** 32n - 1n, scvType: "u32" },
  i32: { min: -(2n ** 31n), max: 2n ** 31n - 1n, scvType: "i32" },
  u64: { min: 0n, max: 2n ** 64n - 1n, scvType: "u64" },
  i64: { min: -(2n ** 63n), max: 2n ** 63n - 1n, scvType: "i64" },
  u128: { min: 0n, max: 2n ** 128n - 1n, scvType: "u128" },
  i128: { min: -(2n ** 127n), max: 2n ** 127n - 1n, scvType: "i128" },
  u256: { min: 0n, max: 2n ** 256n - 1n, scvType: "u256" },
  i256: { min: -(2n ** 255n), max: 2n ** 255n - 1n, scvType: "i256" },
  timepoint: { min: 0n, max: 2n ** 64n - 1n, scvType: "timepoint" },
  duration: { min: 0n, max: 2n ** 64n - 1n, scvType: "duration" },
};

/** Soroban symbols: at most 32 characters from `[A-Za-z0-9_]`. */
const SYMBOL_RE = /^[A-Za-z0-9_]{0,32}$/;
const DECIMAL_INT_RE = /^-?\d+$/;
const HEX_RE = /^(0x)?([0-9a-fA-F]{2})*$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Internal sentinel so nested validation can short-circuit without throwing. */
class EncodeError extends Error {}

function fail(path: string, message: string): never {
  throw new EncodeError(`${path}: ${message}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}

function typeName(type: SorobanArgType): string {
  if (typeof type === "string") return type;
  switch (type.type) {
    case "bytesN":
      return `bytesN<${type.length}>`;
    case "vec":
      return `vec<${typeName(type.element)}>`;
    case "map":
      return `map<${typeName(type.key)}, ${typeName(type.value)}>`;
    case "option":
      return `option<${typeName(type.inner)}>`;
    case "tuple":
      return `tuple<${type.elements.map(typeName).join(", ")}>`;
  }
}

function toBigIntStrict(value: unknown, path: string, type: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) fail(path, `${type} requires an integer, got ${value}`);
    if (!Number.isSafeInteger(value)) {
      fail(path, `${value} exceeds Number.MAX_SAFE_INTEGER; pass a bigint or decimal string for ${type}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_INT_RE.test(trimmed)) fail(path, `${type} requires a decimal integer string, got "${value}"`);
    return BigInt(trimmed);
  }
  return fail(path, `${type} requires a number, bigint or decimal string, got ${describe(value)}`);
}

function toBytes(value: unknown, path: string, type: string): Uint8Array {
  if (value instanceof Uint8Array) return value; // Buffer is a Uint8Array subclass
  if (typeof value === "string") {
    if (!HEX_RE.test(value)) fail(path, `${type} requires an even-length hex string, got "${value}"`);
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return fail(path, `${type} requires a Uint8Array, Buffer or hex string, got ${describe(value)}`);
}

function mapEntries(value: unknown, path: string): Array<[unknown, unknown]> {
  if (value instanceof Map) return Array.from(value.entries());
  if (Array.isArray(value)) {
    return value.map((entry, i) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        fail(`${path}[${i}]`, "map entries must be [key, value] pairs");
      }
      return [entry[0], entry[1]] as [unknown, unknown];
    });
  }
  if (typeof value === "object" && value !== null) return Object.entries(value);
  return fail(path, `map requires a Map, plain object or [key, value][] array, got ${describe(value)}`);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

const INTEGER_SCV = new Set([
  "scvU32",
  "scvI32",
  "scvU64",
  "scvI64",
  "scvTimepoint",
  "scvDuration",
  "scvU128",
  "scvI128",
  "scvU256",
  "scvI256",
]);

function sign(n: bigint): number {
  return n < 0n ? -1 : n > 0n ? 1 : 0;
}

/**
 * Total order over the ScVals this encoder produces, mirroring the Soroban
 * host's `ScVal` ordering: first by type tag, then by value (numbers
 * numerically, bytes/strings/symbols bytewise, addresses by their XDR,
 * vectors and maps element by element).
 */
function compareScVal(a: xdr.ScVal, b: xdr.ScVal): number {
  const tagDiff = a.switch().value - b.switch().value;
  if (tagDiff !== 0) return tagDiff;
  const name = a.switch().name;
  if (INTEGER_SCV.has(name)) {
    return sign(BigInt(scValToNative(a) as bigint | number) - BigInt(scValToNative(b) as bigint | number));
  }
  switch (name) {
    case "scvBool":
      return Number(a.b()) - Number(b.b());
    case "scvVoid":
      return 0;
    case "scvBytes":
      return compareBytes(a.bytes(), b.bytes());
    case "scvString":
      return compareBytes(Buffer.from(a.str()), Buffer.from(b.str()));
    case "scvSymbol":
      return compareBytes(Buffer.from(a.sym()), Buffer.from(b.sym()));
    case "scvVec": {
      const av = a.vec() ?? [];
      const bv = b.vec() ?? [];
      for (let i = 0; i < Math.min(av.length, bv.length); i++) {
        const d = compareScVal(av[i] as xdr.ScVal, bv[i] as xdr.ScVal);
        if (d !== 0) return d;
      }
      return av.length - bv.length;
    }
    case "scvMap": {
      const am = a.map() ?? [];
      const bm = b.map() ?? [];
      for (let i = 0; i < Math.min(am.length, bm.length); i++) {
        const ea = am[i] as xdr.ScMapEntry;
        const eb = bm[i] as xdr.ScMapEntry;
        const d = compareScVal(ea.key(), eb.key()) || compareScVal(ea.val(), eb.val());
        if (d !== 0) return d;
      }
      return am.length - bm.length;
    }
    default:
      // scvAddress: XDR is discriminant + fixed-length key, so bytewise order
      // matches the host's derived ordering.
      return compareBytes(a.toXDR(), b.toXDR());
  }
}

function validateDescriptor(type: SorobanArgType, path: string): void {
  if (typeof type === "string") {
    if (!(type in INTEGER_BOUNDS) && !["bool", "void", "string", "symbol", "bytes", "address"].includes(type)) {
      fail(path, `unsupported Soroban type "${type}"`);
    }
    return;
  }
  if (typeof type !== "object" || type === null) fail(path, "type must be a type name or descriptor");
  switch (type.type) {
    case "bytesN":
      if (!Number.isInteger(type.length) || type.length < 1 || type.length > 2 ** 32 - 1) {
        fail(path, `bytesN length must be an integer between 1 and 2^32-1, got ${type.length}`);
      }
      return;
    case "vec":
      return validateDescriptor(type.element, path);
    case "map":
      validateDescriptor(type.key, path);
      return validateDescriptor(type.value, path);
    case "option":
      return validateDescriptor(type.inner, path);
    case "tuple":
      if (!Array.isArray(type.elements)) fail(path, "tuple requires an elements array");
      type.elements.forEach((t) => validateDescriptor(t, path));
      return;
    default:
      fail(path, `unsupported Soroban type descriptor "${(type as { type?: unknown }).type}"`);
  }
}

function encodeValue(value: unknown, type: SorobanArgType, path: string): xdr.ScVal {
  if (typeof type === "string") {
    if (type in INTEGER_BOUNDS) {
      const bounds = INTEGER_BOUNDS[type as SorobanIntegerType];
      const n = toBigIntStrict(value, path, type);
      if (n < bounds.min || n > bounds.max) {
        fail(path, `${n} is out of range for ${type} [${bounds.min}, ${bounds.max}]`);
      }
      switch (type) {
        case "u32":
          return xdr.ScVal.scvU32(Number(n));
        case "i32":
          return xdr.ScVal.scvI32(Number(n));
        // nativeToScVal does not know these two u64 aliases.
        case "timepoint":
          return xdr.ScVal.scvTimepoint(xdr.Uint64.fromString(n.toString()));
        case "duration":
          return xdr.ScVal.scvDuration(xdr.Uint64.fromString(n.toString()));
        default:
          return nativeToScVal(n, { type: bounds.scvType });
      }
    }

    switch (type) {
      case "bool":
        if (typeof value !== "boolean") fail(path, `bool requires a boolean, got ${describe(value)}`);
        return xdr.ScVal.scvBool(value);
      case "void":
        if (value !== null && value !== undefined) fail(path, `void requires null or undefined, got ${describe(value)}`);
        return xdr.ScVal.scvVoid();
      case "string":
        if (typeof value !== "string") fail(path, `string requires a string, got ${describe(value)}`);
        return xdr.ScVal.scvString(value);
      case "symbol":
        if (typeof value !== "string") fail(path, `symbol requires a string, got ${describe(value)}`);
        if (!SYMBOL_RE.test(value)) {
          fail(path, `symbol must be at most 32 characters of [A-Za-z0-9_], got "${value}"`);
        }
        return xdr.ScVal.scvSymbol(value);
      case "bytes":
        return xdr.ScVal.scvBytes(Buffer.from(toBytes(value, path, "bytes")));
      case "address": {
        if (typeof value !== "string") fail(path, `address requires a G… or C… strkey string, got ${describe(value)}`);
        if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
          fail(path, `"${value}" is not a valid account (G…) or contract (C…) address`);
        }
        return new Address(value).toScVal();
      }
    }
  }

  const descriptor = type as Exclude<SorobanArgType, string>;
  switch (descriptor.type) {
    case "bytesN": {
      const bytes = toBytes(value, path, typeName(descriptor));
      if (bytes.length !== descriptor.length) {
        fail(path, `${typeName(descriptor)} requires exactly ${descriptor.length} bytes, got ${bytes.length}`);
      }
      return xdr.ScVal.scvBytes(Buffer.from(bytes));
    }
    case "vec": {
      if (!Array.isArray(value)) fail(path, `${typeName(descriptor)} requires an array, got ${describe(value)}`);
      return xdr.ScVal.scvVec(value.map((item, i) => encodeValue(item, descriptor.element, `${path}[${i}]`)));
    }
    case "tuple": {
      if (!Array.isArray(value)) fail(path, `${typeName(descriptor)} requires an array, got ${describe(value)}`);
      if (value.length !== descriptor.elements.length) {
        fail(path, `${typeName(descriptor)} requires ${descriptor.elements.length} items, got ${value.length}`);
      }
      return xdr.ScVal.scvVec(
        descriptor.elements.map((t, i) => encodeValue(value[i], t, `${path}[${i}]`)),
      );
    }
    case "option":
      return value === null || value === undefined
        ? xdr.ScVal.scvVoid()
        : encodeValue(value, descriptor.inner, path);
    case "map": {
      const entries = mapEntries(value, path).map(([k, v]) => {
        const label = `${path}[${typeof k === "string" ? JSON.stringify(k) : String(k)}]`;
        return {
          key: encodeValue(k, descriptor.key, `${label}.key`),
          val: encodeValue(v, descriptor.value, label),
        };
      });
      // The Soroban host rejects maps whose keys are not strictly ascending in
      // ScVal order, so sort here and refuse duplicates.
      entries.sort((a, b) => compareScVal(a.key, b.key));
      for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1] as { key: xdr.ScVal };
        const cur = entries[i] as { key: xdr.ScVal };
        if (compareScVal(prev.key, cur.key) === 0) fail(path, "map contains duplicate keys");
      }
      return xdr.ScVal.scvMap(entries.map((e) => new xdr.ScMapEntry({ key: e.key, val: e.val })));
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate `value` against a Soroban type and encode it as an `xdr.ScVal`.
 *
 * @param value - JS value to encode (see the module table for accepted shapes).
 * @param type  - Soroban type name (e.g. `"i128"`) or descriptor (e.g. `{ type: "vec", element: "address" }`).
 * @param path  - Label used in error messages. Defaults to `"value"`.
 * @returns `ok(xdr.ScVal)` or a `VALIDATION` error. Never throws.
 *
 * @example
 * const amount = encodeArg("1000000000", "i128");
 * const to = encodeArg("GD…", "address");
 * const hash = encodeArg(hashBytes, { type: "bytesN", length: 32 });
 * if (amount.status === "ok") contract.call("transfer", amount.data);
 */
export function encodeArg(
  value: unknown,
  type: SorobanArgType,
  path = "value",
): SorokitResult<xdr.ScVal> {
  try {
    validateDescriptor(type, path);
    return ok(encodeValue(value, type, path));
  } catch (cause) {
    if (cause instanceof EncodeError) {
      return err(SorokitErrorCode.VALIDATION, `encodeArg ${cause.message}`, cause);
    }
    return err(
      SorokitErrorCode.VALIDATION,
      `encodeArg ${path}: failed to encode as ${typeof type === "object" && type !== null ? typeName(type) : String(type)}: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

/**
 * Encode a positional argument list. Stops at the first invalid argument and
 * reports it as `args[i]`.
 *
 * @example
 * const args = encodeArgs([
 *   { value: from, type: "address" },
 *   { value: to, type: "address" },
 *   { value: 50_0000000n, type: "i128" },
 * ]);
 */
export function encodeArgs(args: SorobanArgSpec[]): SorokitResult<xdr.ScVal[]> {
  if (!Array.isArray(args)) {
    return err(SorokitErrorCode.VALIDATION, "encodeArgs: args must be an array");
  }
  const out: xdr.ScVal[] = [];
  for (let i = 0; i < args.length; i++) {
    const spec = args[i] as SorobanArgSpec;
    const result = encodeArg(spec?.value, spec?.type, `args[${i}]`);
    if (result.status === "error") return result as unknown as SorokitResult<xdr.ScVal[]>;
    out.push(result.data);
  }
  return ok(out);
}
