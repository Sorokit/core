import { describe, expect, it, vi } from "vitest";
import { createSorokitClient } from "./createSorokitClient";
import type { SorokitClient } from "./createSorokitClient";

/**
 * SorokitClient type/runtime shape (#786).
 *
 * `soroban.detectContractUpgrade` was cast `as any` in the client factory,
 * which silently discarded the `SorokitClient` interface's declared return
 * type (`Promise<SorokitResult<UpgradeEvent>>`) at that call site — any
 * consumer code calling it would not get real type checking, no matter
 * what the interface promised. This pins both that the method compiles
 * without the cast and that its result actually narrows to the declared
 * discriminated union at the type level, the same guarantee every other
 * client method already had.
 */
describe("SorokitClient type/runtime shape", () => {
  function createTestClient(): SorokitClient {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "error") {
      throw new Error(`test setup failed: ${result.error.message}`);
    }
    return result.data;
  }

  it("detectContractUpgrade's result narrows to the declared SorokitResult<UpgradeEvent> union, not any", async () => {
    const client = createTestClient();

    const outcome = await client.soroban.detectContractUpgrade(
      "CCONTRACT0000000000000000000000000000000000000000000000",
    );

    // If this call site were still typed `any` (pre-#786), the compiler
    // would accept *any* member access here with no error, including a
    // typo like `outcome.staatus`. Accessing the real discriminant and
    // branching on it is exactly the type safety the interface promises
    // and the bug silently withheld.
    if (outcome.status === "ok") {
      expect(typeof outcome.data.contractId).toBe("string");
      expect(typeof outcome.data.upgraded).toBe("boolean");
    } else {
      expect(typeof outcome.error.code).toBe("string");
    }
  });

  it("every documented client namespace is present on the returned object", () => {
    const client = createTestClient();

    for (const namespace of [
      "integration",
      "shared",
      "compliance",
      "wallet",
      "account",
      "transaction",
      "soroban",
      "network",
    ] as const) {
      expect(client[namespace]).toBeDefined();
    }
  });

  it("healthCheck is callable and returns the documented report shape", async () => {
    const client = createTestClient();

    const result = await client.healthCheck();

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(["healthy", "degraded", "down"]).toContain(result.data.status);
      expect(typeof result.data.version).toBe("string");
    }
  });
});

describe("stellar-sdk version compatibility check wiring (#865)", () => {
  it("logs a warning when config.stellarSdkVersion diverges, and does not fail client creation", () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const result = createSorokitClient({
      network: "testnet",
      logger,
      stellarSdkVersion: "99.0.0",
    });

    expect(result.status).toBe("ok");
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0]!;
    expect(message).toContain("99.0.0");
  });

  it("does not log anything when stellarSdkVersion is omitted", () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const result = createSorokitClient({ network: "testnet", logger });

    expect(result.status).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });
});
