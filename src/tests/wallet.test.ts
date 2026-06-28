import { describe, it, expect, vi } from "vitest";
import {
  connectWallet,
  disconnectWallet,
  signTransaction,
  emptyWalletState,
  collectMultiSignatures,
  diagnoseWalletConnection,
} from "../wallet/index";
import {
  InMemorySigningHistoryStore,
  getSigningHistory,
  exportSigningHistory,
} from "../wallet/signingHistory";
import { FreighterAdapter } from "../wallet/adapters/freighter";
import { XBullAdapter } from "../wallet/adapters/xbull";
import { LobstrAdapter } from "../wallet/adapters/lobstr";
import { WalletType } from "../wallet/types";
import { ok, err, SorokitErrorCode } from "../shared/response";
import { createSorokitClient } from "../client/createSorokitClient";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, SWKInstance } from "../wallet/types";

function mockKit(overrides?: Partial<SWKInstance>): SWKInstance {
  return {
    getAddress: vi.fn().mockResolvedValue({
      address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
    }),
    signTransaction: vi
      .fn()
      .mockResolvedValue({ signedTxXdr: "signed-xdr-string" }),
    ...overrides,
  };
}

describe("wallet adapters", () => {
  describe("FreighterAdapter", () => {
    it("walletType is FREIGHTER", () => {
      expect(new FreighterAdapter(mockKit()).walletType).toBe(
        WalletType.FREIGHTER,
      );
    });

    it("isAvailable() returns false in Node", () => {
      expect(new FreighterAdapter(mockKit()).isAvailable()).toBe(false);
    });

    it("connect() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new FreighterAdapter(mockKit()).connect();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });

    it("disconnect() always returns status ok", async () => {
      const result = await new FreighterAdapter(mockKit()).disconnect();
      expect(result.status).toBe("ok");
    });

    it("signTransaction() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new FreighterAdapter(mockKit()).signTransaction({
        transactionXdr: "xdr",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });
  });

  describe("XBullAdapter", () => {
    it("walletType is XBULL", () => {
      expect(new XBullAdapter(mockKit()).walletType).toBe(WalletType.XBULL);
    });

    it("connect() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new XBullAdapter(mockKit()).connect();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });
  });

  describe("LobstrAdapter", () => {
    it("walletType is LOBSTR", () => {
      expect(new LobstrAdapter(mockKit()).walletType).toBe(WalletType.LOBSTR);
    });

    it("connect() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new LobstrAdapter(mockKit()).connect();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });
  });
});

describe("wallet module functions", () => {
  it("emptyWalletState() returns status ok with disconnected state", () => {
    const result = emptyWalletState();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.connected).toBe(false);
      expect(result.data.publicKey).toBeNull();
      expect(result.data.walletType).toBeNull();
    }
  });

  it("connectWallet() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
    const result = await connectWallet(new FreighterAdapter(mockKit()));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
    }
  });

  it("disconnectWallet() returns status ok with clean state", async () => {
    const result = await disconnectWallet(new FreighterAdapter(mockKit()));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.connected).toBe(false);
      expect(result.data.publicKey).toBeNull();
    }
  });

  it("signTransaction() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
    const result = await signTransaction(new FreighterAdapter(mockKit()), {
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
    }
  });

  it("signTransaction() returns WALLET_SIGN_REJECTED when adapter throws a rejection error", async () => {
    const rejectingAdapter: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      signTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")),
    };
    const result = await signTransaction(rejectingAdapter, {
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    }
  });

  it("signTransaction() returns WALLET_SIGN_FAILED when adapter throws a non-rejection error", async () => {
    const failingAdapter: WalletAdapter = {
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      signTransaction: vi.fn().mockRejectedValue(new Error("Network timeout")),
    };
    const result = await signTransaction(failingAdapter, {
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    }
  });
});

describe("collectMultiSignatures (#22)", () => {
  it("returns WALLET_SIGN_FAILED when signers list is empty", async () => {
    const result = await collectMultiSignatures("xdr-0", [], vi.fn());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    }
  });

  it("calls signFn once for a single signer and returns the signed XDR", async () => {
    const signFn = vi.fn().mockResolvedValue(ok("xdr-signed-alice"));
    const result = await collectMultiSignatures("xdr-0", ["alice"], signFn);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("xdr-signed-alice");
    }
    expect(signFn).toHaveBeenCalledOnce();
    expect(signFn).toHaveBeenCalledWith("xdr-0", "alice");
  });

  it("chains signatures for multiple signers sequentially", async () => {
    const signFn = vi
      .fn()
      .mockResolvedValueOnce(ok("xdr-after-alice"))
      .mockResolvedValueOnce(ok("xdr-after-bob"));

    const result = await collectMultiSignatures(
      "xdr-0",
      ["alice", "bob"],
      signFn,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("xdr-after-bob");
    }
    expect(signFn).toHaveBeenNthCalledWith(1, "xdr-0", "alice");
    expect(signFn).toHaveBeenNthCalledWith(2, "xdr-after-alice", "bob");
  });

  it("stops and returns the error if an intermediate signer fails", async () => {
    const signFn = vi
      .fn()
      .mockResolvedValueOnce(ok("xdr-after-alice"))
      .mockResolvedValueOnce(err(SorokitErrorCode.WALLET_SIGN_REJECTED, "Bob rejected"));

    const result = await collectMultiSignatures(
      "xdr-0",
      ["alice", "bob", "carol"],
      signFn,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    }
    expect(signFn).toHaveBeenCalledTimes(2);
  });

  it("stops immediately if the first signer fails", async () => {
    const signFn = vi
      .fn()
      .mockResolvedValue(err(SorokitErrorCode.WALLET_NOT_CONNECTED, "not connected"));

    const result = await collectMultiSignatures(
      "xdr-0",
      ["alice", "bob"],
      signFn,
    );
    expect(result.status).toBe("error");
    expect(signFn).toHaveBeenCalledOnce();
  });
});

import {
  diagnoseWalletConnection,
  detectInstalledWallets,
  prioritizeWallet,
  recommendWallets,
} from "../wallet/index";

function fakeAdapter(overrides?: Partial<WalletAdapter>): WalletAdapter {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: () => true,
    connect: async () => ok("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA"),
    disconnect: async () => ok(undefined),
    signTransaction: async () => ok("signed"),
    ...overrides,
  };
}

describe("diagnoseWalletConnection (#34)", () => {
  function find(report: { checks: { name: string; status: string }[] }, name: string) {
    return report.checks.find((c) => c.name === name);
  }

  it("reports healthy when the wallet is available and connects", async () => {
    const result = await diagnoseWalletConnection(fakeAdapter());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.healthy).toBe(true);
    expect(find(result.data, "wallet_installed")?.status).toBe("pass");
    expect(find(result.data, "extension_responsive")?.status).toBe("pass");
  });

  it("flags an unavailable wallet and skips the connection probe", async () => {
    const result = await diagnoseWalletConnection(
      fakeAdapter({ isAvailable: () => false }),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.healthy).toBe(false);
    expect(find(result.data, "wallet_installed")?.status).toBe("fail");
    expect(find(result.data, "extension_responsive")?.status).toBe("skipped");
    expect(result.data.recommendations.length).toBeGreaterThan(0);
  });

  it("reports a failing connection probe with a rejection recommendation", async () => {
    const result = await diagnoseWalletConnection(
      fakeAdapter({
        connect: async () =>
          err(SorokitErrorCode.WALLET_CONNECT_FAILED, "user rejected"),
      }),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.healthy).toBe(false);
    expect(find(result.data, "extension_responsive")?.status).toBe("fail");
    expect(result.data.recommendations.some((r) => r.includes("approve"))).toBe(true);
  });

  it("passes the network check when the endpoint is reachable", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const result = await diagnoseWalletConnection(fakeAdapter(), {
      networkUrl: "https://horizon.test",
      fetchFn,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(find(result.data, "network_connectivity")?.status).toBe("pass");
    expect(fetchFn).toHaveBeenCalledWith("https://horizon.test", { method: "GET" });
  });

  it("fails the network check when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await diagnoseWalletConnection(fakeAdapter(), {
      networkUrl: "https://horizon.test",
      fetchFn,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.healthy).toBe(false);
    expect(find(result.data, "network_connectivity")?.status).toBe("fail");
  });

  it("warns when the network endpoint returns a non-ok status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const result = await diagnoseWalletConnection(fakeAdapter(), {
      networkUrl: "https://horizon.test",
      fetchFn,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(find(result.data, "network_connectivity")?.status).toBe("warn");
  });

  it("skips the network check when no URL is provided", async () => {
    const result = await diagnoseWalletConnection(fakeAdapter());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(find(result.data, "network_connectivity")?.status).toBe("skipped");
  });

  it("skips the connection probe when probeConnection is false", async () => {
    const connect = vi.fn().mockResolvedValue(ok("G..."));
    const result = await diagnoseWalletConnection(
      fakeAdapter({ connect }),
      { probeConnection: false },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(find(result.data, "extension_responsive")?.status).toBe("skipped");
    expect(connect).not.toHaveBeenCalled();
  });
});

class SimpleCache implements SorokitCache {
  private store = new Map<string, unknown>();

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.store.set(key, value);
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

describe("wallet connection persistence and recovery", () => {
  it("connectWallet() persists state to cache after success", async () => {
    const cache = new SimpleCache();
    const adapter = fakeAdapter({
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => ok("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA"),
    });

    const result = await connectWallet(adapter, cache);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.connected).toBe(true);
      expect(result.data.publicKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
      expect(result.data.walletType).toBe(WalletType.FREIGHTER);
    }

    const cachedState = cache.get("wallet:state") as any;
    expect(cachedState).toBeDefined();
    expect(cachedState.connected).toBe(true);
    expect(cachedState.publicKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
    expect(cachedState.walletType).toBe(WalletType.FREIGHTER);
  });

  it("client creation checks cache and recovers connection state when valid", async () => {
    const cache = new SimpleCache();
    const initialWalletState = {
      connected: true,
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      walletType: WalletType.FREIGHTER,
    };
    cache.set("wallet:state", initialWalletState);

    const clientResult = createSorokitClient({ network: "testnet", cache });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const connectSpy = vi.fn().mockResolvedValue(ok("G..."));
    const adapter = fakeAdapter({
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: connectSpy,
    });

    const connResult = await client.wallet.connect(adapter);
    expect(connResult.status).toBe("ok");
    if (connResult.status === "ok") {
      expect(connResult.data.connected).toBe(true);
      expect(connResult.data.publicKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
      expect(connResult.data.walletType).toBe(WalletType.FREIGHTER);
    }

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("client validation fails when adapter is not available, returns disconnected state gracefully and clears cache", async () => {
    const cache = new SimpleCache();
    const initialWalletState = {
      connected: true,
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      walletType: WalletType.FREIGHTER,
    };
    cache.set("wallet:state", initialWalletState);

    const clientResult = createSorokitClient({ network: "testnet", cache });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const adapter = fakeAdapter({
      walletType: WalletType.FREIGHTER,
      isAvailable: () => false,
    });

    const connResult = await client.wallet.connect(adapter);
    expect(connResult.status).toBe("ok");
    if (connResult.status === "ok") {
      expect(connResult.data.connected).toBe(false);
      expect(connResult.data.publicKey).toBeNull();
      expect(connResult.data.walletType).toBeNull();
    }

    expect(cache.get("wallet:state")).toBeUndefined();
  });

  it("behaves as before when no cache is provided (backward compatibility)", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    const adapter = fakeAdapter({
      walletType: WalletType.FREIGHTER,
      isAvailable: () => true,
      connect: async () => ok("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA"),
    });

    const connResult = await client.wallet.connect(adapter);
    expect(connResult.status).toBe("ok");
    if (connResult.status === "ok") {
      expect(connResult.data.connected).toBe(true);
      expect(connResult.data.publicKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
      expect(connResult.data.walletType).toBe(WalletType.FREIGHTER);
    }
  });

  it("disconnectWallet() invalidates state in cache", async () => {
    const cache = new SimpleCache();
    const initialWalletState = {
      connected: true,
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      walletType: WalletType.FREIGHTER,
    };
    cache.set("wallet:state", initialWalletState);

    const adapter = fakeAdapter({
      walletType: WalletType.FREIGHTER,
      disconnect: async () => ok(undefined),
    });

    const result = await disconnectWallet(adapter, cache);
    expect(result.status).toBe("ok");
    expect(cache.get("wallet:state")).toBeUndefined();
  });
});

describe("detectInstalledWallets (#44)", () => {
  it("returns available:true for adapters where isAvailable() is true", () => {
    const adapter = fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER });
    const results = detectInstalledWallets([adapter]);
    expect(results).toHaveLength(1);
    expect(results[0].available).toBe(true);
    expect(results[0].walletType).toBe(WalletType.FREIGHTER);
  });

  it("returns available:false for adapters where isAvailable() is false", () => {
    const adapter = fakeAdapter({ isAvailable: () => false, walletType: WalletType.XBULL });
    const results = detectInstalledWallets([adapter]);
    expect(results[0].available).toBe(false);
  });

  it("returns features for known wallet types", () => {
    const adapter = fakeAdapter({ isAvailable: () => true, walletType: WalletType.XBULL });
    const results = detectInstalledWallets([adapter]);
    expect(results[0].features).toContain("multisig");
    expect(results[0].features).toContain("hardware");
  });

  it("handles empty adapter list", () => {
    expect(detectInstalledWallets([])).toEqual([]);
  });

  it("handles multiple adapters mixed availability", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
      fakeAdapter({ isAvailable: () => false, walletType: WalletType.LOBSTR }),
    ];
    const results = detectInstalledWallets(adapters);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.walletType === WalletType.FREIGHTER)?.available).toBe(true);
    expect(results.find((r) => r.walletType === WalletType.LOBSTR)?.available).toBe(false);
  });
});

describe("recommendWallets (#44)", () => {
  it("returns only available wallets when no criteria provided", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
      fakeAdapter({ isAvailable: () => false, walletType: WalletType.LOBSTR }),
    ];
    const results = recommendWallets(adapters);
    expect(results).toHaveLength(1);
    expect(results[0].walletType).toBe(WalletType.FREIGHTER);
  });

  it("filters by required features", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.XBULL }),
    ];
    const results = recommendWallets(adapters, { features: ["hardware"] });
    expect(results).toHaveLength(1);
    expect(results[0].walletType).toBe(WalletType.XBULL);
  });

  it("returns empty when no available wallets match criteria", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
    ];
    const results = recommendWallets(adapters, { features: ["hardware"] });
    expect(results).toHaveLength(0);
  });

  it("returns all available wallets when criteria.features is empty", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
      fakeAdapter({ isAvailable: () => true, walletType: WalletType.XBULL }),
    ];
    const results = recommendWallets(adapters, { features: [] });
    expect(results).toHaveLength(2);
  });
});

describe("prioritizeWallet (#95)", () => {
  it("returns single wallet unchanged", () => {
    const adapter = fakeAdapter({
      isAvailable: () => true,
      walletType: WalletType.FREIGHTER,
    });
    const result = prioritizeWallet([adapter]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(adapter);
  });

  it("returns empty list when no adapters supplied", () => {
    expect(prioritizeWallet([])).toEqual([]);
  });

  it("places preferred wallet first when available", () => {
    const freighter = fakeAdapter({
      isAvailable: () => true,
      walletType: WalletType.FREIGHTER,
    });
    const xbull = fakeAdapter({
      isAvailable: () => true,
      walletType: WalletType.XBULL,
    });
    const result = prioritizeWallet([freighter, xbull], WalletType.XBULL);
    expect(result[0].walletType).toBe(WalletType.XBULL);
    expect(result[1].walletType).toBe(WalletType.FREIGHTER);
  });

  it("places available wallets before unavailable ones", () => {
    const unavailable = fakeAdapter({
      isAvailable: () => false,
      walletType: WalletType.FREIGHTER,
    });
    const available = fakeAdapter({
      isAvailable: () => true,
      walletType: WalletType.XBULL,
    });
    const result = prioritizeWallet([unavailable, available]);
    expect(result[0].walletType).toBe(WalletType.XBULL);
    expect(result[1].walletType).toBe(WalletType.FREIGHTER);
  });

  it("demotes preferred wallet when it is not installed", () => {
    const freighterUnavailable = fakeAdapter({
      isAvailable: () => false,
      walletType: WalletType.FREIGHTER,
    });
    const xbullAvailable = fakeAdapter({
      isAvailable: () => true,
      walletType: WalletType.XBULL,
    });
    const result = prioritizeWallet(
      [freighterUnavailable, xbullAvailable],
      WalletType.FREIGHTER,
    );
    expect(result[0].walletType).toBe(WalletType.XBULL);
    expect(result[1].walletType).toBe(WalletType.FREIGHTER);
  });

  it("handles list where no wallets are available", () => {
    const adapters = [
      fakeAdapter({ isAvailable: () => false, walletType: WalletType.FREIGHTER }),
      fakeAdapter({ isAvailable: () => false, walletType: WalletType.XBULL }),
    ];
    const result = prioritizeWallet(adapters, WalletType.FREIGHTER);
    expect(result).toHaveLength(2);
    expect(result.every((a) => !a.isAvailable())).toBe(true);
  });
});