import { describe, it, expect, vi } from "vitest";
import {
  checkEnvironment,
  checkHorizonConnectivity,
  checkNetworkConfiguration,
  checkSdkHealth,
  checkSorobanRpcConnectivity,
  checkWalletAdapterStatus,
  combineHealthStatuses,
  runDiagnostics,
  DEFAULT_SLOW_LATENCY_MS,
  type DiagnosticHealthStatus,
} from "../shared/diagnostics";
import { SDK_VERSION } from "../shared/constants";
import { WalletType, type WalletAdapter } from "../wallet/types";

const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://soroban-testnet.stellar.org";

/** A fetch stub that resolves OK after an optional simulated delay. */
function okFetch(delayMs = 0): typeof fetch {
  return vi.fn(async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A fetch stub that resolves with an HTTP error status. */
function errorFetch(status = 503): typeof fetch {
  return vi.fn(async () => new Response("unavailable", { status })) as unknown as typeof fetch;
}

/** A fetch stub that rejects, as a transport failure would. */
function rejectingFetch(message = "ECONNREFUSED"): typeof fetch {
  return vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** A fetch stub that never settles until its abort signal fires. */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  }) as unknown as typeof fetch;
}

/** Minimal adapter stub; only isAvailable is ever consulted. */
function adapterStub(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
    ...overrides,
  } as unknown as WalletAdapter;
}

describe("combineHealthStatuses", () => {
  it("returns the worst status present", () => {
    expect(combineHealthStatuses(["healthy", "degraded"])).toBe("degraded");
    expect(combineHealthStatuses(["healthy", "unavailable", "degraded"])).toBe(
      "unavailable",
    );
  });

  it("ignores skipped checks", () => {
    expect(combineHealthStatuses(["healthy", "skipped"])).toBe("healthy");
  });

  it("returns skipped when nothing was evaluated", () => {
    expect(combineHealthStatuses([])).toBe("skipped");
    expect(combineHealthStatuses(["skipped", "skipped"])).toBe("skipped");
  });
});

describe("checkHorizonConnectivity", () => {
  it("reports healthy and captures latency for a reachable endpoint", async () => {
    const result = await checkHorizonConnectivity(HORIZON, {
      fetchFn: okFetch(),
    });

    expect(result.status).toBe("healthy");
    expect(result.id).toBe("horizon");
    expect(result.latencyMs).not.toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.issues).toEqual([]);
  });

  it("reports unavailable with a recommendation on an HTTP error", async () => {
    const result = await checkHorizonConnectivity(HORIZON, {
      fetchFn: errorFetch(503),
    });

    expect(result.status).toBe("unavailable");
    expect(result.issues[0]).toContain("503");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("reports unavailable when the transport fails", async () => {
    const result = await checkHorizonConnectivity(HORIZON, {
      fetchFn: rejectingFetch(),
    });

    expect(result.status).toBe("unavailable");
    expect(result.issues[0]).toContain("ECONNREFUSED");
  });

  it("reports degraded when the endpoint is reachable but slow", async () => {
    const result = await checkHorizonConnectivity(HORIZON, {
      fetchFn: okFetch(60),
      slowLatencyMs: 10,
    });

    expect(result.status).toBe("degraded");
    expect(result.message).toContain("slow");
    expect(result.recommendations[0]).toContain("closer");
  });

  it("distinguishes a timeout from a transport failure", async () => {
    const result = await checkHorizonConnectivity(HORIZON, {
      fetchFn: hangingFetch(),
      timeoutMs: 20,
    });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("timed out");
    expect(result.recommendations[0]).toContain("timeoutMs");
  });

  it("reports unavailable with guidance when no fetch implementation exists", async () => {
    // Node 18+ supplies a global fetch, so the branch is only reachable with
    // the global removed for the duration of the call.
    const globals = globalThis as { fetch?: typeof fetch };
    const original = globals.fetch;
    delete globals.fetch;

    try {
      const result = await checkHorizonConnectivity(HORIZON);

      expect(result.status).toBe("unavailable");
      expect(result.latencyMs).toBeNull();
      expect(result.recommendations[0]).toContain("options.fetchFn");
    } finally {
      if (original !== undefined) globals.fetch = original;
    }
  });

  it("reports the environment as degraded when fetch is missing", async () => {
    const globals = globalThis as { fetch?: typeof fetch };
    const original = globals.fetch;
    delete globals.fetch;

    try {
      const result = checkEnvironment();

      expect(result.status).toBe("degraded");
      expect(result.issues[0]).toContain("fetch");
    } finally {
      if (original !== undefined) globals.fetch = original;
    }
  });

  it("requests a single ledger rather than a full page", async () => {
    const fetchFn = okFetch();
    await checkHorizonConnectivity(HORIZON, { fetchFn });

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("/ledgers?limit=1");
  });
});

describe("checkSorobanRpcConnectivity", () => {
  it("reports healthy for a responsive RPC node", async () => {
    const result = await checkSorobanRpcConnectivity(RPC, {
      fetchFn: okFetch(),
    });

    expect(result.status).toBe("healthy");
    expect(result.id).toBe("sorobanRpc");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("calls the RPC getHealth method rather than only opening a socket", async () => {
    const fetchFn = okFetch();
    await checkSorobanRpcConnectivity(RPC, { fetchFn });

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("getHealth");
  });

  it("reports unavailable when the node is down", async () => {
    const result = await checkSorobanRpcConnectivity(RPC, {
      fetchFn: rejectingFetch("socket hang up"),
    });

    expect(result.status).toBe("unavailable");
    expect(result.issues[0]).toContain("socket hang up");
  });

  it("reports degraded for a slow node", async () => {
    const result = await checkSorobanRpcConnectivity(RPC, {
      fetchFn: okFetch(60),
      slowLatencyMs: 10,
    });

    expect(result.status).toBe("degraded");
  });
});

describe("checkWalletAdapterStatus", () => {
  it("skips the check when no adapter is configured", () => {
    const result = checkWalletAdapterStatus();

    expect(result.status).toBe("skipped");
    expect(result.issues).toEqual([]);
  });

  it("reports healthy for an available adapter", () => {
    const result = checkWalletAdapterStatus(adapterStub());

    expect(result.status).toBe("healthy");
    expect(result.message).toContain(WalletType.FREIGHTER);
  });

  it("reports unavailable for an adapter that is not installed", () => {
    const result = checkWalletAdapterStatus(
      adapterStub({ isAvailable: () => false }),
    );

    expect(result.status).toBe("unavailable");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("survives an adapter whose availability check throws", () => {
    const result = checkWalletAdapterStatus(
      adapterStub({
        isAvailable: () => {
          throw new Error("extension API missing");
        },
      }),
    );

    expect(result.status).toBe("unavailable");
    expect(result.issues[0]).toContain("extension API missing");
  });

  it("never connects the wallet or signs anything", () => {
    const connect = vi.fn();
    const signTransaction = vi.fn();
    const disconnect = vi.fn();

    checkWalletAdapterStatus(
      adapterStub({ connect, signTransaction, disconnect }),
    );

    expect(connect).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("reports no wallet secrets in its output", () => {
    const result = checkWalletAdapterStatus(adapterStub());
    const serialised = JSON.stringify(result).toLowerCase();

    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("privatekey");
    expect(serialised).not.toContain("seed");
  });
});

describe("checkNetworkConfiguration", () => {
  it("accepts a valid default network", () => {
    const result = checkNetworkConfiguration({ network: "testnet" });

    expect(result.status).toBe("healthy");
    expect(result.issues).toEqual([]);
  });

  it("rejects an unknown network", () => {
    const result = checkNetworkConfiguration({
      network: "not-a-network" as never,
    });

    expect(result.status).toBe("unavailable");
    expect(result.recommendations[0]).toContain("testnet");
  });

  it("flags a malformed endpoint URL", () => {
    const result = checkNetworkConfiguration({
      network: "testnet",
      horizonUrl: "horizon.stellar.org",
    });

    expect(result.status).toBe("degraded");
    expect(result.issues[0]).toContain("not a valid URL");
  });

  it("flags an unsupported URL scheme", () => {
    const result = checkNetworkConfiguration({
      network: "testnet",
      rpcUrl: "ftp://example.com/rpc",
    });

    expect(result.status).toBe("degraded");
    expect(result.issues[0]).toContain("unsupported scheme");
  });

  it("flags plaintext HTTP on mainnet", () => {
    const result = checkNetworkConfiguration({
      network: "mainnet",
      horizonUrl: "http://horizon.stellar.org",
    });

    expect(result.status).toBe("degraded");
    expect(result.issues.some((i) => i.includes("plaintext HTTP"))).toBe(true);
  });

  it("permits plaintext HTTP on a test network", () => {
    const result = checkNetworkConfiguration({
      network: "testnet",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8000/soroban/rpc",
    });

    expect(result.status).toBe("healthy");
  });

  it("treats a mismatched network passphrase as unusable", () => {
    const result = checkNetworkConfiguration({
      network: "testnet",
      expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
    });

    expect(result.status).toBe("unavailable");
    expect(result.recommendations[0]).toContain("Test SDF Network");
  });

  it("accepts a matching network passphrase", () => {
    const result = checkNetworkConfiguration({
      network: "testnet",
      expectedNetworkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("healthy");
  });

  it("performs no network requests", () => {
    // The check is purely local, so it must succeed with fetch unavailable.
    const globals = globalThis as { fetch?: typeof fetch };
    const original = globals.fetch;
    delete globals.fetch;

    try {
      const result = checkNetworkConfiguration({ network: "testnet" });

      expect(result.status).toBe("healthy");
      expect(result.latencyMs).toBeNull();
    } finally {
      if (original !== undefined) globals.fetch = original;
    }
  });
});

describe("checkEnvironment", () => {
  it("reports healthy when fetch is available", () => {
    const result = checkEnvironment({ fetchFn: okFetch() });

    expect(result.status).toBe("healthy");
    expect(result.id).toBe("environment");
  });

  it("reports latency as null for a local check", () => {
    expect(checkEnvironment({ fetchFn: okFetch() }).latencyMs).toBeNull();
  });
});

describe("checkSdkHealth", () => {
  it("reports healthy when every dependency responds", async () => {
    const report = await checkSdkHealth({
      network: "testnet",
      fetchFn: okFetch(),
      walletAdapter: adapterStub(),
    });

    expect(report.status).toBe("healthy");
    expect(report.version).toBe(SDK_VERSION);
    expect(report.network).toBe("testnet");
    expect(report.checks).toHaveLength(4);
    expect(() => new Date(report.timestamp).toISOString()).not.toThrow();
  });

  it("reports degraded when a dependency is slow but usable", async () => {
    const report = await checkSdkHealth({
      fetchFn: okFetch(60),
      slowLatencyMs: 10,
    });

    expect(report.status).toBe("degraded");
  });

  it("reports unavailable when dependencies cannot be reached", async () => {
    const report = await checkSdkHealth({ fetchFn: rejectingFetch() });

    expect(report.status).toBe("unavailable");
  });

  it("reports unavailable when the endpoints time out", async () => {
    const report = await checkSdkHealth({
      fetchFn: hangingFetch(),
      timeoutMs: 20,
    });

    expect(report.status).toBe("unavailable");
    const horizon = report.checks.find((c) => c.id === "horizon");
    expect(horizon?.message).toContain("timed out");
  });

  it("reports unavailable for a misconfigured environment", async () => {
    const report = await checkSdkHealth({
      network: "testnet",
      fetchFn: okFetch(),
      expectedNetworkPassphrase: "wrong passphrase",
    });

    expect(report.status).toBe("unavailable");
    const config = report.checks.find((c) => c.id === "networkConfig");
    expect(config?.status).toBe("unavailable");
  });

  it("captures latency for external dependencies only", async () => {
    const report = await checkSdkHealth({
      fetchFn: okFetch(),
      walletAdapter: adapterStub(),
    });

    const horizon = report.checks.find((c) => c.id === "horizon");
    const config = report.checks.find((c) => c.id === "networkConfig");
    expect(horizon?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(config?.latencyMs).toBeNull();
  });

  it("skips the wallet check when no adapter is configured", async () => {
    const report = await checkSdkHealth({ fetchFn: okFetch() });

    const wallet = report.checks.find((c) => c.id === "walletAdapter");
    expect(wallet?.status).toBe("skipped");
    // A skipped wallet check must not drag the overall status down.
    expect(report.status).toBe("healthy");
  });

  it("does not throw when every dependency fails", async () => {
    await expect(
      checkSdkHealth({ fetchFn: rejectingFetch("total failure") }),
    ).resolves.toBeDefined();
  });

  it("queries the endpoints concurrently", async () => {
    const start = Date.now();
    await checkSdkHealth({ fetchFn: okFetch(80), slowLatencyMs: 10_000 });
    const elapsed = Date.now() - start;

    // Sequential calls would take ~160ms; concurrent ones about half that.
    expect(elapsed).toBeLessThan(150);
  });

  it("defaults the slow-latency threshold when unset", async () => {
    const report = await checkSdkHealth({ fetchFn: okFetch() });

    expect(DEFAULT_SLOW_LATENCY_MS).toBe(1500);
    expect(report.status).toBe("healthy");
  });
});

describe("runDiagnostics", () => {
  it("adds the runtime environment check on top of the health checks", async () => {
    const report = await runDiagnostics({
      fetchFn: okFetch(),
      walletAdapter: adapterStub(),
    });

    expect(report.checks).toHaveLength(5);
    expect(report.checks.some((c) => c.id === "environment")).toBe(true);
  });

  it("aggregates issues and recommendations across checks", async () => {
    const report = await runDiagnostics({
      fetchFn: rejectingFetch("network down"),
    });

    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.status).toBe("unavailable");
  });

  it("de-duplicates identical recommendations", async () => {
    const report = await runDiagnostics({
      fetchFn: rejectingFetch(),
    });

    const unique = new Set(report.recommendations);
    expect(unique.size).toBe(report.recommendations.length);
  });

  it("summarises the checks by status", async () => {
    const report = await runDiagnostics({
      fetchFn: okFetch(),
      walletAdapter: adapterStub(),
    });

    const total = (
      Object.values(report.summary) as number[]
    ).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(report.checks.length);
    expect(report.summary.healthy).toBeGreaterThan(0);
  });

  it("counts a skipped wallet check in the summary", async () => {
    const report = await runDiagnostics({ fetchFn: okFetch() });

    expect(report.summary.skipped).toBe(1);
  });

  it("reports healthy, degraded, and unavailable environments distinctly", async () => {
    const healthy = await runDiagnostics({ fetchFn: okFetch() });
    const degraded = await runDiagnostics({
      fetchFn: okFetch(60),
      slowLatencyMs: 10,
    });
    const unavailable = await runDiagnostics({ fetchFn: rejectingFetch() });

    const statuses: DiagnosticHealthStatus[] = [
      healthy.status,
      degraded.status,
      unavailable.status,
    ];
    expect(statuses).toEqual(["healthy", "degraded", "unavailable"]);
  });

  it("does not mutate application state", async () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    const signTransaction = vi.fn();

    await runDiagnostics({
      fetchFn: okFetch(),
      walletAdapter: adapterStub({ connect, disconnect, signTransaction }),
    });

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("issues only read-only requests to external dependencies", async () => {
    const fetchFn = okFetch();
    await runDiagnostics({ fetchFn });

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const init = call[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      // The only POST is the RPC's own read-only getHealth probe.
      if (method === "POST") {
        expect(String(init?.body)).toContain("getHealth");
      } else {
        expect(method).toBe("GET");
      }
    }
  });

  it("exposes no secrets in the serialised report", async () => {
    const report = await runDiagnostics({
      fetchFn: okFetch(),
      walletAdapter: adapterStub(),
    });
    const serialised = JSON.stringify(report).toLowerCase();

    for (const forbidden of ["secret", "privatekey", "private_key", "seed", "mnemonic"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("independent execution", () => {
  it("allows each check to run on its own without the aggregate report", async () => {
    const results = [
      await checkHorizonConnectivity(HORIZON, { fetchFn: okFetch() }),
      await checkSorobanRpcConnectivity(RPC, { fetchFn: okFetch() }),
      checkWalletAdapterStatus(adapterStub()),
      checkNetworkConfiguration({ network: "testnet" }),
      checkEnvironment({ fetchFn: okFetch() }),
    ];

    expect(results.map((r) => r.id)).toEqual([
      "horizon",
      "sorobanRpc",
      "walletAdapter",
      "networkConfig",
      "environment",
    ]);
    expect(results.every((r) => r.status === "healthy")).toBe(true);
  });

  it("lets a Node-only application skip the wallet check entirely", async () => {
    const report = await runDiagnostics({ fetchFn: okFetch() });

    expect(report.status).toBe("healthy");
    expect(
      report.checks.find((c) => c.id === "walletAdapter")?.status,
    ).toBe("skipped");
  });
});
