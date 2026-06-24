import { describe, it, expect, vi } from "vitest";
import {
  connectWallet,
  disconnectWallet,
  signTransaction,
  emptyWalletState,
  collectMultiSignatures,
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
});

// ── collectMultiSignatures tests (#22) ────────────────────────────────────────

import { ok, err } from "../shared/response";
import type { SignTransactionInput } from "../wallet/types";

const TESTNET = "Test SDF Network ; September 2015";

describe("collectMultiSignatures (#22)", () => {
  it("returns the signed XDR from a single signer", async () => {
    const signFn = vi.fn().mockResolvedValue(ok("signed-by-alice"));

    const result = await collectMultiSignatures(
      "unsigned-xdr",
      ["alice-pubkey"],
      signFn,
      TESTNET,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("signed-by-alice");
    }
    expect(signFn).toHaveBeenCalledOnce();
    expect(signFn).toHaveBeenCalledWith({
      transactionXdr: "unsigned-xdr",
      networkPassphrase: TESTNET,
      accountToSign: "alice-pubkey",
    } satisfies SignTransactionInput);
  });

  it("chains signatures sequentially: each signer receives the previous signed XDR", async () => {
    const signFn = vi
      .fn()
      .mockResolvedValueOnce(ok("signed-by-alice"))
      .mockResolvedValueOnce(ok("signed-by-alice-and-bob"));

    const result = await collectMultiSignatures(
      "unsigned-xdr",
      ["alice-pubkey", "bob-pubkey"],
      signFn,
      TESTNET,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("signed-by-alice-and-bob");
    }

    // First signer receives the original XDR
    expect(signFn).toHaveBeenNthCalledWith(1, {
      transactionXdr: "unsigned-xdr",
      networkPassphrase: TESTNET,
      accountToSign: "alice-pubkey",
    });
    // Second signer receives Alice's signed output
    expect(signFn).toHaveBeenNthCalledWith(2, {
      transactionXdr: "signed-by-alice",
      networkPassphrase: TESTNET,
      accountToSign: "bob-pubkey",
    });
  });

  it("stops early and returns error when a signer fails", async () => {
    const signFn = vi
      .fn()
      .mockResolvedValueOnce(ok("signed-by-alice"))
      .mockResolvedValueOnce(
        err(SorokitErrorCode.WALLET_SIGN_REJECTED, "Bob rejected"),
      );

    const result = await collectMultiSignatures(
      "unsigned-xdr",
      ["alice-pubkey", "bob-pubkey", "carol-pubkey"],
      signFn,
      TESTNET,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      expect(result.error.message).toContain("bob-pubkey");
    }
    // Carol should never have been called
    expect(signFn).toHaveBeenCalledTimes(2);
  });

  it("returns WALLET_SIGN_FAILED when signers array is empty", async () => {
    const signFn = vi.fn();

    const result = await collectMultiSignatures("xdr", [], signFn, TESTNET);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    }
    expect(signFn).not.toHaveBeenCalled();
  });
});
