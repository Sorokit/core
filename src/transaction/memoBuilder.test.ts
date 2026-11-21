import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  buildHashMemo,
  buildIdMemo,
  buildTextMemo,
  MEMO_HASH_BYTES,
  MEMO_ID_MAX,
  MEMO_TEXT_MAX_BYTES,
} from "./memoBuilder";
import type { BuiltMemo } from "./memoBuilder";
import * as transaction from "./index";
import * as sorokit from "../index";

const HASH_HEX = "ab".repeat(32);

function expectOk(result: SorokitResult<BuiltMemo>): BuiltMemo {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

function expectInvalid(result: SorokitResult<BuiltMemo>) {
  if (result.status !== "error") throw new Error("expected an error result");
  expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
  return result.error;
}

describe("memo size limits", () => {
  it("documents the limits as constants", () => {
    expect(MEMO_TEXT_MAX_BYTES).toBe(28);
    expect(MEMO_HASH_BYTES).toBe(32);
    expect(MEMO_ID_MAX).toBe(2n ** 64n - 1n);
  });
});

describe("buildTextMemo", () => {
  it("builds a text memo", () => {
    const memo = expectOk(buildTextMemo("invoice 42"));

    expect(memo.type).toBe("text");
    expect(memo.value).toBe("invoice 42");
  });

  it("allows an empty string and exactly 28 bytes", () => {
    expect(expectOk(buildTextMemo("")).type).toBe("text");
    expect(expectOk(buildTextMemo("a".repeat(28))).value).toBe("a".repeat(28));
  });

  it("rejects 29 bytes", () => {
    expect(expectInvalid(buildTextMemo("a".repeat(29))).message).toContain("28 bytes");
  });

  it("counts UTF-8 bytes, not characters", () => {
    // "é" is 2 bytes: 14 of them is 28 bytes, 15 is 30.
    expect(expectOk(buildTextMemo("é".repeat(14))).type).toBe("text");
    expectInvalid(buildTextMemo("é".repeat(15)));
    // An emoji is 4 bytes, so eight of them are 32 bytes.
    expectInvalid(buildTextMemo("😀".repeat(8)));
  });

  it.each([123, null, undefined, {}, ["a"]])("rejects the non-string %j", (value) => {
    expectInvalid(buildTextMemo(value as unknown as string));
  });
});

describe("buildIdMemo", () => {
  it.each([
    ["a digit string", "123", "123"],
    ["a number", 456, "456"],
    ["a bigint", 789n, "789"],
    ["zero", 0, "0"],
    ["the largest 64-bit id", "18446744073709551615", "18446744073709551615"],
    ["a bigint above 2^53", 2n ** 60n, (2n ** 60n).toString()],
  ])("accepts %s", (_name, input, expected) => {
    const memo = expectOk(buildIdMemo(input as string | number | bigint));

    expect(memo.type).toBe("id");
    expect(memo.value).toBe(expected);
  });

  it.each([
    ["one past the 64-bit maximum", "18446744073709551616"],
    ["a negative number", -1],
    ["a negative string", "-5"],
    ["a negative bigint", -1n],
    ["a fractional number", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number beyond 2^53", 2 ** 53],
    ["non-numeric text", "abc"],
    ["an empty string", ""],
    ["a padded string", " 12 "],
    ["a hex string", "0x10"],
    ["a decimal string", "1.5"],
  ])("rejects %s", (_name, input) => {
    expectInvalid(buildIdMemo(input as string | number | bigint));
  });

  it.each([null, undefined, {}, true])("rejects the non-numeric %j", (value) => {
    expectInvalid(buildIdMemo(value as unknown as string));
  });
});

describe("buildHashMemo", () => {
  it("accepts a 64-character hex string in either case", () => {
    expect(expectOk(buildHashMemo(HASH_HEX)).type).toBe("hash");
    expect(expectOk(buildHashMemo(HASH_HEX.toUpperCase())).type).toBe("hash");
  });

  it("accepts 32 bytes as a Buffer or Uint8Array and gives the same memo", () => {
    const fromHex = expectOk(buildHashMemo(HASH_HEX));
    const fromBuffer = expectOk(buildHashMemo(Buffer.from(HASH_HEX, "hex")));
    const fromBytes = expectOk(buildHashMemo(new Uint8Array(Buffer.from(HASH_HEX, "hex"))));

    expect(Buffer.from(fromBuffer.value as Buffer).toString("hex")).toBe(HASH_HEX);
    expect(Buffer.from(fromBytes.value as Buffer).toString("hex")).toBe(HASH_HEX);
    expect(Buffer.from(fromHex.value as Buffer).equals(Buffer.from(fromBuffer.value as Buffer))).toBe(true);
  });

  it.each([
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["not hex", "zz".repeat(32)],
    ["empty", ""],
    ["0x-prefixed", `0x${"ab".repeat(32)}`],
  ])("rejects a hex string that is %s", (_name, hash) => {
    expectInvalid(buildHashMemo(hash));
  });

  it("rejects the wrong number of bytes", () => {
    expectInvalid(buildHashMemo(Buffer.alloc(31)));
    expectInvalid(buildHashMemo(new Uint8Array(33)));
  });

  it.each([123, null, undefined, {}])("rejects the unsupported %j", (value) => {
    expectInvalid(buildHashMemo(value as unknown as string));
  });
});

describe("agreement with the throwing createXMemo helpers", () => {
  it("builds the same memos for valid input", () => {
    expect(expectOk(buildTextMemo("hello")).value).toBe(transaction.createTextMemo("hello").value);
    expect(expectOk(buildIdMemo("98765")).value).toBe(transaction.createIdMemo("98765").value);
    expect(expectOk(buildIdMemo(98765n)).value).toBe(transaction.createIdMemo(98765n).value);
    expect(Buffer.from(expectOk(buildHashMemo(HASH_HEX)).value as Buffer).toString("hex")).toBe(
      Buffer.from(transaction.createHashMemo(HASH_HEX).value as Buffer).toString("hex"),
    );
  });

  it("rejects what the throwing helpers throw on", () => {
    expect(() => transaction.createTextMemo("a".repeat(29))).toThrow();
    expectInvalid(buildTextMemo("a".repeat(29)));
    expect(() => transaction.createIdMemo("18446744073709551616")).toThrow();
    expectInvalid(buildIdMemo("18446744073709551616"));
    expect(() => transaction.createHashMemo("abcd")).toThrow();
    expectInvalid(buildHashMemo("abcd"));
  });

  it("never throws itself", () => {
    expect(() => buildTextMemo(undefined as unknown as string)).not.toThrow();
    expect(() => buildIdMemo(Symbol("x") as unknown as string)).not.toThrow();
    expect(() => buildHashMemo(null as unknown as string)).not.toThrow();
  });
});

describe("exports", () => {
  it("is exported from src/transaction/index.ts and src/index.ts", () => {
    expect(transaction.buildTextMemo).toBe(buildTextMemo);
    expect(transaction.buildIdMemo).toBe(buildIdMemo);
    expect(transaction.buildHashMemo).toBe(buildHashMemo);
    expect(sorokit.buildTextMemo).toBe(buildTextMemo);
    expect(sorokit.buildIdMemo).toBe(buildIdMemo);
    expect(sorokit.buildHashMemo).toBe(buildHashMemo);
  });
});
