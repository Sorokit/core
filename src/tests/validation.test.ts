/**
 * Tests for src/shared/validation.ts — centralised input validators.
 *
 * Coverage requirements per ticket TASK 4:
 *   - Each of the 5 validators: valid inputs, invalid formats, and all specified edge cases.
 *   - Every validator must return SorokitResult and never throw on any input.
 *
 * The "never throw" contract is explicitly tested for each validator: every
 * call is wrapped in a try/catch and the catch block is asserted unreachable.
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateStellarAddress,
  validatePublicKey,
  validatePublicKeyDetailed,
  detectPublicKeyFormat,
  verifyPublicKeyChecksum,
  validateAssetCode,
  validateAssetIssuer,
  validateAmount,
  STELLAR_MAX_AMOUNT,
  STELLAR_MAX_DECIMAL_PLACES,
  STELLAR_MAX_ASSET_CODE_LENGTH,
  STELLAR_MIN_ASSET_CODE_LENGTH,
} from "../shared/validation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A known-valid Stellar public key for reuse across tests. */
const VALID_KEY = Keypair.random().publicKey();
/** A second valid key, distinct from VALID_KEY. */
const VALID_KEY_2 = Keypair.random().publicKey();

/**
 * Build a tampered copy of a valid key by changing one character in the middle
 * (not the prefix, so it still starts with G). This produces a key that passes
 * the prefix check but fails the StrKey checksum.
 */
function corruptChecksum(key: string): string {
  const mid = Math.floor(key.length / 2);
  const replacement = key[mid] === "A" ? "B" : "A";
  return key.slice(0, mid) + replacement + key.slice(mid + 1);
}

// ─── validateStellarAddress ────────────────────────────────────────────────────

describe("validateStellarAddress", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts a valid G-prefixed 56-char Ed25519 public key", () => {
    const result = validateStellarAddress(VALID_KEY);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe(VALID_KEY);
      expect(result.error).toBeNull();
    }
  });

  it("accepts a second independently-generated valid key", () => {
    const result = validateStellarAddress(VALID_KEY_2);
    expect(result.status).toBe("ok");
  });

  // ── Invalid format ──────────────────────────────────────────────────────────

  it("rejects an empty string", () => {
    const result = validateStellarAddress("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.data).toBeNull();
      expect(result.error.message).toBeTruthy();
      expect(result.error.code).toBe("INVALID_ADDRESS");
    }
  });

  it("rejects an S-prefixed secret key (wrong prefix)", () => {
    const secretKey = Keypair.random().secret();
    const result = validateStellarAddress(secretKey);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("G");
    }
  });

  it("rejects a C-prefixed contract ID (wrong prefix)", () => {
    const contractId = "C" + "A".repeat(55);
    const result = validateStellarAddress(contractId);
    expect(result.status).toBe("error");
  });

  it("rejects a key with a valid prefix but corrupted checksum", () => {
    const corrupted = corruptChecksum(VALID_KEY);
    const result = validateStellarAddress(corrupted);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toBeTruthy();
    }
  });

  it("rejects a key that is too short (55 chars starting with G)", () => {
    const short = "G" + "A".repeat(54);
    const result = validateStellarAddress(short);
    expect(result.status).toBe("error");
  });

  it("rejects a key that is too long (57 chars starting with G)", () => {
    const long = "G" + "A".repeat(56);
    const result = validateStellarAddress(long);
    expect(result.status).toBe("error");
  });

  it("rejects a purely numeric string", () => {
    expect(validateStellarAddress("1234567890")).toMatchObject({ status: "error" });
  });

  it("rejects garbage/random bytes string", () => {
    expect(validateStellarAddress("not-a-stellar-address!@#$")).toMatchObject({ status: "error" });
  });

  // ── Error messages are actionable ───────────────────────────────────────────

  it("error message for wrong prefix names the problem and suggests a fix", () => {
    const result = validateStellarAddress("Sfake");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message.toLowerCase()).toMatch(/fix:/i);
    }
  });

  it("error message for empty input names the problem and suggests a fix", () => {
    const result = validateStellarAddress("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message.toLowerCase()).toMatch(/fix:/i);
    }
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("never throws on any input — returns SorokitResult even for garbage", () => {
    const inputs: unknown[] = [
      "",
      null,
      undefined,
      123,
      {},
      [],
      "GABC",
      "G".repeat(200),
      "\x00\x01\x02",
      "   ",
    ];
    for (const input of inputs) {
      let threw = false;
      let result: ReturnType<typeof validateStellarAddress> | undefined;
      try {
        result = validateStellarAddress(input as string);
      } catch {
        threw = true;
      }
      expect(threw, `validateStellarAddress threw for input: ${JSON.stringify(input)}`).toBe(false);
      expect(result?.status === "ok" || result?.status === "error").toBe(true);
    }
  });
});

// ─── validatePublicKey ─────────────────────────────────────────────────────────

describe("validatePublicKey", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts a valid Ed25519 public key", () => {
    const result = validatePublicKey(VALID_KEY);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe(VALID_KEY);
      expect(result.error).toBeNull();
    }
  });

  // ── Invalid format ──────────────────────────────────────────────────────────

  it("rejects an empty string", () => {
    const result = validatePublicKey("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("INVALID_ADDRESS");
    }
  });

  it("rejects a secret key (S-prefix)", () => {
    const result = validatePublicKey(Keypair.random().secret());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/G/);
    }
  });

  it("rejects a key with corrupted checksum", () => {
    const result = validatePublicKey(corruptChecksum(VALID_KEY));
    expect(result.status).toBe("error");
  });

  it("rejects a key that is one character too short", () => {
    expect(validatePublicKey("G" + "A".repeat(54))).toMatchObject({ status: "error" });
  });

  it("rejects a key that is one character too long", () => {
    expect(validatePublicKey("G" + "A".repeat(56))).toMatchObject({ status: "error" });
  });

  it("rejects a C-prefix contract address", () => {
    expect(validatePublicKey("C" + "A".repeat(55))).toMatchObject({ status: "error" });
  });

  // ── Error messages ──────────────────────────────────────────────────────────

  it("error message contains 'Fix:' guidance for wrong prefix", () => {
    const result = validatePublicKey("Sxxxxxxx");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("never throws on any input — returns SorokitResult even for garbage", () => {
    const inputs: unknown[] = [
      "",
      null,
      undefined,
      42,
      true,
      {},
      "GABC",
      "S" + "A".repeat(55),
      "\n\t\r",
    ];
    for (const input of inputs) {
      let threw = false;
      let result: ReturnType<typeof validatePublicKey> | undefined;
      try {
        result = validatePublicKey(input as string);
      } catch {
        threw = true;
      }
      expect(threw, `validatePublicKey threw for input: ${JSON.stringify(input)}`).toBe(false);
      expect(result?.status === "ok" || result?.status === "error").toBe(true);
    }
  });
});

// ─── validateAssetCode ─────────────────────────────────────────────────────────

describe("validateAssetCode", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts common 4-char asset codes like USDC", () => {
    expect(validateAssetCode("USDC")).toMatchObject({ status: "ok", data: "USDC" });
  });

  it("accepts XLM (native asset code)", () => {
    expect(validateAssetCode("XLM")).toMatchObject({ status: "ok", data: "XLM" });
  });

  it("accepts lowercase letters (a-z are alphanumeric)", () => {
    expect(validateAssetCode("usdc")).toMatchObject({ status: "ok", data: "usdc" });
  });

  it("accepts digits in asset code", () => {
    expect(validateAssetCode("TOKEN1")).toMatchObject({ status: "ok" });
  });

  // ── Edge cases — length boundaries ─────────────────────────────────────────

  it(`accepts exactly ${STELLAR_MIN_ASSET_CODE_LENGTH} character (minimum valid length)`, () => {
    const result = validateAssetCode("X");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("X");
  });

  it(`accepts exactly ${STELLAR_MAX_ASSET_CODE_LENGTH} characters (maximum valid length)`, () => {
    const code = "ABCDEFGHIJKL"; // 12 chars
    expect(code).toHaveLength(12);
    const result = validateAssetCode(code);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe(code);
  });

  it("rejects 0 characters (empty string)", () => {
    const result = validateAssetCode("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects 13 characters (one over the maximum)", () => {
    const code = "ABCDEFGHIJKLM"; // 13 chars
    expect(code).toHaveLength(13);
    const result = validateAssetCode(code);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("12");
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  // ── Edge cases — character set ──────────────────────────────────────────────

  it("rejects asset code with a hyphen", () => {
    const result = validateAssetCode("MY-TOKEN");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects asset code with an underscore", () => {
    expect(validateAssetCode("MY_TOKEN")).toMatchObject({ status: "error" });
  });

  it("rejects asset code with a space", () => {
    expect(validateAssetCode("MY TOKEN")).toMatchObject({ status: "error" });
  });

  it("rejects asset code with a dot", () => {
    expect(validateAssetCode("MY.TOKEN")).toMatchObject({ status: "error" });
  });

  it("rejects asset code with a special character", () => {
    expect(validateAssetCode("USD$")).toMatchObject({ status: "error" });
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("never throws on any input — returns SorokitResult even for garbage", () => {
    const inputs: unknown[] = [
      "",
      null,
      undefined,
      0,
      [],
      {},
      "A".repeat(100),
      "😀",
      "\0",
      "  ",
    ];
    for (const input of inputs) {
      let threw = false;
      let result: ReturnType<typeof validateAssetCode> | undefined;
      try {
        result = validateAssetCode(input as string);
      } catch {
        threw = true;
      }
      expect(threw, `validateAssetCode threw for input: ${JSON.stringify(input)}`).toBe(false);
      expect(result?.status === "ok" || result?.status === "error").toBe(true);
    }
  });
});

// ─── validateAssetIssuer ──────────────────────────────────────────────────────

describe("validateAssetIssuer", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts a valid G-prefixed 56-char issuer address", () => {
    const result = validateAssetIssuer(VALID_KEY);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe(VALID_KEY);
    }
  });

  // ── Invalid format ──────────────────────────────────────────────────────────

  it("rejects an empty string with an issuer-specific error message", () => {
    const result = validateAssetIssuer("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("INVALID_ADDRESS");
      expect(result.error.message).toContain("issuer");
    }
  });

  it("rejects an S-prefix secret key with an issuer-specific error message", () => {
    const result = validateAssetIssuer(Keypair.random().secret());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("issuer");
    }
  });

  it("rejects a key with corrupted checksum", () => {
    const result = validateAssetIssuer(corruptChecksum(VALID_KEY));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("issuer");
    }
  });

  it("rejects wrong-length address", () => {
    expect(validateAssetIssuer("G" + "A".repeat(20))).toMatchObject({ status: "error" });
  });

  it("rejects a non-G prefix address", () => {
    expect(validateAssetIssuer("TABCDE" + "A".repeat(50))).toMatchObject({ status: "error" });
  });

  // ── Error messages ──────────────────────────────────────────────────────────

  it("error message contains 'Fix:' guidance", () => {
    const result = validateAssetIssuer("bad-issuer");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("never throws on any input — returns SorokitResult even for garbage", () => {
    const inputs: unknown[] = [
      "",
      null,
      undefined,
      0,
      "random string",
      "G",
      "GGGG",
      "G".repeat(60),
      { key: "value" },
    ];
    for (const input of inputs) {
      let threw = false;
      let result: ReturnType<typeof validateAssetIssuer> | undefined;
      try {
        result = validateAssetIssuer(input as string);
      } catch {
        threw = true;
      }
      expect(threw, `validateAssetIssuer threw for input: ${JSON.stringify(input)}`).toBe(false);
      expect(result?.status === "ok" || result?.status === "error").toBe(true);
    }
  });
});

// ─── validateAmount ────────────────────────────────────────────────────────────

describe("validateAmount", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts a simple integer string", () => {
    const result = validateAmount("100");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("100");
  });

  it("accepts a decimal string", () => {
    expect(validateAmount("10.5")).toMatchObject({ status: "ok", data: "10.5" });
  });

  it("accepts a numeric (number type) input", () => {
    const result = validateAmount(42);
    expect(result.status).toBe("ok");
  });

  it("accepts the smallest positive Stellar amount — 0.0000001 (1 stroop)", () => {
    const result = validateAmount("0.0000001");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe("0.0000001");
  });

  it(`accepts exactly ${STELLAR_MAX_DECIMAL_PLACES} decimal places`, () => {
    // 7 decimal places is the maximum
    const result = validateAmount("1.1234567");
    expect(result.status).toBe("ok");
  });

  it("accepts the exact Stellar max amount boundary", () => {
    const result = validateAmount(STELLAR_MAX_AMOUNT);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toBe(STELLAR_MAX_AMOUNT);
  });

  // ── Edge cases — zero and negative ─────────────────────────────────────────

  it("rejects exactly 0 (zero)", () => {
    const result = validateAmount("0");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/zero|greater than zero/i);
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects 0 as a number type", () => {
    expect(validateAmount(0)).toMatchObject({ status: "error" });
  });

  it("rejects a negative amount string", () => {
    const result = validateAmount("-1");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects a negative amount number", () => {
    expect(validateAmount(-0.5)).toMatchObject({ status: "error" });
  });

  // ── Edge cases — decimal precision ─────────────────────────────────────────

  it("rejects 8 decimal places (one over the maximum)", () => {
    const result = validateAmount("1.12345678");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("8");
      expect(result.error.message).toContain("7");
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects 10 decimal places", () => {
    expect(validateAmount("1.1234567890")).toMatchObject({ status: "error" });
  });

  // ── Edge cases — max supply boundary ───────────────────────────────────────

  it("rejects an amount one stroop over the max supply", () => {
    // STELLAR_MAX_AMOUNT = 922337203685.4775807
    // One stroop over = 922337203685.4775808
    const result = validateAmount("922337203685.4775808");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain(STELLAR_MAX_AMOUNT);
      expect(result.error.message).toMatch(/Fix:/i);
    }
  });

  it("rejects a round number clearly over the max supply", () => {
    expect(validateAmount("1000000000000")).toMatchObject({ status: "error" });
  });

  // ── Edge cases — format ─────────────────────────────────────────────────────

  it("rejects an empty string", () => {
    const result = validateAmount("");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("rejects a non-numeric string", () => {
    expect(validateAmount("abc")).toMatchObject({ status: "error" });
  });

  it("rejects scientific notation (1e5)", () => {
    // The validator requires plain decimal notation
    const result = validateAmount("1e5");
    expect(result.status).toBe("error");
  });

  it("rejects Infinity string", () => {
    expect(validateAmount("Infinity")).toMatchObject({ status: "error" });
  });

  it("rejects NaN string", () => {
    expect(validateAmount("NaN")).toMatchObject({ status: "error" });
  });

  it("handles a numeric Infinity value", () => {
    // Number type: Infinity → String → "Infinity" → rejected
    expect(validateAmount(Infinity)).toMatchObject({ status: "error" });
  });

  it("handles a numeric NaN value", () => {
    expect(validateAmount(NaN)).toMatchObject({ status: "error" });
  });

  // ── Return type normalisation ───────────────────────────────────────────────

  it("returns the amount as a trimmed string in ok.data", () => {
    const result = validateAmount("  10.5  ");
    // Either trimmed ok, or error — both are acceptable (spaces produce format error
    // only if the regex rejects them after trim). Since trim happens before regex, ok.
    if (result.status === "ok") {
      expect(result.data).not.toMatch(/^\s|\s$/);
    }
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("never throws on any input — returns SorokitResult even for garbage", () => {
    const inputs: unknown[] = [
      "",
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      {},
      [],
      "abc",
      "1e10",
      "0x1F",
      "1.000000000",
      "-0",
      0,
      -1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
    ];
    for (const input of inputs) {
      let threw = false;
      let result: ReturnType<typeof validateAmount> | undefined;
      try {
        result = validateAmount(input as string | number);
      } catch {
        threw = true;
      }
      expect(threw, `validateAmount threw for input: ${JSON.stringify(input)}`).toBe(false);
      expect(result?.status === "ok" || result?.status === "error").toBe(true);
    }
  });
});

// ─── Cross-cutting: SorokitResult shape contract ─────────────────────────────

describe("SorokitResult shape — all validators", () => {
  it("ok results have status='ok', non-null data, and null error", () => {
    const results = [
      validateStellarAddress(VALID_KEY),
      validatePublicKey(VALID_KEY),
      validateAssetCode("USDC"),
      validateAssetIssuer(VALID_KEY),
      validateAmount("10"),
    ];
    for (const r of results) {
      expect(r.status).toBe("ok");
      expect(r.data).not.toBeNull();
      expect(r.error).toBeNull();
    }
  });

  it("error results have status='error', null data, and a non-null structured error", () => {
    const results = [
      validateStellarAddress("bad"),
      validatePublicKey("bad"),
      validateAssetCode(""),
      validateAssetIssuer("bad"),
      validateAmount("0"),
    ];
    for (const r of results) {
      expect(r.status).toBe("error");
      expect(r.data).toBeNull();
      expect(r.error).not.toBeNull();
      if (r.status === "error") {
        expect(typeof r.error.code).toBe("string");
        expect(typeof r.error.message).toBe("string");
        expect(r.error.message.length).toBeGreaterThan(0);
        expect(typeof r.error.category).toBe("string");
      }
    }
  });

  it("every error message contains 'Fix:' — messages are actionable", () => {
    const results = [
      validateStellarAddress("bad"),
      validatePublicKey(""),
      validateAssetCode(""),
      validateAssetIssuer("bad"),
      validateAmount("-5"),
    ];
    for (const r of results) {
      expect(r.status).toBe("error");
      if (r.status === "error") {
        expect(r.error.message).toMatch(/Fix:/i);
      }
    }
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("STELLAR_MAX_DECIMAL_PLACES is 7", () => {
    expect(STELLAR_MAX_DECIMAL_PLACES).toBe(7);
  });

  it("STELLAR_MAX_AMOUNT matches known Stellar protocol value", () => {
    expect(STELLAR_MAX_AMOUNT).toBe("922337203685.4775807");
  });

  it("STELLAR_MAX_ASSET_CODE_LENGTH is 12", () => {
    expect(STELLAR_MAX_ASSET_CODE_LENGTH).toBe(12);
  });

  it("STELLAR_MIN_ASSET_CODE_LENGTH is 1", () => {
    expect(STELLAR_MIN_ASSET_CODE_LENGTH).toBe(1);
  });

  it("detects public key formats (ed25519, muxed, federation) and verifies checksums (#926)", () => {
    expect(detectPublicKeyFormat(VALID_KEY)).toBe("ed25519");
    expect(detectPublicKeyFormat("alice*example.com")).toBe("federation");
    expect(detectPublicKeyFormat("M" + "A".repeat(68))).toBe("muxed");
    expect(detectPublicKeyFormat("invalid")).toBe("unknown");

    expect(verifyPublicKeyChecksum(VALID_KEY)).toBe(true);
    expect(verifyPublicKeyChecksum(corruptChecksum(VALID_KEY))).toBe(false);

    const ed25519Details = validatePublicKeyDetailed(VALID_KEY);
    expect(ed25519Details).toEqual({
      status: "ok",
      data: { key: VALID_KEY, format: "ed25519", checksumValid: true },
      error: null,
    });

    const fedDetails = validatePublicKeyDetailed("alice*stellar.org");
    expect(fedDetails).toEqual({
      status: "ok",
      data: { key: "alice*stellar.org", format: "federation", checksumValid: true },
      error: null,
    });

    const invalidChecksum = validatePublicKey(corruptChecksum(VALID_KEY));
    expect(invalidChecksum.status).toBe("error");
    if (invalidChecksum.status === "error") {
      expect(invalidChecksum.error.message).toContain("checksum");
    }
  });
});
