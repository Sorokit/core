import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { createDecoder, decodeContractResult } from "./resultDecoder";

describe("contract result decoder", () => {
  it("decodes built-in and nested struct types", () => {
    const raw = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(42n, { type: "u128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: xdr.ScVal.scvBytes(Buffer.from([1, 2])) }),
    ]);
    const result = decodeContractResult(raw, { amount: "u128", recipient: "bytes" });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.amount).toBe(42n);
      expect(result.data.recipient).toEqual(Buffer.from([1, 2]));
    }
  });

  it("decodes enum payloads and custom types", () => {
    const custom = vi.fn((value: unknown) => ({ wrapped: value }));
    const enumValue = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Some"),
      nativeToScVal(7n, { type: "i128" }),
    ]);
    const result = decodeContractResult(enumValue, {
      type: "custom",
      decode: custom,
    });
    const enumResult = decodeContractResult(enumValue, {
      type: "enum",
      variants: { Some: "i128", None: undefined },
    });

    expect(result.status).toBe("ok");
    expect(custom).toHaveBeenCalledOnce();
    expect(enumResult.status).toBe("ok");
    if (enumResult.status === "ok") expect(enumResult.data).toEqual({ type: "Some", value: 7n });
  });

  it("creates reusable decoders and returns errors for mismatches", () => {
    const decoder = createDecoder("u32");
    expect(decoder(xdr.ScVal.scvU32(9)).status).toBe("ok");
    expect(decoder(xdr.ScVal.scvBool(true)).status).toBe("error");
    expect(decodeContractResult("not-xdr", "u32").status).toBe("error");
  });
});