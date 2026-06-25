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
    // Valid keys
    it("accepts a well-known valid Stellar public key", () => {
      expect(
        isValidPublicKey(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(true);
    });

    it("accepts another well-known valid key", () => {
      expect(
        isValidPublicKey(
          "GBVVJJNTRPJBXQFVNGRAOQFZUEFIVNVYJQWVBLNC5QYIBZYYB7NIUC3Y",
        ),
      ).toBe(true);
    });

    // Wrong prefix
    it("rejects a secret key starting with S", () => {
      expect(
        isValidPublicKey(
          "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    it("rejects a contract ID starting with C", () => {
      expect(
        isValidPublicKey(
          "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    // Wrong length
    it("rejects a key that is too short", () => {
      expect(isValidPublicKey("GABCD")).toBe(false);
    });

    it("rejects a key that is one character too short (55 chars)", () => {
      expect(
        isValidPublicKey("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"),
      ).toBe(false);
    });

    it("rejects a key that is one character too long (57 chars)", () => {
      expect(
        isValidPublicKey(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNAA",
        ),
      ).toBe(false);
    });

    // Invalid characters
    it("rejects a key containing invalid base32 characters (lowercase)", () => {
      expect(
        isValidPublicKey(
          "gaazi4tcr3ty5ojhctjc2a4qsy6cjwjh5iajtgkin2er7lbnvkoccwna",
        ),
      ).toBe(false);
    });

    it("rejects a key containing a digit 1 (not valid base32)", () => {
      // Replace a valid char with '1' which is not in the base32 alphabet
      expect(
        isValidPublicKey(
          "G1AZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
        ),
      ).toBe(false);
    });

    // Edge cases — falsy / wrong type inputs
    it("rejects an empty string", () => {
      expect(isValidPublicKey("")).toBe(false);
    });

    it("rejects null", () => {
      // Cast to test runtime safety; function accepts unknown internally
      expect(isValidPublicKey(null as unknown as string)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isValidPublicKey(undefined as unknown as string)).toBe(false);
    });

    it("rejects a number", () => {
      expect(isValidPublicKey(12345 as unknown as string)).toBe(false);
    });

    it("rejects a plain object", () => {
      expect(isValidPublicKey({} as unknown as string)).toBe(false);
    });

    // Valid format but invalid checksum
    it("rejects a key with a valid format but corrupted checksum (last char changed)", () => {
      // GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA is valid;
      // changing the last character invalidates the CRC-16 checksum.
      expect(
        isValidPublicKey(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNB",
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
