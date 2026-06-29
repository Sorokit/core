import { describe, it, expect, vi } from "vitest";
import { resolveNetwork } from "../network/resolveNetwork";
import { getNetwork } from "../network/getNetwork";
import { setNetwork } from "../network/setNetwork";
import { checkNetworkHealth } from "../network";
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

describe("network/checkNetworkHealth (#98)", () => {
  it("reports healthy when both endpoints respond ok", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const result = await checkNetworkHealth(
      "https://horizon.test",
      "https://rpc.test",
      { fetchFn },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.status).toBe("healthy");
    expect(result.data.horizon.reachable).toBe(true);
    expect(result.data.rpc.reachable).toBe(true);
    expect(result.data.issues).toEqual([]);
  });

  it("reports degraded when only one endpoint is reachable", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 503 }) as unknown as typeof fetch;
    const result = await checkNetworkHealth(
      "https://horizon.test",
      "https://rpc.test",
      { fetchFn },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.status).toBe("degraded");
    expect(result.data.rpc.reachable).toBe(false);
    expect(result.data.recommendations.length).toBeGreaterThan(0);
  });

  it("reports down when both endpoints fail", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkNetworkHealth(
      "https://horizon.test",
      "https://rpc.test",
      { fetchFn },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.status).toBe("down");
    expect(result.data.horizon.reachable).toBe(false);
    expect(result.data.rpc.reachable).toBe(false);
    expect(result.data.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("measures latency for each endpoint", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const result = await checkNetworkHealth(
      "https://horizon.test",
      "https://rpc.test",
      { fetchFn },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.horizon.latencyMs).not.toBeNull();
    expect(result.data.rpc.latencyMs).not.toBeNull();
  });

  it("times out when a request hangs", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<{ ok: boolean; status: number }>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const result = await checkNetworkHealth(
      "https://horizon.test",
      "https://rpc.test",
      { fetchFn, timeoutMs: 10 },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.status).toBe("down");
    expect(result.data.horizon.reachable).toBe(false);
  });
});
