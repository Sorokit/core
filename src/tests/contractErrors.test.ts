/**
 * Tests for contract error decoding (#391).
 */

import { describe, expect, it } from "vitest";
import { SorokitErrorCode, err } from "../shared/response";
import {
  DEFAULT_CONTRACT_ERROR_MAP,
  FACTORY_CONTRACT_ERRORS,
  FACTORY_ERROR_CODES,
  ROUTER_CONTRACT_ERRORS,
  ROUTER_ERROR_CODES,
  decodeContractError,
} from "../soroban/contractErrors";
import type { ContractErrorMap } from "../soroban/contractErrors";

/** Mimics stellar-sdk HostError shape (`codes()` accessor). */
class FakeHostError extends Error {
  constructor(private readonly hostCodes: unknown[]) {
    super(`HostError: Error(Contract, #${hostCodes.at(-1)})`);
    this.name = "HostError";
  }
  codes(): unknown[] {
    return this.hostCodes;
  }
}

describe("decodeContractError (#391)", () => {
  describe("mapped errors", () => {
    it("decodes numeric HostError codes for router contracts", () => {
      // Numeric decoding requires the family map: a bare code is ambiguous
      // across contract families and is absent from the default map (#726/#804).
      const decoded = decodeContractError(
        new FakeHostError(["Contract", 3]),
        ROUTER_CONTRACT_ERRORS,
      );

      expect(decoded.decoded).toBe(true);
      expect(decoded.code).toBe("3");
      expect(decoded.message).toContain("slippage");
      expect(decoded.remediation).toBeDefined();
      expect(decoded.raw).toBeInstanceOf(FakeHostError);
    });

    it("decodes symbolic names", () => {
      const decoded = decodeContractError("ROUTER_INVALID_PATH");

      expect(decoded.decoded).toBe(true);
      expect(decoded.code).toBe("ROUTER_INVALID_PATH");
      expect(decoded.message).toContain("path");
      expect(decoded.remediation).toBeDefined();
    });

    it("extracts embedded #N codes from arbitrary messages", () => {
      const failure = new Error("invoke failed with Error(Contract, #7)");
      // Family map required so the embedded bare code resolves to the router family.
      const decoded = decodeContractError(failure, ROUTER_CONTRACT_ERRORS);

      expect(decoded.decoded).toBe(true);
      expect(decoded.code).toBe("7");
      expect(decoded.message).toContain("x·y=k");
    });

    it("decodes factory errors including remediation guidance", () => {
      // Factory and router contracts share numeric code spaces, so bare numeric
      // codes live only in the family maps and are absent from the default map.
      const decoded = decodeContractError(
        FACTORY_ERROR_CODES.PAIR_ALREADY_EXISTS,
        FACTORY_CONTRACT_ERRORS,
      );

      expect(decoded.decoded).toBe(true);
      expect(decoded.message).toContain("already exists");
      expect(decoded.remediation).toContain("existing pair");
    });

    it("fails closed for unqualified numeric codes in the default map", () => {
      const decoded = decodeContractError(new FakeHostError(["Contract", 3]));

      expect(decoded.decoded).toBe(false);
      expect(decoded.code).toBe("3");
    });

    it("decodes numeric codes when the caller supplies the family map", () => {
      const decoded = decodeContractError(
        ROUTER_ERROR_CODES.ROUTER_SLIPPAGE_EXCEEDED,
        ROUTER_CONTRACT_ERRORS,
      );

      expect(decoded.decoded).toBe(true);
      expect(decoded.message).toContain("slippage");
    });

    it("supports custom application-provided maps", () => {
      const customMap: ContractErrorMap = {
        MY_CUSTOM_ERROR: { message: "Something domain-specific happened." },
      };

      const decoded = decodeContractError("MY_CUSTOM_ERROR", customMap);

      expect(decoded.decoded).toBe(true);
      expect(decoded.message).toBe("Something domain-specific happened.");
      expect(decoded.remediation).toBeUndefined();
    });

    it("exposes factory and router mappings keyed by name and number", () => {
      expect(
        FACTORY_CONTRACT_ERRORS[String(FACTORY_ERROR_CODES.UNAUTHORIZED)],
      ).toBeDefined();
      expect(FACTORY_CONTRACT_ERRORS.UNAUTHORIZED).toBeDefined();
      expect(
        ROUTER_CONTRACT_ERRORS[
          String(ROUTER_ERROR_CODES.ROUTER_INSUFFICIENT_LIQUIDITY)
        ],
      ).toBeDefined();

      // Default map combines both.
      expect(DEFAULT_CONTRACT_ERROR_MAP.EXPIRED_DEADLINE).toBeDefined();
      expect(
        DEFAULT_CONTRACT_ERROR_MAP[
          `ROUTER_${ROUTER_ERROR_CODES.ROUTER_INSUFFICIENT_LIQUIDITY}`
        ],
      ).toBeDefined();

      // Merged map keeps no bare numeric keys, so unqualified codes fail closed.
      expect(DEFAULT_CONTRACT_ERROR_MAP["3"]).toBeUndefined();
      expect(DEFAULT_CONTRACT_ERROR_MAP["1"]).toBeUndefined();
      expect(
        Object.keys(DEFAULT_CONTRACT_ERROR_MAP).filter((key) =>
          /^\d+$/.test(key),
        ),
      ).toEqual([]);
    });
  });

  describe("unknown and unmapped errors", () => {
    it("preserves unmapped numeric codes with the original message", () => {
      const original = new Error("Error(Contract, #4242)");
      const decoded = decodeContractError(original);

      expect(decoded.decoded).toBe(false);
      expect(decoded.code).toBe("4242");
      expect(decoded.message).toBe("Error(Contract, #4242)");
      expect(decoded.raw).toBe(original);
    });

    it("preserves Sorokit results that carry no mapped contract code", () => {
      const result = err(
        SorokitErrorCode.CONTRACT_INVOKE_FAILED,
        "simulation exploded",
      );
      const decoded = decodeContractError(result);

      expect(decoded.decoded).toBe(false);
      expect(decoded.message).toBe("simulation exploded");
      expect(decoded.raw).toBe(result);
    });
  });

  describe("malformed inputs", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["number", 42],
      ["empty object", {}],
      ["array of junk", [Symbol("x")]],
    ])("never throws on %s", (_label, input) => {
      expect(() => decodeContractError(input)).not.toThrow();
      const decoded = decodeContractError(input);
      expect(decoded.decoded).toBe(false);
      expect(typeof decoded.message).toBe("string");
      expect(decoded.raw).toBe(input);
    });

    it("handles objects whose property access throws", () => {
      const hostile = {
        get code(): string {
          throw new Error("boom");
        },
      };
      const decoded = decodeContractError(hostile);
      expect(decoded.decoded).toBe(false);
      expect(decoded.code).toBeNull();
    });
  });
});
