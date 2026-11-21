import { describe, expect, it } from "vitest";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";
import {
  validateClaimableAmount,
  validateClaimableBalanceId,
  validateClaimantAddress,
  validateClaimPredicate,
  validateCreateClaimableBalanceParams,
  buildCreateClaimableBalanceOperation,
  buildClaimClaimableBalanceOperation,
  buildCreateClaimableBalance,
  buildClaimClaimableBalance,
} from "./claimableBalance";

describe("claimableBalance validators (#744)", () => {
  // ─── validateClaimableAmount ───────────────────────────────────────────────

  describe("validateClaimableAmount", () => {
    describe("valid amounts", () => {
      it.each([
        ["integer 1", "1"],
        ["integer 10", "10"],
        ["integer 100", "100"],
        ["integer 1000000", "1000000"],
        ["1 decimal place", "0.1"],
        ["1 decimal place on whole number", "15.5"],
        ["2 decimal places", "0.01"],
        ["2 decimal places currency style", "99.99"],
        ["3 decimal places", "0.001"],
        ["3 decimal places mixed", "1.234"],
        ["4 decimal places", "0.0001"],
        ["4 decimal places mixed", "123.4567"],
        ["5 decimal places", "0.00001"],
        ["5 decimal places mixed", "12.34567"],
        ["6 decimal places", "0.000001"],
        ["6 decimal places mixed", "999.999999"],
        ["7 decimal places (1 stroop)", "0.0000001"],
        ["7 decimal places max precision", "100.1234567"],
        ["large Stellar amount (INT64_MAX stroops)", "922337203685.4775807"],
      ])("accepts %s (%s)", (_, amount) => {
        const result = validateClaimableAmount(amount);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.data).toBeUndefined();
          expect(result.error).toBeNull();
        }
      });
    });

    describe("invalid amounts — non-string types", () => {
      it.each([
        ["null", null as unknown as string],
        ["undefined", undefined as unknown as string],
        ["number primitive", 100 as unknown as string],
        ["numeric zero", 0 as unknown as string],
        ["boolean true", true as unknown as string],
        ["boolean false", false as unknown as string],
        ["object", {} as unknown as string],
        ["array", ["10"] as unknown as string],
      ])("rejects non-string input: %s", (_, input) => {
        const result = validateClaimableAmount(input);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
          expect(result.error.message).toContain(
            "must be a positive decimal with at most 7 decimal places",
          );
        }
      });
    });

    describe("invalid amounts — format & precision violations (AMOUNT_PATTERN)", () => {
      it.each([
        ["empty string", ""],
        ["spaces only", "   "],
        ["leading whitespace", " 10"],
        ["trailing whitespace", "10 "],
        ["newline character", "10\n"],
        ["explicit positive sign", "+10"],
        ["explicit positive sign with decimal", "+1.5"],
        ["negative integer", "-1"],
        ["negative decimal", "-0.5"],
        ["negative minimum decimal", "-0.0000001"],
        ["alphabetic string", "abc"],
        ["alphanumeric amount with currency ticker", "10XLM"],
        ["alphanumeric with symbol", "10.0a"],
        ["hexadecimal string", "0x10"],
        ["scientific notation positive", "1e5"],
        ["scientific notation negative exponent", "1e-5"],
        ["scientific notation with decimal", "1.5e3"],
        ["8 decimal places (exceeds 7-decimal stroop limit)", "0.00000001"],
        ["8 decimal places on whole number", "1.12345678"],
        ["10 decimal places", "10.1234567890"],
        ["trailing decimal point without digits", "10."],
        ["trailing decimal point on zero", "0."],
        ["leading decimal point without integer part", ".5"],
        ["leading decimal point with 7 decimals", ".0000001"],
        ["multiple decimal points", "1.2.3"],
        ["consecutive decimal points", "1..0"],
        ["comma decimal separator", "10,5"],
        ["thousands comma separator", "1,000"],
        ["special string NaN", "NaN"],
        ["special string Infinity", "Infinity"],
        ["special string -Infinity", "-Infinity"],
      ])("rejects invalid pattern %s: %s", (_, amount) => {
        const result = validateClaimableAmount(amount);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
          expect(result.error.message).toContain(
            "must be a positive decimal with at most 7 decimal places",
          );
        }
      });
    });

    describe("invalid amounts — zero & non-positive values", () => {
      it.each([
        ["exact zero", "0"],
        ["zero with 1 decimal", "0.0"],
        ["zero with 2 decimals", "0.00"],
        ["zero with 7 decimals", "0.0000000"],
        ["multiple integer zeroes", "00"],
        ["multiple integer zeroes with decimals", "00.000"],
      ])("rejects zero amount %s: %s", (_, amount) => {
        const result = validateClaimableAmount(amount);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
          expect(result.error.message).toContain("must be greater than zero");
        }
      });

      it("rejects non-finite values (numeric overflow beyond IEEE 754 limit)", () => {
        const hugeAmount = "1" + "0".repeat(310);
        const result = validateClaimableAmount(hugeAmount);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
          expect(result.error.message).toContain("must be greater than zero");
        }
      });
    });
  });

  // ─── validateClaimableBalanceId ───────────────────────────────────────────

  describe("validateClaimableBalanceId", () => {
    describe("valid balance IDs", () => {
      it("accepts a standard 72-hex-character lowercase balance ID (8-byte discriminant + 32-byte hash)", () => {
        const validId = "00000000" + "abcdef0123456789".repeat(4);
        expect(validId.length).toBe(72);
        const result = validateClaimableBalanceId(validId);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.data).toBeUndefined();
          expect(result.error).toBeNull();
        }
      });

      it("accepts a standard 72-hex-character uppercase balance ID", () => {
        const validId = "00000000" + "ABCDEF0123456789".repeat(4);
        expect(validId.length).toBe(72);
        const result = validateClaimableBalanceId(validId);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.data).toBeUndefined();
        }
      });

      it("accepts a standard 72-hex-character mixed-case balance ID", () => {
        const validId = "00000000" + "AbCdEf0123456789".repeat(4);
        expect(validId.length).toBe(72);
        const result = validateClaimableBalanceId(validId);
        expect(result.status).toBe("ok");
      });

      it("accepts an all-zero 72-hex-character ID", () => {
        const validId = "0".repeat(72);
        expect(validId.length).toBe(72);
        const result = validateClaimableBalanceId(validId);
        expect(result.status).toBe("ok");
      });

      it("accepts an all-f 72-hex-character ID (lowercase and uppercase)", () => {
        expect(validateClaimableBalanceId("f".repeat(72)).status).toBe("ok");
        expect(validateClaimableBalanceId("F".repeat(72)).status).toBe("ok");
      });

      it("accepts multiple distinct realistic Stellar claimable balance IDs", () => {
        const sampleIds = [
          "00000000" + "12".repeat(32),
          "00000000" + "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          "00000001" + "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
        ];
        for (const id of sampleIds) {
          expect(id.length).toBe(72);
          const result = validateClaimableBalanceId(id);
          expect(result.status).toBe("ok");
        }
      });
    });

    describe("invalid balance IDs — non-string types", () => {
      it.each([
        ["null", null as unknown as string],
        ["undefined", undefined as unknown as string],
        ["number", 12345678 as unknown as string],
        ["boolean true", true as unknown as string],
        ["boolean false", false as unknown as string],
        ["object", {} as unknown as string],
        ["array", ["0".repeat(72)] as unknown as string],
      ])("rejects non-string input: %s", (_, input) => {
        const result = validateClaimableBalanceId(input);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
          expect(result.error.message).toContain(
            "must be a claimable balance id (72 hexadecimal characters: 8-byte discriminant + 32-byte hash)",
          );
        }
      });
    });

    describe("invalid balance IDs — length violations", () => {
      it("rejects empty string", () => {
        const result = validateClaimableBalanceId("");
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        }
      });

      it("rejects 71 hex characters (1 character too short)", () => {
        const shortId = "0".repeat(71);
        expect(shortId.length).toBe(71);
        const result = validateClaimableBalanceId(shortId);
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.message).toContain(shortId);
        }
      });

      it("rejects 73 hex characters (1 character too long)", () => {
        const longId = "0".repeat(73);
        expect(longId.length).toBe(73);
        const result = validateClaimableBalanceId(longId);
        expect(result.status).toBe("error");
      });

      it("rejects 8 hex characters (only the discriminant)", () => {
        const result = validateClaimableBalanceId("00000000");
        expect(result.status).toBe("error");
      });

      it("rejects 64 hex characters (only the 32-byte hash, missing discriminant)", () => {
        const result = validateClaimableBalanceId("a".repeat(64));
        expect(result.status).toBe("error");
      });
    });

    describe("invalid balance IDs — non-hex characters & format violations", () => {
      it("rejects balance ID prefixed with 0x (74 characters)", () => {
        const withPrefix = "0x" + "0".repeat(72);
        const result = validateClaimableBalanceId(withPrefix);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID prefixed with 0x (72 characters total)", () => {
        const withPrefix = "0x" + "0".repeat(70);
        const result = validateClaimableBalanceId(withPrefix);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID containing non-hex character 'g'", () => {
        const invalid = "0".repeat(71) + "g";
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID containing non-hex character 'G'", () => {
        const invalid = "G" + "0".repeat(71);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID containing non-hex character 'z'", () => {
        const invalid = "z".repeat(72);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID with spaces at the beginning", () => {
        const invalid = " " + "0".repeat(71);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID with spaces at the end", () => {
        const invalid = "0".repeat(71) + " ";
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID with internal spaces", () => {
        const invalid = "0".repeat(35) + " " + "0".repeat(36);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID with newline character", () => {
        const invalid = "0".repeat(71) + "\n";
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID containing punctuation or hyphens", () => {
        const invalid = "00000000" + "-".repeat(64);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });

      it("rejects balance ID containing special symbols", () => {
        const invalid = "00000000" + "@".repeat(64);
        const result = validateClaimableBalanceId(invalid);
        expect(result.status).toBe("error");
      });
    });
  });

  // ─── validateClaimantAddress ───────────────────────────────────────────────

  describe("validateClaimantAddress", () => {
    const validGAddress = Keypair.random().publicKey();

    it("accepts a valid Stellar G-address (ed25519 public key)", () => {
      const result = validateClaimantAddress(validGAddress);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(validGAddress);
      }
    });

    it("accepts a valid muxed M-address and decodes it to underlying G-address", () => {
      const rawEd25519 = Keypair.random().rawPublicKey();
      const muxedAddress = StrKey.encodeMed25519PublicKey(
        Buffer.concat([rawEd25519, Buffer.alloc(8, 1)]),
      );
      const expectedGAddress = StrKey.encodeEd25519PublicKey(rawEd25519);

      const result = validateClaimantAddress(muxedAddress);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(expectedGAddress);
      }
    });

    it("rejects empty string or non-string claimant", () => {
      expect(validateClaimantAddress("").status).toBe("error");
      expect(validateClaimantAddress(null as unknown as string).status).toBe("error");
      expect(validateClaimantAddress(undefined as unknown as string).status).toBe("error");
    });

    it("rejects invalid claimant address strings", () => {
      expect(validateClaimantAddress("invalid-address").status).toBe("error");
      expect(validateClaimantAddress("GINVALID").status).toBe("error");
    });
  });

  // ─── validateClaimPredicate ────────────────────────────────────────────────

  describe("validateClaimPredicate", () => {
    it("accepts unconditional predicate", () => {
      expect(validateClaimPredicate({ type: "unconditional" }).status).toBe("ok");
    });

    it("accepts beforeAbsoluteTime and afterAbsoluteTime with valid timestamps", () => {
      expect(
        validateClaimPredicate({
          type: "beforeAbsoluteTime",
          timestamp: "2000000000",
        }).status,
      ).toBe("ok");
      expect(
        validateClaimPredicate({
          type: "afterAbsoluteTime",
          timestamp: "1700000000",
        }).status,
      ).toBe("ok");
    });

    it("accepts beforeRelativeTime and afterRelativeTime with valid seconds", () => {
      expect(
        validateClaimPredicate({
          type: "beforeRelativeTime",
          seconds: "3600",
        }).status,
      ).toBe("ok");
      expect(
        validateClaimPredicate({
          type: "afterRelativeTime",
          seconds: "60",
        }).status,
      ).toBe("ok");
    });

    it("rejects predicate time values that are missing, negative, or exceed uint64 max", () => {
      expect(
        validateClaimPredicate({
          type: "beforeAbsoluteTime",
        } as unknown as { type: "beforeAbsoluteTime"; timestamp: string }).status,
      ).toBe("error");
      expect(
        validateClaimPredicate({
          type: "beforeAbsoluteTime",
          timestamp: "-1",
        }).status,
      ).toBe("error");
      expect(
        validateClaimPredicate({
          type: "beforeAbsoluteTime",
          timestamp: "not-a-number",
        }).status,
      ).toBe("error");
      expect(
        validateClaimPredicate({
          type: "beforeAbsoluteTime",
          timestamp: "18446744073709551616", // UINT64_MAX + 1
        }).status,
      ).toBe("error");
    });

    it("accepts compound and/or predicates with valid child predicates", () => {
      expect(
        validateClaimPredicate({
          type: "and",
          predicates: [
            { type: "afterRelativeTime", seconds: "60" },
            { type: "beforeRelativeTime", seconds: "120" },
          ],
        }).status,
      ).toBe("ok");
      expect(
        validateClaimPredicate({
          type: "or",
          predicates: [
            { type: "unconditional" },
            { type: "beforeRelativeTime", seconds: "300" },
          ],
        }).status,
      ).toBe("ok");
    });

    it("rejects compound and/or predicates with fewer than 2 child predicates", () => {
      expect(
        validateClaimPredicate({
          type: "and",
          predicates: [{ type: "unconditional" }],
        }).status,
      ).toBe("error");
      expect(
        validateClaimPredicate({
          type: "or",
          predicates: [],
        }).status,
      ).toBe("error");
    });

    it("rejects compound predicate when end <= start (inverted claim window)", () => {
      const inverted = validateClaimPredicate({
        type: "and",
        predicates: [
          { type: "afterRelativeTime", seconds: "200" },
          { type: "beforeRelativeTime", seconds: "100" },
        ],
      });
      expect(inverted.status).toBe("error");
      if (inverted.status === "error") {
        expect(inverted.error.message).toContain("end must be greater than start");
      }
    });

    it("accepts and validates not predicates", () => {
      expect(
        validateClaimPredicate({
          type: "not",
          predicate: { type: "beforeRelativeTime", seconds: "60" },
        }).status,
      ).toBe("ok");
      expect(
        validateClaimPredicate({
          type: "not",
        } as unknown as { type: "not"; predicate: { type: "unconditional" } }).status,
      ).toBe("error");
    });

    it("rejects null or unsupported predicate types", () => {
      expect(
        validateClaimPredicate(null as unknown as { type: "unconditional" }).status,
      ).toBe("error");
      expect(
        validateClaimPredicate({ type: "unsupported" } as unknown as {
          type: "unconditional";
        }).status,
      ).toBe("error");
    });
  });

  // ─── Operation Builders & Transactions ────────────────────────────────────

  describe("builders and params validation", () => {
    const claimant = Keypair.random().publicKey();
    const sourceKeypair = Keypair.random();
    const sourcePublicKey = sourceKeypair.publicKey();
    const network = {
      network: "testnet" as const,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
    };

    it("validateCreateClaimableBalanceParams checks amount, claimant, and predicate", () => {
      expect(
        validateCreateClaimableBalanceParams({
          amount: "100.5",
          claimant,
          predicate: { type: "unconditional" },
        }).status,
      ).toBe("ok");

      expect(
        validateCreateClaimableBalanceParams({
          amount: "-1",
          claimant,
          predicate: { type: "unconditional" },
        }).status,
      ).toBe("error");

      expect(
        validateCreateClaimableBalanceParams({
          amount: "100",
          claimant: "invalid",
          predicate: { type: "unconditional" },
        }).status,
      ).toBe("error");

      expect(
        validateCreateClaimableBalanceParams({
          amount: "100",
          claimant,
        } as unknown as Parameters<typeof validateCreateClaimableBalanceParams>[0]).status,
      ).toBe("error");
    });

    it("buildCreateClaimableBalanceOperation constructs operation for native asset", () => {
      const opResult = buildCreateClaimableBalanceOperation({
        amount: "50",
        claimant,
        predicate: { type: "unconditional" },
      });
      expect(opResult.status).toBe("ok");
    });

    it("buildClaimClaimableBalanceOperation constructs operation for valid balance ID", () => {
      const validId = "00000000" + "12".repeat(32);
      const opResult = buildClaimClaimableBalanceOperation(validId);
      expect(opResult.status).toBe("ok");

      const invalidResult = buildClaimClaimableBalanceOperation("bad-id");
      expect(invalidResult.status).toBe("error");
    });

    it("buildCreateClaimableBalance and buildClaimClaimableBalance build offline transactions with options", async () => {
      const issuer = Keypair.random().publicKey();
      const usdcAsset = new Asset("USDC", issuer);

      // Create with non-native asset and memo
      const createTx = await buildCreateClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          asset: usdcAsset,
          amount: "10.5",
          claimant,
          predicate: { type: "unconditional" },
          sequenceNumber: "1",
          memo: "hello claimable",
          memoType: "text",
        },
        [issuer],
      );
      expect(createTx.status).toBe("ok");

      // Create with untrusted issuer fails
      const untrustedTx = await buildCreateClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          asset: usdcAsset,
          amount: "10.5",
          claimant,
          predicate: { type: "unconditional" },
          sequenceNumber: "1",
        },
        ["GDOTHERISSUER"],
      );
      expect(untrustedTx.status).toBe("error");

      // Create with invalid params fails
      const invalidCreate = await buildCreateClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          amount: "-5",
          claimant,
          predicate: { type: "unconditional" },
          sequenceNumber: "1",
        },
      );
      expect(invalidCreate.status).toBe("error");

      // Create missing sequenceNumber without autoFetchSequence fails
      const noSeqCreate = await buildCreateClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          amount: "10",
          claimant,
          predicate: { type: "unconditional" },
        },
      );
      expect(noSeqCreate.status).toBe("error");

      // Claim with valid balanceId and memo
      const validId = "00000000" + "12".repeat(32);
      const claimTx = await buildClaimClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          balanceId: validId,
          sequenceNumber: "1",
          memo: "claim memo",
          memoType: "text",
        },
      );
      expect(claimTx.status).toBe("ok");

      // Claim with invalid balanceId fails
      const invalidClaim = await buildClaimClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          balanceId: "invalid-id",
          sequenceNumber: "1",
        },
      );
      expect(invalidClaim.status).toBe("error");

      // Claim missing sequenceNumber fails
      const noSeqClaim = await buildClaimClaimableBalance(
        network.horizonUrl,
        network,
        sourcePublicKey,
        {
          balanceId: validId,
        },
      );
      expect(noSeqClaim.status).toBe("error");
    });
  });
});
