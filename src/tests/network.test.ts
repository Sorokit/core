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

describe("network/getNetworkFeeStats", () => {
  const { getNetworkFeeStats } = require("../network");

  function makeFetchFn(records: Array<{ fee_charged?: string }>, status = 200) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ _embedded: { records } }),
    })) as unknown as typeof fetch;
  }

  it("returns ok with fee stats for hour window", async () => {
    const records = [100, 200, 300, 150, 200].map((f) => ({ fee_charged: String(f) }));
    const result = await getNetworkFeeStats("https://horizon.test", "hour", makeFetchFn(records));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.window).toBe("hour");
    expect(result.data.sampleSize).toBe(5);
    expect(Number(result.data.min)).toBe(100);
    expect(Number(result.data.max)).toBe(300);
    expect(Number(result.data.mode)).toBe(200);
  });

  it("computes correct median for odd-length sample", async () => {
    const records = [100, 200, 300].map((f) => ({ fee_charged: String(f) }));
    const result = await getNetworkFeeStats("https://horizon.test", "hour", makeFetchFn(records));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.median).toBe("200");
  });

  it("computes correct median for even-length sample", async () => {
    const records = [100, 200, 300, 400].map((f) => ({ fee_charged: String(f) }));
    const result = await getNetworkFeeStats("https://horizon.test", "hour", makeFetchFn(records));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.median).toBe("250");
  });

  it("defaults to hour window when window is not specified", async () => {
    const records = [100].map((f) => ({ fee_charged: String(f) }));
    const fetchFn = makeFetchFn(records);
    const result = await getNetworkFeeStats("https://horizon.test", undefined, fetchFn);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.window).toBe("hour");
    const calledUrl = (fetchFn.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("limit=50");
  });

  it("requests more transactions for day window", async () => {
    const fetchFn = makeFetchFn([{ fee_charged: "100" }]);
    await getNetworkFeeStats("https://horizon.test", "day", fetchFn);
    const calledUrl = (fetchFn.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("limit=100");
  });

  it("requests max transactions for week window", async () => {
    const fetchFn = makeFetchFn([{ fee_charged: "100" }]);
    await getNetworkFeeStats("https://horizon.test", "week", fetchFn);
    const calledUrl = (fetchFn.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("limit=200");
  });

  it("returns zeros when no transactions are available", async () => {
    const result = await getNetworkFeeStats("https://horizon.test", "hour", makeFetchFn([]));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.sampleSize).toBe(0);
    expect(result.data.min).toBe("0");
  });

  it("returns error when Horizon responds with non-2xx", async () => {
    const result = await getNetworkFeeStats("https://horizon.test", "hour", makeFetchFn([], 503));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.message).toContain("503");
  });

  it("returns error when fetch throws", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const result = await getNetworkFeeStats("https://horizon.test", "hour", fetchFn);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.message).toContain("connection refused");
  });
});
