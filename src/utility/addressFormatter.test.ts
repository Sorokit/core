import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import {
  ADDRESS_ELLIPSIS,
  DEFAULT_ADDRESS_VISIBLE_CHARS,
  shortenAddress,
} from "./addressFormatter";

const G_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const C_ADDRESS = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const M_ADDRESS =
  "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAAAK";

function unwrap(result: ReturnType<typeof shortenAddress>): string {
  if (result.status !== "ok") throw new Error(result.error.message);
  return result.data;
}

describe("shortenAddress", () => {
  it("keeps 4 characters at each end by default", () => {
    expect(DEFAULT_ADDRESS_VISIBLE_CHARS).toBe(4);
    expect(unwrap(shortenAddress(G_ADDRESS))).toBe("GBRP...OX2H");
  });

  it("shortens contract and muxed addresses the same way", () => {
    expect(unwrap(shortenAddress(C_ADDRESS))).toBe("CA3D...GAXE");
    expect(unwrap(shortenAddress(M_ADDRESS))).toBe("MA7Q...AAAK");
  });

  it("honours a custom character count", () => {
    expect(unwrap(shortenAddress(G_ADDRESS, 1))).toBe("G...H");
    expect(unwrap(shortenAddress(G_ADDRESS, 6))).toBe("GBRPYH...C7OX2H");
    expect(unwrap(shortenAddress(G_ADDRESS, 10))).toBe("GBRPYHIL2C...SW7QC7OX2H");
  });

  it("keeps head and tail of the original address", () => {
    const out = unwrap(shortenAddress(G_ADDRESS, 5));
    expect(out.startsWith(G_ADDRESS.slice(0, 5))).toBe(true);
    expect(out.endsWith(G_ADDRESS.slice(-5))).toBe(true);
    expect(out).toContain(ADDRESS_ELLIPSIS);
    expect(out.length).toBe(5 * 2 + ADDRESS_ELLIPSIS.length);
  });

  it("is shorter than the input for a real address", () => {
    expect(unwrap(shortenAddress(G_ADDRESS)).length).toBeLessThan(G_ADDRESS.length);
  });

  it("returns the address unchanged when shortening would not help", () => {
    expect(unwrap(shortenAddress("GABCDEFGHIJ", 4))).toBe("GABCDEFGHIJ"); // 11 = 2*4 + 3
    expect(unwrap(shortenAddress(G_ADDRESS, 28))).toBe(G_ADDRESS);
    expect(unwrap(shortenAddress(G_ADDRESS, 1000))).toBe(G_ADDRESS);
  });

  it("shortens as soon as the result is shorter than the input", () => {
    // 12 chars becomes 11 (4 + 3 + 4).
    expect(unwrap(shortenAddress("ABCDEFGHIJKL", 4))).toBe("ABCD...IJKL");
  });

  it("trims surrounding whitespace", () => {
    expect(unwrap(shortenAddress(`  ${G_ADDRESS}\n`))).toBe("GBRP...OX2H");
  });

  it("does not validate the address", () => {
    expect(unwrap(shortenAddress("not-a-stellar-address-at-all"))).toBe("not-...-all");
  });

  it("rejects an empty or non-string address", () => {
    for (const bad of ["", "   ", undefined as unknown as string, null as unknown as string, 42 as unknown as string]) {
      const result = shortenAddress(bad);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
      }
    }
  });

  it("rejects a non-positive or non-integer character count", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      const result = shortenAddress(G_ADDRESS, bad);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    }
  });

  it("gives distinct output for addresses that differ at the ends", () => {
    const a = unwrap(shortenAddress(G_ADDRESS));
    const b = unwrap(shortenAddress(G_ADDRESS.slice(0, -1) + "A"));
    expect(a).not.toBe(b);
  });
});
