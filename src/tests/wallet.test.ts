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
