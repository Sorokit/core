/**
 * Contract value encoding / decoding helpers.
 *
 * decodeContractValue — maps xdr.ScVal → native JS value (extends scValToNative
 *   with explicit handling for u128/i128 and structured types).
 *
 * encodeContractArgs — maps JS values → xdr.ScVal[] based on a ContractMethod
 *   signature, with type validation.
 */

import { xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import type { ContractMethod } from "./types";

// ─── Decode ───────────────────────────────────────────────────────────────────

/**
 * Decode a Soroban ScVal into the closest native JS representation.
 *
 * Supported types:
 *   u32, i32         → number
 *   u64, i64         → bigint
 *   u128, i128       → bigint
 *   bool             → boolean
 *   string, symbol   → string
 *   bytes            → Uint8Array
 *   address          → string (strkey)
 *   map              → Record<string, unknown>
 *   vec              → unknown[]
 *   void             → undefined
 *   other            → delegates to scValToNative()
 *
 * @param scVal - The XDR ScVal to decode.
 * @returns The decoded native JS value.
 */
export function decodeContractValue(scVal: xdr.ScVal): unknown {
  const type = scVal.switch();

  switch (type) {
    case xdr.ScValType.scvBool():
      return scVal.b();

    case xdr.ScValType.scvU32():
      return scVal.u32();

    case xdr.ScValType.scvI32():
      return scVal.i32();

    case xdr.ScValType.scvU64(): {
      const parts = scVal.u64();
      return BigInt(parts.toString());
    }

    case xdr.ScValType.scvI64(): {
      const parts = scVal.i64();
      return BigInt(parts.toString());
    }

    case xdr.ScValType.scvU128(): {
      const parts = scVal.u128();
      return (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString());
    }

    case xdr.ScValType.scvI128(): {
      const parts = scVal.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const combined = (hi << 64n) | lo;
      // Two's complement for negative values
      const isNegative = (hi >> 63n) !== 0n;
      return isNegative ? combined - (1n << 128n) : combined;
    }

    case xdr.ScValType.scvString():
      return Buffer.from(scVal.str()).toString("utf8");

    case xdr.ScValType.scvSymbol():
      return scVal.sym().toString();

    case xdr.ScValType.scvBytes():
      return new Uint8Array(scVal.bytes());

    case xdr.ScValType.scvVoid():
      return undefined;

    case xdr.ScValType.scvVec(): {
      const vec = scVal.vec();
      if (!vec) return [];
      return vec.map(decodeContractValue);
    }

    case xdr.ScValType.scvMap(): {
      const map = scVal.map();
      if (!map) return {};
      const result: Record<string, unknown> = {};
      for (const entry of map) {
        const key = decodeContractValue(entry.key());
        result[String(key)] = decodeContractValue(entry.val());
      }
      return result;
    }

    default:
      // Delegate anything else (address, ledger key, etc.) to the SDK
      return scValToNative(scVal);
  }
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encode an array of JS values into xdr.ScVal[] based on a ContractMethod signature.
 *
 * Type mapping:
 *   u32                 ← number (non-negative integer ≤ 2^32-1)
 *   i32                 ← number (integer in [-2^31, 2^31-1])
 *   u64, i64            ← number | bigint
 *   u128, i128          ← number | bigint
 *   string, symbol      ← string
 *   bool                ← boolean
 *   bytes               ← Uint8Array | Buffer
 *   vec                 ← unknown[]
 *   map                 ← Record<string, unknown>
 *   address             ← string (G... or C... strkey)
 *   void                ← undefined | null
 *   (unrecognised type) ← passed through nativeToScVal()
 *
 * @param method    - ContractMethod with typed input definitions.
 * @param jsValues  - Array of JS values, aligned positionally with method.inputs.
 * @returns Array of xdr.ScVal ready to pass to prepareContractCall.
 * @throws {Error} when the number of values doesn't match or a value fails type validation.
 */
export function encodeContractArgs(
  method: ContractMethod,
  jsValues: unknown[],
): xdr.ScVal[] {
  const expected = method.inputs.length;
  const received = jsValues.length;

  if (received !== expected) {
    throw new Error(
      `encodeContractArgs: method "${method.name}" expects ${expected} argument(s) but received ${received}.`,
    );
  }

  return method.inputs.map((input, i) => {
    const value = jsValues[i];
    return encodeValue(input.type, value, `${method.name}[${i}] (${input.name})`);
  });
}

function encodeValue(type: string, value: unknown, label: string): xdr.ScVal {
  const normalizedType = type.toLowerCase().trim();

  switch (normalizedType) {
    case "bool":
      if (typeof value !== "boolean") {
        throw new TypeError(`${label}: expected boolean, got ${typeof value}`);
      }
      return xdr.ScVal.scvBool(value);

    case "u32": {
      const n = assertInteger(value, label);
      if (n < 0 || n > 0xffffffff) throw new RangeError(`${label}: u32 value out of range`);
      return xdr.ScVal.scvU32(n);
    }

    case "i32": {
      const n = assertInteger(value, label);
      if (n < -2147483648 || n > 2147483647) throw new RangeError(`${label}: i32 value out of range`);
      return xdr.ScVal.scvI32(n);
    }

    case "u64":
      return nativeToScVal(assertBigIntOrNumber(value, label), { type: "u64" });

    case "i64":
      return nativeToScVal(assertBigIntOrNumber(value, label), { type: "i64" });

    case "u128":
      return nativeToScVal(assertBigIntOrNumber(value, label), { type: "u128" });

    case "i128":
      return nativeToScVal(assertBigIntOrNumber(value, label), { type: "i128" });

    case "string":
      if (typeof value !== "string") {
        throw new TypeError(`${label}: expected string, got ${typeof value}`);
      }
      return xdr.ScVal.scvString(Buffer.from(value, "utf8"));

    case "symbol":
      if (typeof value !== "string") {
        throw new TypeError(`${label}: expected string (symbol), got ${typeof value}`);
      }
      return xdr.ScVal.scvSymbol(value);

    case "bytes":
      if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) {
        throw new TypeError(`${label}: expected Uint8Array or Buffer, got ${typeof value}`);
      }
      return xdr.ScVal.scvBytes(Buffer.from(value));

    case "address":
      if (typeof value !== "string") {
        throw new TypeError(`${label}: expected string address (G.../C...), got ${typeof value}`);
      }
      return nativeToScVal(value, { type: "address" });

    case "vec":
      if (!Array.isArray(value)) {
        throw new TypeError(`${label}: expected array (vec), got ${typeof value}`);
      }
      return xdr.ScVal.scvVec(value.map((item) => nativeToScVal(item)));

    case "map": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label}: expected object (map), got ${typeof value}`);
      }
      const entries = Object.entries(value as Record<string, unknown>).map(
        ([k, v]) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvString(Buffer.from(k, "utf8")),
            val: nativeToScVal(v),
          }),
      );
      return xdr.ScVal.scvMap(entries);
    }

    case "void":
      return xdr.ScVal.scvVoid();

    default:
      // Unknown type — best-effort via nativeToScVal
      return nativeToScVal(value);
  }
}

function assertInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`${label}: expected integer number or bigint, got ${typeof value}`);
}

function assertBigIntOrNumber(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  throw new TypeError(`${label}: expected number or bigint, got ${typeof value}`);
}
