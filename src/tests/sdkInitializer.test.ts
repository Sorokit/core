import { describe, expect, it } from "vitest";
import { initializeSDK } from "../infrastructure/sdkInitializer";
import type { SorokitCache } from "../shared/cache";

describe("SDK initialization helper (#1052)", () => {
  it("initializes a client with network and logging configuration", () => {
    const result = initializeSDK({
      network: "testnet",
      logLevel: "debug",
      cacheStrategy: "none",
      timeout: 5000,
    });

    expect(result.status).toBe("ok");
    expect(result.data?.networkConfig.network).toBe("testnet");
  });

  it("applies an in-memory cache strategy", () => {
    const result = initializeSDK({
      network: "mainnet",
      cacheStrategy: "memory",
    });
    expect(result.status).toBe("ok");
  });

  it("applies a custom cache implementation", () => {
    const customCache: SorokitCache = {
      get: () => undefined,
      set: () => undefined,
      invalidate: () => undefined,
      clear: () => undefined,
    };
    const result = initializeSDK({
      network: "futurenet",
      cacheStrategy: customCache,
    });
    expect(result.status).toBe("ok");
  });

  it("rejects invalid timeout values", () => {
    expect(
      initializeSDK({
        network: "testnet",
        timeout: -1,
      }).status,
    ).toBe("error");
  });

  it("rejects invalid networks", () => {
    expect(
      // @ts-expect-error intentionally invalid network
      initializeSDK({ network: "private" }).status,
    ).toBe("error");
  });
});
