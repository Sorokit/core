import { xdr } from "@stellar/stellar-sdk";
import { decodeContractValue } from "./contractEncoding";
import type { ContractResultType, ParsedContractResult } from "./types";

const TYPE_TO_SCV_NAME: Record<string, string> = {
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
  void: "scvVoid",
  vec: "scvVec",
  map: "scvMap",
  address: "scvAddress",
};

const SCV_NAME_TO_TYPE: Record<string, string> = {
  scvBool: "bool",
  scvU32: "u32",
  scvI32: "i32",
  scvU64: "u64",
  scvI64: "i64",
  scvU128: "u128",
  scvI128: "i128",
  scvString: "string",
  scvSymbol: "symbol",
  scvBytes: "bytes",
  scvVoid: "void",
  scvVec: "vec",
  scvMap: "map",
  scvAddress: "address",
};

export function parseContractResult(
  scVal: xdr.ScVal,
  expectedType?: ContractResultType,
): ParsedContractResult {
  const actualScvName: string = scVal.switch().name;
  const resolvedType = SCV_NAME_TO_TYPE[actualScvName] ?? actualScvName;

  if (expectedType !== undefined) {
    const expectedScvName = TYPE_TO_SCV_NAME[expectedType];
    if (expectedScvName === undefined || actualScvName !== expectedScvName) {
      throw new TypeError(
        `parseContractResult: expected type "${expectedType}" but got "${resolvedType}"`,
      );
    }
  }

  return {
    type: expectedType ?? resolvedType,
    value: decodeContractValue(scVal),
  };
}
