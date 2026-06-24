import { describe, it, expect } from "vitest";
import {
  formatAddress,
  isBrowser,
  isValidPublicKey,
  isValidContractId,
  toMessage,
  isNotFoundError,
  isUserRejection,
} from "../shared";

describe("shared/utils", () => {
  describe("formatAddress", () => {
    const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    it("shortens a full public key", () => {
      const formatted = formatAddress(key);
      expect(formatted).toContain("...");
      expect(formatted.length).toBeLessThan(key.length);
    });

    it("returns the key unchanged if already short", () => {
      expect(formatAddress("GABCD")).toBe("GABCD");
    });

    it("respects custom char count", () => {
      const formatted = formatAddress(key, 6);
      const [prefix, suffix] = formatted.split("...");
      expect(prefix?.length).toBe(7);
      expect(suffix?.length).toBe(6);
    });
  });

  describe("isBrowser", () => {
    it("returns false in Node environment", () => {
      expect(isBrowser()).toBe(false);
    });
  });

  describe("isValidPublicKey", () => {
    // A known-valid Stellar public key (from Stellar's own test suite)
    const VALID_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

    it("accepts a valid 56-char Stellar public key", () => {
      expect(isValidPublicKey(VALID_KEY)).toBe(true);
    });

    it("rejects a key not starting with G", () => {
      // S... is a secret key — different version byte
      expect(
        isValidPublicKey(
          "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    it("rejects a key that is too short", () => {
      expect(isValidPublicKey("GABCD")).toBe(false);
    });

    it("rejects a key that is too long", () => {
      expect(isValidPublicKey(VALID_KEY + "A")).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(isValidPublicKey("")).toBe(false);
    });

    it("rejects null", () => {
      expect(isValidPublicKey(null as unknown as string)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isValidPublicKey(undefined as unknown as string)).toBe(false);
    });

    it("rejects a number", () => {
      expect(isValidPublicKey(12345 as unknown as string)).toBe(false);
    });

    it("rejects a key with invalid base32 characters (lowercase)", () => {
      // lowercase letters are not valid base32 in Stellar encoding
      expect(
        isValidPublicKey(
          "gaazi4tcr3ty5ojhctjc2a4qsy6cjwjh5iajtgkin2er7lbnvkoccwna",
        ),
      ).toBe(false);
    });

    it("rejects a key with invalid characters (0, 1, 8, 9)", () => {
      // base32 uses A-Z and 2-7 only; 0/1/8/9 are invalid
      expect(
        isValidPublicKey(
          "G0AZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    it("rejects a valid-format key with a corrupted checksum", () => {
      // Flip the last character to break the CRC-16 checksum
      const corrupted =
        VALID_KEY.slice(0, -1) + (VALID_KEY.endsWith("A") ? "B" : "A");
      expect(isValidPublicKey(corrupted)).toBe(false);
    });

    it("rejects a whitespace-only string", () => {
      expect(isValidPublicKey("   ")).toBe(false);
    });

    it("rejects a key with leading/trailing whitespace", () => {
      expect(isValidPublicKey(" " + VALID_KEY)).toBe(false);
      expect(isValidPublicKey(VALID_KEY + " ")).toBe(false);
    });

    it("rejects a contract ID (C...) as a public key", () => {
      expect(
        isValidPublicKey(
          "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });
  });

  describe("isValidContractId", () => {
    it("accepts a valid 56-char contract ID", () => {
      expect(
        isValidContractId(
          "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("rejects an ID not starting with C", () => {
      expect(
        isValidContractId(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });
  });
});

describe("shared/errors", () => {
  describe("toMessage", () => {
    it("extracts message from Error", () => {
      expect(toMessage(new Error("boom"))).toBe("boom");
    });

    it("returns string as-is", () => {
      expect(toMessage("raw string")).toBe("raw string");
    });

    it("stringifies objects", () => {
      expect(toMessage({ code: 42 })).toBe('{"code":42}');
    });
  });

  describe("isNotFoundError", () => {
    it("detects 404 in error message", () => {
      expect(isNotFoundError(new Error("Request failed with status 404"))).toBe(
        true,
      );
    });

    it('detects "not found" in error message', () => {
      expect(isNotFoundError(new Error("account not found"))).toBe(true);
    });

    it("returns false for non-404 errors", () => {
      expect(isNotFoundError(new Error("network timeout"))).toBe(false);
    });

    it("detects 404 via response.status object", () => {
      expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    });
  });

  describe("isUserRejection", () => {
    it('detects "reject"', () => {
      expect(isUserRejection(new Error("User rejected the request"))).toBe(
        true,
      );
    });

    it('detects "cancel"', () => {
      expect(isUserRejection(new Error("Transaction cancelled"))).toBe(true);
    });

    it('detects "denied"', () => {
      expect(isUserRejection(new Error("Access denied"))).toBe(true);
    });

    it("returns false for non-rejection errors", () => {
      expect(isUserRejection(new Error("Network error"))).toBe(false);
    });
  });
});
