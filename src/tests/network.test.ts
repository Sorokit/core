import { describe, it, expect } from "vitest";
import { resolveNetwork } from "../network/resolveNetwork";
import { getNetwork } from "../network/getNetwork";
import { setNetwork } from "../network/setNetwork";
import { SorokitErrorCode } from "../shared/response";

describe("network/resolveNetwork", () => {
  it("returns testnet config with no overrides", () => {
    const result = resolveNetwork("testnet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("testnet");
      expect(result.data.horizonUrl).toContain("testnet");
      expect(result.data.networkPassphrase).toContain("Test SDF");
    }
  });

  it("returns mainnet config", () => {
    const result = resolveNetwork("mainnet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("returns futurenet config", () => {
    const result = resolveNetwork("futurenet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("futurenet");
    }
  });

  it("applies horizonUrl override", () => {
    const result = resolveNetwork("testnet", {
      horizonUrl: "https://my-custom-horizon.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe(
        "https://my-custom-horizon.example.com",
      );
      expect(result.data.rpcUrl).toContain("testnet");
    }
  });

  it("applies rpcUrl override", () => {
    const result = resolveNetwork("mainnet", {
      rpcUrl: "https://my-rpc.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.rpcUrl).toBe("https://my-rpc.example.com");
      expect(result.data.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("returns INVALID_NETWORK for unknown network", () => {
    // @ts-expect-error — intentionally testing invalid input
    const result = resolveNetwork("invalidnet");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
    }
  });
});

describe("network/getNetwork (delegates to resolveNetwork)", () => {
  it("returns testnet config", () => {
    const result = getNetwork("testnet");
    expect(result.status).toBe("ok");
  });

  it("returns INVALID_NETWORK for unknown network", () => {
    // @ts-expect-error
    const result = getNetwork("badnet");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
    }
  });
});

describe("network/setNetwork (delegates to resolveNetwork)", () => {
  it("applies overrides", () => {
    const result = setNetwork("testnet", {
      horizonUrl: "https://custom.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe("https://custom.example.com");
    }
  });
});
