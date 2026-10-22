import { describe, it, expect } from "vitest";
import {
  SorobanErrorDecoder,
  decodeSorobanPanic,
} from "../soroban/sorobanErrorDecoder";
import { decodeContractError } from "../soroban/contractErrors";

describe("SorobanErrorDecoder (#859)", () => {
  describe("WebAssembly traps", () => {
    it("decodes unreachable instruction traps", () => {
      const err = new Error("VM call trapped: unreachable");
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("wasm_trap");
      expect(decoded.description).toContain("unreachable");
    });

    it("decodes integer overflow traps", () => {
      const err = "HostError: Error(WasmVm, Trapped) attempt to add with overflow";
      const decoded = decodeSorobanPanic(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.description).toContain("overflow");
    });

    it("decodes division by zero traps", () => {
      const err = "division by zero";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.description).toContain("Division or remainder by zero");
    });

    it("decodes out of bounds memory access", () => {
      const err = "memory access out of bounds";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.description).toContain("out of bounds");
    });

    it("decodes call stack exhaustion", () => {
      const err = "call stack exhausted";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.description).toContain("stack exhausted");
    });
  });

  describe("Host error traps", () => {
    it("decodes WasmVm trap host error", () => {
      const err = "HostError: Error(WasmVm, Trapped)";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("wasm_trap");
      expect(decoded.description).toContain("WebAssembly VM execution trapped");
    });

    it("decodes host context trap", () => {
      const err = "HostError: Error(Context, Trap)";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("host_trap");
      expect(decoded.description).toContain("host context trap");
    });

    it("decodes budget exceeded error", () => {
      const err = "Error(Budget, ExceededLimit) cpu instructions exceeded";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("budget_exceeded");
      expect(decoded.description).toContain("budget exceeded");
    });

    it("decodes missing storage key error", () => {
      const err = "Error(Storage, MissingValue)";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("storage_error");
      expect(decoded.description).toContain("missing or expired storage key");
    });

    it("decodes authorization failure", () => {
      const err = "Error(Auth, Invalid)";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("auth_failed");
      expect(decoded.description).toContain("authorization failed");
    });
  });

  describe("Rust panic strings", () => {
    it("decodes rust panic with message and source location", () => {
      const err = "panicked at 'insufficient balance: required 100, available 10', src/token.rs:88:9";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("rust_panic");
      expect(decoded.description).toContain("insufficient balance: required 100, available 10");
      expect(decoded.description).toContain("src/token.rs:88:9");
    });

    it("extracts custom contract code when present", () => {
      const err = "HostError: Error(Contract, #42) panicked at 'unauthorized access'";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.code).toBe("42");
      expect(decoded.description).toContain("unauthorized access");
    });
  });

  describe("Fallback behavior", () => {
    it("falls back gracefully for unknown panic format", () => {
      const err = "Unknown Soroban panic 0xdeadbeef";
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(true);
      expect(decoded.type).toBe("unknown");
      expect(decoded.description).toContain("Contract trapped with panic");
    });

    it("returns non-panic status for standard errors", () => {
      const err = new Error("Network request timed out");
      const decoded = SorobanErrorDecoder.decode(err);
      expect(decoded.isPanic).toBe(false);
      expect(decoded.description).toBe("Network request timed out");
    });

    it("integrates seamlessly with decodeContractError", () => {
      const panicErr = new Error("VM call trapped: unreachable");
      const decoded = decodeContractError(panicErr);
      expect(decoded.decoded).toBe(true);
      expect(decoded.message).toContain("unreachable");
    });
  });
});
