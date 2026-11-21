import { describe, expect, it } from "vitest";
import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { encodeArg, encodeArgs, type SorobanArgType } from "./argumentEncoder";
import { SorokitErrorCode } from "../shared/response";

const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = Address.contract(Buffer.alloc(32, 7)).toString();

function okVal(value: unknown, type: SorobanArgType): xdr.ScVal {
  const result = encodeArg(value, type);
  if (result.status !== "ok") throw new Error(result.error.message);
  return result.data;
}

function errMsg(value: unknown, type: SorobanArgType): string {
  const result = encodeArg(value, type);
  expect(result.status).toBe("error");
  if (result.status !== "error") return "";
  expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
  return result.error.message;
}

describe("encodeArg — integers", () => {
  const cases: Array<[SorobanArgType, bigint, bigint, string]> = [
    ["u32", 0n, 2n ** 32n - 1n, "scvU32"],
    ["i32", -(2n ** 31n), 2n ** 31n - 1n, "scvI32"],
    ["u64", 0n, 2n ** 64n - 1n, "scvU64"],
    ["i64", -(2n ** 63n), 2n ** 63n - 1n, "scvI64"],
    ["u128", 0n, 2n ** 128n - 1n, "scvU128"],
    ["i128", -(2n ** 127n), 2n ** 127n - 1n, "scvI128"],
    ["u256", 0n, 2n ** 256n - 1n, "scvU256"],
    ["i256", -(2n ** 255n), 2n ** 255n - 1n, "scvI256"],
    ["timepoint", 0n, 2n ** 64n - 1n, "scvTimepoint"],
    ["duration", 0n, 2n ** 64n - 1n, "scvDuration"],
  ];

  it.each(cases)("%s encodes both bounds and rejects one past each", (type, min, max, scv) => {
    const lo = okVal(min, type);
    const hi = okVal(max, type);
    expect(lo.switch().name).toBe(scv);
    expect(BigInt(scValToNative(lo))).toBe(min);
    expect(BigInt(scValToNative(hi))).toBe(max);
    expect(errMsg(min - 1n, type)).toContain("out of range");
    expect(errMsg(max + 1n, type)).toContain("out of range");
  });

  it("accepts safe numbers and decimal strings", () => {
    expect(okVal(42, "u32").u32()).toBe(42);
    expect(okVal(-7, "i32").i32()).toBe(-7);
    expect(scValToNative(okVal(" -1000000000000 ", "i128"))).toBe(-1000000000000n);
  });

  it("rejects non-integers, unsafe numbers and malformed strings", () => {
    expect(errMsg(1.5, "i128")).toContain("requires an integer");
    expect(errMsg(2 ** 60, "u64")).toContain("MAX_SAFE_INTEGER");
    expect(errMsg("1e5", "i128")).toContain("decimal integer string");
    expect(errMsg(true, "u32")).toContain("got boolean");
  });
});

describe("encodeArg — scalars", () => {
  it("bool and void", () => {
    expect(okVal(true, "bool").b()).toBe(true);
    expect(errMsg("true", "bool")).toContain("requires a boolean");
    expect(okVal(null, "void").switch().name).toBe("scvVoid");
    expect(okVal(undefined, "void").switch().name).toBe("scvVoid");
    expect(errMsg(0, "void")).toContain("null or undefined");
  });

  it("string allows any text, symbol enforces the Soroban symbol rules", () => {
    expect(scValToNative(okVal("héllo wörld", "string"))).toBe("héllo wörld");
    expect(okVal("transfer_v2", "symbol").switch().name).toBe("scvSymbol");
    expect(okVal("a".repeat(32), "symbol").sym().toString()).toHaveLength(32);
    expect(errMsg("a".repeat(33), "symbol")).toContain("at most 32");
    expect(errMsg("has space", "symbol")).toContain("[A-Za-z0-9_]");
    expect(errMsg(5, "string")).toContain("requires a string");
  });

  it("bytes accepts Uint8Array, Buffer and hex", () => {
    expect(Buffer.from(okVal(new Uint8Array([1, 2]), "bytes").bytes()).toString("hex")).toBe("0102");
    expect(Buffer.from(okVal(Buffer.from("ff00", "hex"), "bytes").bytes()).toString("hex")).toBe("ff00");
    expect(Buffer.from(okVal("0xdeadbeef", "bytes").bytes()).toString("hex")).toBe("deadbeef");
    expect(okVal("", "bytes").bytes()).toHaveLength(0);
    expect(errMsg("abc", "bytes")).toContain("even-length hex");
    expect(errMsg([1, 2], "bytes")).toContain("got array");
  });

  it("bytesN enforces the exact length", () => {
    const hash = new Uint8Array(32).fill(9);
    expect(okVal(hash, { type: "bytesN", length: 32 }).bytes()).toHaveLength(32);
    expect(errMsg(new Uint8Array(31), { type: "bytesN", length: 32 })).toContain("exactly 32 bytes, got 31");
    expect(errMsg(hash, { type: "bytesN", length: 0 })).toContain("bytesN length");
  });

  it("address accepts account and contract strkeys only", () => {
    expect(scValToNative(okVal(ACCOUNT, "address"))).toBe(ACCOUNT);
    expect(scValToNative(okVal(CONTRACT, "address"))).toBe(CONTRACT);
    expect(errMsg(ACCOUNT.slice(0, -1) + (ACCOUNT.endsWith("A") ? "B" : "A"), "address")).toContain("not a valid");
    expect(errMsg("SBAD", "address")).toContain("not a valid");
    expect(errMsg(123, "address")).toContain("strkey string");
  });
});

describe("encodeArg — compound types", () => {
  it("vec encodes each element and reports the failing index", () => {
    const v = okVal([1, 2, 3], { type: "vec", element: "u32" });
    expect(v.vec()!.map((x) => x.u32())).toEqual([1, 2, 3]);
    expect(errMsg([1, -2], { type: "vec", element: "u32" })).toContain("value[1]");
    expect(errMsg("x", { type: "vec", element: "u32" })).toContain("requires an array");
  });

  it("tuple requires exact length", () => {
    const t: SorobanArgType = { type: "tuple", elements: ["symbol", "i128"] };
    expect(scValToNative(okVal(["XLM", 5n], t))).toEqual(["XLM", 5n]);
    expect(errMsg(["XLM"], t)).toContain("requires 2 items");
  });

  it("option encodes void for null and the inner type otherwise", () => {
    const o: SorobanArgType = { type: "option", inner: "address" };
    expect(okVal(null, o).switch().name).toBe("scvVoid");
    expect(scValToNative(okVal(ACCOUNT, o))).toBe(ACCOUNT);
    expect(errMsg("nope", o)).toContain("not a valid");
  });

  it("map accepts objects, Maps and entry arrays, and sorts keys", () => {
    const m: SorobanArgType = { type: "map", key: "symbol", value: "u32" };
    const scv = okVal({ zeta: 1, alpha: 2 }, m);
    expect(scv.map()!.map((e) => e.key().sym().toString())).toEqual(["alpha", "zeta"]);
    expect(okVal(new Map([["b", 1]]), m).map()![0]!.key().sym().toString()).toBe("b");
    expect(okVal([["c", 3]], m).map()![0]!.val().u32()).toBe(3);
    expect(errMsg({ k: -1 }, m)).toContain('value["k"]');
    expect(errMsg([["a", 1], ["a", 2]], m)).toContain("duplicate keys");
    expect(errMsg(5, m)).toContain("map requires");
  });

  it("orders keys the way the Soroban host does (by value, not XDR length)", () => {
    const sym = okVal({ zeta: 1, alpha: 2, b: 3 }, { type: "map", key: "symbol", value: "u32" });
    expect(sym.map()!.map((e) => e.key().sym().toString())).toEqual(["alpha", "b", "zeta"]);
    const nums = okVal([[10n, 0], [-5n, 0], [2n, 0]], { type: "map", key: "i128", value: "u32" });
    expect(nums.map()!.map((e) => BigInt(scValToNative(e.key())))).toEqual([-5n, 2n, 10n]);
  });

  it("nests arbitrarily", () => {
    const t: SorobanArgType = {
      type: "vec",
      element: { type: "map", key: "address", value: { type: "option", inner: "i128" } },
    };
    const v = okVal([{ [ACCOUNT]: "10" }, { [CONTRACT]: null }], t);
    expect(v.vec()).toHaveLength(2);
  });
});

describe("encodeArg — descriptor validation", () => {
  it("rejects unknown types before encoding", () => {
    expect(errMsg(1, "u512" as SorobanArgType)).toContain('unsupported Soroban type "u512"');
    expect(errMsg(1, { type: "set" } as unknown as SorobanArgType)).toContain("unsupported Soroban type descriptor");
    expect(errMsg([1], { type: "vec", element: "float" as SorobanArgType })).toContain('"float"');
  });

  it("uses the caller-supplied path in messages", () => {
    const r = encodeArg(-1, "u32", "amount");
    expect(r.status === "error" && r.error.message).toContain("amount:");
  });
});

describe("encodeArgs", () => {
  it("encodes a positional list", () => {
    const r = encodeArgs([
      { value: ACCOUNT, type: "address" },
      { value: CONTRACT, type: "address" },
      { value: 50_0000000n, type: "i128" },
    ]);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.data.map((v) => v.switch().name)).toEqual(["scvAddress", "scvAddress", "scvI128"]);
  });

  it("stops at the first invalid argument", () => {
    const r = encodeArgs([
      { value: ACCOUNT, type: "address" },
      { value: "x", type: "i128" },
    ]);
    expect(r.status === "error" && r.error.message).toContain("args[1]");
    expect(encodeArgs("nope" as never).status).toBe("error");
  });
});
