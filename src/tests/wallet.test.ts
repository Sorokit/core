import { describe, it, expect, vi } from "vitest";
import {
  connectWallet,
  disconnectWallet,
  signTransaction,
  emptyWalletState,
} from "../wallet/index";
import { FreighterAdapter } from "../wallet/adapters/freighter";
import { XBullAdapter } from "../wallet/adapters/xbull";
import { LobstrAdapter } from "../wallet/adapters/lobstr";
import { WalletType } from "../wallet/types";
import { SorokitErrorCode } from "../shared/response";
import type { SWKInstance } from "../wallet/types";

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
    const rejectingAdapter: import("../wallet/types").WalletAdapter = {
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
    const failingAdapter: import("../wallet/types").WalletAdapter = {
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

import { collectMultiSignatures } from "../wallet/index";
import { ok, err, SorokitErrorCode } from "../shared/response";

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
    // Each call receives the output of the previous
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
    // carol should never have been called
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

import { diagnoseWalletConnection } from "../wallet/index";
import type { WalletAdapter } from "../wallet/types";

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
    const connect = vi.fn(async () => ok("G..."));
    const result = await diagnoseWalletConnection(
      fakeAdapter({ connect }),
      { probeConnection: false },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(find(result.data, "extension_responsive")?.status).toBe("skipped");
    expect(connect).not.toHaveBeenCalled();
  });
});
