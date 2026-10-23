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

  it("decodes the no-payload variant of an Option (#857)", () => {
    const noneValue = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("None")]);
    const result = decodeContractResult(noneValue, {
      type: "enum",
      variants: { Some: "i128", None: undefined },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toEqual({ type: "None" });
  });

  it("decodes both sides of a Result<Success, Failure> union with the discriminator intact (#857)", () => {
    const schema = {
      type: "enum" as const,
      variants: {
        Ok: { type: "struct" as const, fields: { amount: "i128" as const } },
        Err: "u32" as const,
      },
    };

    const okValue = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Ok"),
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount"),
          val: nativeToScVal(100n, { type: "i128" }),
        }),
      ]),
    ]);
    const okResult = decodeContractResult(okValue, schema);
    expect(okResult.status).toBe("ok");
    if (okResult.status === "ok") {
      expect(okResult.data).toEqual({ type: "Ok", value: { amount: 100n } });
    }

    const errValue = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Err"),
      xdr.ScVal.scvU32(4),
    ]);
    const errResult = decodeContractResult(errValue, schema);
    expect(errResult.status).toBe("ok");
    if (errResult.status === "ok") {
      expect(errResult.data).toEqual({ type: "Err", value: 4 });
    }

    // The two sides of the union decode to genuinely distinguishable shapes,
    // not a flattened/ambiguous result that loses which arm was returned.
    expect(okResult.status === "ok" && errResult.status === "ok").toBe(true);
  });

  it("rejects an unknown enum variant and a malformed enum vector rather than silently misdecoding (#857)", () => {
    const unknownVariant = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Pending")]);
    const unknownResult = decodeContractResult(unknownVariant, {
      type: "enum",
      variants: { Ok: undefined, Err: "u32" },
    });
    expect(unknownResult.status).toBe("error");

    const notAVec = nativeToScVal(5, { type: "u32" });
    const malformedResult = decodeContractResult(notAVec, {
      type: "enum",
      variants: { Ok: undefined, Err: "u32" },
    });
    expect(malformedResult.status).toBe("error");
  });

  it("creates reusable decoders and returns errors for mismatches", () => {
    const decoder = createDecoder("u32");
    expect(decoder(xdr.ScVal.scvU32(9)).status).toBe("ok");
    expect(decoder(xdr.ScVal.scvBool(true)).status).toBe("error");
    expect(decodeContractResult("not-xdr", "u32").status).toBe("error");
  });
});