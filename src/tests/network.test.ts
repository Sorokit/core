import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("applies both horizonUrl and rpcUrl overrides simultaneously and preserves networkPassphrase", () => {
    const result = resolveNetwork("testnet", {
      horizonUrl: "https://h.example.com",
      rpcUrl: "https://r.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe("https://h.example.com");
      expect(result.data.rpcUrl).toBe("https://r.example.com");
      expect(result.data.networkPassphrase).toContain("Test SDF");
    }
  });

  it("networkPassphrase is never overridable via NetworkOverrides", () => {
    const result = resolveNetwork("testnet", {
      horizonUrl: "https://custom-horizon.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkPassphrase).toBe(
        "Test SDF Network ; September 2015",
      );
    }
  });

  it("empty overrides object returns the base config unchanged", () => {
    const result = resolveNetwork("testnet", {});
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("testnet");
      expect(result.data.horizonUrl).toContain("testnet");
      expect(result.data.networkPassphrase).toContain("Test SDF");
    }
  });

  describe("URL validation (#789)", () => {
    it.each([
      ["not-a-url", "a non-URL string"],
      ["ftp://example.com", "a non-http(s) protocol"],
      ["http://example.com", "plain HTTP on a non-localhost host"],
      ["", "an empty string"],
      ["   ", "a whitespace-only string"],
    ])("rejects horizonUrl override %j (%s)", (value) => {
      const result = resolveNetwork("testnet", { horizonUrl: value });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
        expect(result.error.message).toContain("horizonUrl");
      }
    });

    it.each([
      ["not-a-url", "a non-URL string"],
      ["ftp://example.com", "a non-http(s) protocol"],
      ["http://example.com", "plain HTTP on a non-localhost host"],
    ])("rejects rpcUrl override %j (%s)", (value) => {
      const result = resolveNetwork("testnet", { rpcUrl: value });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
        expect(result.error.message).toContain("rpcUrl");
      }
    });

    it.each([
      "https://custom-horizon.example.com",
      "http://localhost:8000",
      "http://127.0.0.1:8000",
    ])("accepts valid horizonUrl override %j", (value) => {
      const result = resolveNetwork("testnet", { horizonUrl: value });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.horizonUrl).toBe(value);
      }
    });

    it.each([
      "https://my-rpc.example.com",
      "http://localhost:8000/soroban/rpc",
      "http://127.0.0.1:8000/soroban/rpc",
    ])("accepts valid rpcUrl override %j", (value) => {
      const result = resolveNetwork("testnet", { rpcUrl: value });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.rpcUrl).toBe(value);
      }
    });
  });
});

describe("network/getNetwork (delegates to resolveNetwork)", () => {
  it("returns testnet config", () => {
    const result = getNetwork("testnet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("testnet");
      expect(result.data.horizonUrl).toContain("testnet");
    }
  });

  it("returns mainnet config", () => {
    const result = getNetwork("mainnet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("mainnet");
      expect(result.data.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("returns futurenet config", () => {
    const result = getNetwork("futurenet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("futurenet");
      expect(result.data.horizonUrl).toContain("futurenet");
    }
  });

  it("returns INVALID_NETWORK for unknown network", () => {
    // @ts-expect-error — intentionally testing invalid input
    const result = getNetwork("badnet");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
    }
  });
});

describe("network/setNetwork (delegates to resolveNetwork)", () => {
  it("applies horizonUrl only override", () => {
    const result = setNetwork("testnet", {
      horizonUrl: "https://custom.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe("https://custom.example.com");
      expect(result.data.rpcUrl).toContain("testnet");
    }
  });

  it("applies rpcUrl only override", () => {
    const result = setNetwork("mainnet", {
      rpcUrl: "https://custom-rpc.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.rpcUrl).toBe("https://custom-rpc.example.com");
      expect(result.data.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("applies combined horizonUrl and rpcUrl overrides", () => {
    const result = setNetwork("testnet", {
      horizonUrl: "https://custom-horizon.example.com",
      rpcUrl: "https://custom-rpc.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.horizonUrl).toBe(
        "https://custom-horizon.example.com",
      );
      expect(result.data.rpcUrl).toBe("https://custom-rpc.example.com");
    }
  });

  it("returns INVALID_NETWORK for unknown network", () => {
    // @ts-expect-error — intentionally testing invalid input
    const result = setNetwork("badnet", {
      horizonUrl: "https://custom.example.com",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
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

// ─── NetworkSwitcher ───────────────────────────────────────────────────────────

import { NetworkSwitcher } from "../network/networkSwitcher";
import type { NetworkInfo } from "../network/networkSwitcher";

const mockStorage: Record<string, string> = {};

beforeEach(() => {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { mockStorage[key] = value; }),
      removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
      clear: vi.fn(() => { Object.keys(mockStorage).forEach((k) => delete mockStorage[k]); }),
    },
    writable: true,
    configurable: true,
  });
});

describe("NetworkSwitcher", () => {

  it("starts with testnet by default", () => {
    const ns = new NetworkSwitcher();
    expect(ns.current.network).toBe("testnet");
    expect(ns.current.isCustom).toBe(false);
  });

  it("accepts initial network config", () => {
    const ns = new NetworkSwitcher({ initialNetwork: "mainnet" });
    expect(ns.current.network).toBe("mainnet");
    expect(ns.current.horizonUrl).toContain("stellar.org");
  });

  it("returns available networks including presets", () => {
    const ns = new NetworkSwitcher();
    const networks = ns.networks;
    expect(networks.length).toBeGreaterThanOrEqual(3);
    expect(networks.map((n) => n.label)).toContain("Mainnet");
    expect(networks.map((n) => n.label)).toContain("Testnet");
    expect(networks.map((n) => n.label)).toContain("Futurenet");
  });

  it("switches to a different preset network", () => {
    const ns = new NetworkSwitcher({ initialNetwork: "testnet" });
    const result = ns.switchTo("mainnet");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("mainnet");
    }
    expect(ns.current.network).toBe("mainnet");
  });

  it("emits event on network switch", () => {
    const ns = new NetworkSwitcher({ initialNetwork: "testnet" });
    const listener = vi.fn();
    ns.subscribe(listener);
    ns.switchTo("futurenet");
    expect(listener).toHaveBeenCalledTimes(1);
    const info: NetworkInfo = listener.mock.calls[0][0];
    expect(info.network).toBe("futurenet");
  });

  it("adds custom network", () => {
    const ns = new NetworkSwitcher();
    const result = ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    expect(result.status).toBe("ok");
    expect(ns.customNetworks).toHaveLength(1);
    expect(ns.networks.map((n) => n.label)).toContain("local");
  });

  it("rejects duplicate custom network", () => {
    const ns = new NetworkSwitcher();
    ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    const result = ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    expect(result.status).toBe("error");
  });

  it("rejects incomplete custom network", () => {
    const ns = new NetworkSwitcher();
    const result = ns.addCustomNetwork({
      name: "incomplete",
      horizonUrl: "",
      rpcUrl: "",
      networkPassphrase: "",
    });
    expect(result.status).toBe("error");
  });

  it("switches to custom network", () => {
    const ns = new NetworkSwitcher();
    ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    const result = ns.switchTo("local");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.network).toBe("local");
      expect(result.data.isCustom).toBe(true);
    }
    expect(ns.current.network).toBe("local");
  });

  it("removes custom network", () => {
    const ns = new NetworkSwitcher();
    ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    const result = ns.removeCustomNetwork("local");
    expect(result.status).toBe("ok");
    expect(ns.customNetworks).toHaveLength(0);
  });

  it("removing custom network falls back to testnet if it was active", () => {
    const ns = new NetworkSwitcher();
    ns.addCustomNetwork({
      name: "local",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8001/rpc",
      networkPassphrase: "Local Network ; 2024",
    });
    ns.switchTo("local");
    ns.removeCustomNetwork("local");
    expect(ns.current.network).toBe("testnet");
  });

  it("return error removing non-existent custom network", () => {
    const ns = new NetworkSwitcher();
    const result = ns.removeCustomNetwork("nonexistent");
    expect(result.status).toBe("error");
  });

  it("provides aria label", () => {
    const ns = new NetworkSwitcher({ initialNetwork: "mainnet" });
    const label = ns.getAriaLabel();
    expect(label).toContain("mainnet");
    expect(label).toContain("mainnet network");
    expect(label).toContain("RPC");
  });

  it("subscribe returns unsubscribe function", () => {
    const ns = new NetworkSwitcher();
    const listener = vi.fn();
    const unsubscribe = ns.subscribe(listener);
    expect(typeof unsubscribe).toBe("function");
    ns.switchTo("mainnet");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    ns.switchTo("futurenet");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("persists network to localStorage on switch", () => {
    const ns = new NetworkSwitcher({ initialNetwork: "testnet" });
    ns.switchTo("mainnet");
    const stored = localStorage.getItem("sorokit:selected-network");
    expect(stored).toBe("mainnet");
  });

  it("restores network from localStorage", () => {
    localStorage.setItem("sorokit:selected-network", "futurenet");
    const ns = new NetworkSwitcher();
    expect(ns.current.network).toBe("futurenet");
  });

  it("onStatusChange listener is notified on checkHealth", async () => {
    const ns = new NetworkSwitcher({ initialNetwork: "testnet" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    // Override checkHealth to use mock fetch
    (globalThis as any).fetch = fetchFn;
    const listener = vi.fn();
    ns.onStatusChange(listener);
    await ns.checkHealth();
    expect(listener).toHaveBeenCalled();
  });

  it("accepts custom networks via config", () => {
    const ns = new NetworkSwitcher({
      initialNetwork: "custom-net",
      customNetworks: [
        {
          name: "custom-net",
          horizonUrl: "https://custom-horizon.example.com",
          rpcUrl: "https://custom-rpc.example.com",
          networkPassphrase: "Custom Network",
        },
      ],
    });
    expect(ns.current.network).toBe("custom-net");
    expect(ns.current.isCustom).toBe(true);
  });
});
