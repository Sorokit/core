import { describe, it, expect, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  addSignatureToEnvelope,
  connectWallet,
  createLocalStorageAdapter,
  detectInstalledWallets,
  disconnectWallet,
  signTransaction,
  signTransactionOffline,
  emptyWalletState,
  collectMultiSignatures,
  diagnoseWalletConnection,
  prioritizeWallet,
  recommendWallets,
  removeSignatureFromEnvelope,
  createSigningChallenge,
  mergeSignatures,
} from "../wallet/index";
import {
  InMemorySigningHistoryStore,
  getSigningHistory,
  exportSigningHistory,
  type SigningRecord,
} from "../wallet/signingHistory";
import { FreighterAdapter, XBullAdapter, LobstrAdapter, RabetAdapter } from "../wallet/adapters";
import { WalletType } from "../wallet/types";
import { ok, err, SorokitErrorCode } from "../shared/response";
import { createSorokitClient } from "../client/createSorokitClient";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, SWKInstance } from "../wallet/types";

function createUnsignedEnvelopeXdr(): string {
  const source = Keypair.random();
  const transaction = new TransactionBuilder(
    new Account(source.publicKey(), "1"),
    {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    },
  )
    .addOperation(Operation.manageData({ name: "issue-118", value: "ok" }))
    .setTimeout(30)
    .build();

  return transaction.toXDR();
}

function createDecoratedSignature(
  hint = Buffer.from([1, 2, 3, 4]),
  signature = Buffer.alloc(64, 7),
): xdr.DecoratedSignature {
  return new xdr.DecoratedSignature({ hint, signature });
}

function envelopeSignatures(envelopeXdr: string): xdr.DecoratedSignature[] {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");

  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      return envelope.v0().signatures();
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().signatures();
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().signatures();
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
}

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

    it("disconnect() always returns status ok with undefined data (#291)", async () => {
      const result = await new FreighterAdapter(mockKit()).disconnect();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBeUndefined();
      }
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

    it("disconnect() always returns status ok with undefined data (#291)", async () => {
      const result = await new XBullAdapter(mockKit()).disconnect();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBeUndefined();
      }
    });

    it("signTransaction() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new XBullAdapter(mockKit()).signTransaction({
        transactionXdr: "xdr",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
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

    it("disconnect() always returns status ok with undefined data (#291)", async () => {
      const result = await new LobstrAdapter(mockKit()).disconnect();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBeUndefined();
      }
    });

    it("signTransaction() returns status error with WALLET_BROWSER_ONLY in Node", async () => {
      const result = await new LobstrAdapter(mockKit()).signTransaction({
        transactionXdr: "xdr",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });
  });

  describe("RabetAdapter", () => {
    it("walletType is RABET", () => {
      expect(new RabetAdapter(mockKit()).walletType).toBe(WalletType.RABET);
    });

    it("isAvailable() returns false in Node when un-mocked", () => {
      expect(new RabetAdapter().isAvailable()).toBe(false);
    });

    it("connect() returns status error with WALLET_BROWSER_ONLY in Node when un-mocked", async () => {
      const result = await new RabetAdapter().connect();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
      }
    });

    it("connect() succeeds and returns public key when provider resolves", async () => {
      const mockProvider = {
        connect: vi.fn().mockResolvedValue({ publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA" }),
        sign: vi.fn(),
      };
      const adapter = new RabetAdapter(mockProvider);

      const result = await adapter.connect();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA");
      }
    });

    it("connect() maps user rejection to WALLET_SIGN_REJECTED", async () => {
      const mockProvider = {
        connect: vi.fn().mockRejectedValue(new Error("User rejected the request")),
        sign: vi.fn(),
      };
      const adapter = new RabetAdapter(mockProvider);

      const result = await adapter.connect();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }
    });

    it("disconnect() returns status ok with undefined data", async () => {
      const mockProvider = {
        connect: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sign: vi.fn(),
      };
      const adapter = new RabetAdapter(mockProvider);
      const result = await adapter.disconnect();
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBeUndefined();
      }
    });

    it("signTransaction() returns signed XDR on success for testnet and mainnet", async () => {
      const mockProvider = {
        connect: vi.fn(),
        sign: vi.fn().mockResolvedValue({ xdr: "signed-xdr-rabet" }),
      };
      const adapter = new RabetAdapter(mockProvider);

      const resultTestnet = await adapter.signTransaction({
        transactionXdr: "xdr-input",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(resultTestnet.status).toBe("ok");
      if (resultTestnet.status === "ok") {
        expect(resultTestnet.data).toBe("signed-xdr-rabet");
      }

      const resultMainnet = await adapter.signTransaction({
        transactionXdr: "xdr-input",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      });
      expect(resultMainnet.status).toBe("ok");
      if (resultMainnet.status === "ok") {
        expect(resultMainnet.data).toBe("signed-xdr-rabet");
      }
    });

    it("signTransaction() maps user rejection to WALLET_SIGN_REJECTED", async () => {
      const mockProvider = {
        connect: vi.fn(),
        sign: vi.fn().mockRejectedValue(new Error("User cancelled transaction")),
      };
      const adapter = new RabetAdapter(mockProvider);

      const result = await adapter.signTransaction({
        transactionXdr: "xdr-input",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
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

  it("emptyWalletState() returns a fresh object reference on every call", () => {
    const result1 = emptyWalletState();
    const result2 = emptyWalletState();
    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status === "ok" && result2.status === "ok") {
      expect(result1).not.toBe(result2);
      expect(result1.data).not.toBe(result2.data);
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
    const adapter = new FreighterAdapter(mockKit());
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);
    const result = await disconnectWallet(adapter);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.connected).toBe(false);
      expect(result.data.publicKey).toBeNull();
      expect(result.data.walletType).toBeNull();
    }
  });

  describe("browser environment success paths (#296)", () => {
    // FreighterAdapter.isAvailable() delegates to isBrowser(). Spying on the
    // method is equivalent to mocking isBrowser for the scope of these tests
    // without perturbing the global module state for other tests.

    it("connectWallet() returns ok WalletState with full shape when adapter is available", async () => {
      const adapter = new FreighterAdapter(mockKit());
      vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

      const result = await connectWallet(adapter);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual({
          connected: true,
          publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
          walletType: WalletType.FREIGHTER,
        });
      }
    });

    it("disconnectWallet() returns ok({ connected: false, publicKey: null, walletType: null }) in browser env", async () => {
      const adapter = new FreighterAdapter(mockKit());
      vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

      const result = await disconnectWallet(adapter);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual({
          connected: false,
          publicKey: null,
          walletType: null,
        });
      }
    });
  });

  describe("connectWallet empty public key validation (#267)", () => {
    it("returns WALLET_CONNECT_FAILED when adapter resolves with ok('')", async () => {
      const adapter = new FreighterAdapter(mockKit());
      vi.spyOn(adapter, "isAvailable").mockReturnValue(true);
      vi.spyOn(adapter, "connect").mockResolvedValue(ok(""));

      const result = await connectWallet(adapter);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
        expect(result.error.message).toBe("Wallet returned an empty public key.");
      }
    });

    it("returns ok WalletState when adapter resolves with a valid key", async () => {
      const adapter = new FreighterAdapter(mockKit());
      vi.spyOn(adapter, "isAvailable").mockReturnValue(true);
      vi.spyOn(adapter, "connect").mockResolvedValue(
        ok("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA"),
      );

      const result = await connectWallet(adapter);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual({
          connected: true,
          publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
          walletType: WalletType.FREIGHTER,
        });
      }
    });
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

describe("envelope signature management (#118)", () => {
  it("adds a decorated signature to an envelope without mutating the original XDR", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const signature = createDecoratedSignature();

    const updatedXdr = addSignatureToEnvelope(envelopeXdr, signature);

    expect(updatedXdr).not.toBe(envelopeXdr);
    expect(envelopeSignatures(envelopeXdr)).toHaveLength(0);
    expect(envelopeSignatures(updatedXdr)).toHaveLength(1);
    expect(envelopeSignatures(updatedXdr)[0].hint()).toEqual(signature.hint());
  });

  it("adds a base64 decorated signature XDR to an envelope", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const signature = createDecoratedSignature(Buffer.from([4, 3, 2, 1]));
    const signatureXdr = signature.toXDR("base64");

    const updatedXdr = addSignatureToEnvelope(envelopeXdr, signatureXdr);

    expect(envelopeSignatures(updatedXdr)).toHaveLength(1);
    expect(envelopeSignatures(updatedXdr)[0].hint()).toEqual(signature.hint());
  });

  it("removes signatures that match a raw hint without mutating the original XDR", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const firstSignature = createDecoratedSignature(Buffer.from([1, 1, 1, 1]));
    const secondSignature = createDecoratedSignature(Buffer.from([2, 2, 2, 2]));
    const signedXdr = addSignatureToEnvelope(
      addSignatureToEnvelope(envelopeXdr, firstSignature),
      secondSignature,
    );

    const updatedXdr = removeSignatureFromEnvelope(
      signedXdr,
      firstSignature.hint(),
    );

    expect(envelopeSignatures(signedXdr)).toHaveLength(2);
    expect(envelopeSignatures(updatedXdr)).toHaveLength(1);
    expect(envelopeSignatures(updatedXdr)[0].hint()).toEqual(secondSignature.hint());
  });

  it("removes signatures by 8-character hex hint", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const signature = createDecoratedSignature(Buffer.from([10, 11, 12, 13]));
    const signedXdr = addSignatureToEnvelope(envelopeXdr, signature);

    const updatedXdr = removeSignatureFromEnvelope(signedXdr, "0a0b0c0d");

    expect(envelopeSignatures(updatedXdr)).toHaveLength(0);
  });

  it("rejects invalid envelope XDR before adding or removing signatures", () => {
    const signature = createDecoratedSignature();

    expect(() => addSignatureToEnvelope("not-xdr", signature)).toThrow(
      "Invalid transaction envelope XDR",
    );
    expect(() => removeSignatureFromEnvelope("not-xdr", signature.hint())).toThrow(
      "Invalid transaction envelope XDR",
    );
  });

  it("rejects invalid signatures and invalid hints", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();

    expect(() => addSignatureToEnvelope(envelopeXdr, "not-signature-xdr")).toThrow(
      "Invalid decorated signature XDR",
    );
    expect(() => removeSignatureFromEnvelope(envelopeXdr, Buffer.alloc(3))).toThrow(
      "Signature hint must be exactly 4 bytes",
    );
  });
});

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

describe("signing history export with filters (#387)", () => {
  const sampleRecords: SigningRecord[] = [
    {
      txHash: "tx1",
      signer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      timestamp: "2026-01-15T10:00:00Z",
      status: "success",
    },
    {
      txHash: "tx2",
      signer: "GBB7ZYSKSOTSOBBYRXVMQKPZDAXKL6DGRIVLCHYJRHYAQFA32WZIRB6",
      timestamp: "2026-02-01T12:00:00Z",
      status: "failure",
      error: "insufficient balance",
    },
    {
      txHash: "tx3",
      signer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      timestamp: "2026-03-01T14:30:00Z",
      status: "success",
    },
  ];

  it("exports all records to JSON format without filters", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].txHash).toBe("tx1");
    }
  });

  it("exports all records to CSV format without filters", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "csv");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const lines = result.data.split("\n");
      expect(lines[0]).toBe("txHash,signer,timestamp,status,error");
      expect(lines.length).toBe(4); // header + 3 records
    }
  });

  it("filters by signer", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json", { signer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((r: SigningRecord) => r.signer === "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA")).toBe(true);
    }
  });

  it("filters by status", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json", { status: "failure" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].status).toBe("failure");
    }
  });

  it("filters by date range (from and to)", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json", {
      from: "2026-01-20T00:00:00Z",
      to: "2026-02-20T00:00:00Z",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].txHash).toBe("tx2");
    }
  });

  it("combines multiple filters (signer and status)", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json", {
      signer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      status: "success",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((r: SigningRecord) => r.signer === "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA" && r.status === "success")).toBe(true);
    }
  });

  it("handles empty export results correctly", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json", { signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(0);
    }
  });

  it("handles empty export results in CSV format", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "csv", { signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const lines = result.data.split("\n");
      expect(lines[0]).toBe("txHash,signer,timestamp,status,error");
      expect(lines.length).toBe(1); // header only
    }
  });

  it("excludes private signing material from exports", () => {
    const store = new InMemorySigningHistoryStore();
    sampleRecords.forEach((r) => store.record(r));

    const result = exportSigningHistory(store, "json");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      // Ensure only audit-friendly fields are present
      expect(parsed[0]).toHaveProperty("txHash");
      expect(parsed[0]).toHaveProperty("signer");
      expect(parsed[0]).toHaveProperty("timestamp");
      expect(parsed[0]).toHaveProperty("status");
      // No private keys or signature bytes
      expect(parsed[0]).not.toHaveProperty("signature");
      expect(parsed[0]).not.toHaveProperty("privateKey");
    }
  });
});

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

import { listConnectedAccounts, switchAccount } from "../wallet/index";
import type { ConnectedAccountsResult, AccountSwitchResult } from "../wallet/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACCOUNT_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const ACCOUNT_B = "GBVV2ASSEN5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWWWB";
const ACCOUNT_C = "GCCCCCSSEN5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWWWC";

// ─── listConnectedAccounts ────────────────────────────────────────────────────

describe("listConnectedAccounts", () => {
  it("returns WALLET_BROWSER_ONLY when adapter is unavailable", async () => {
    const adapter = fakeAdapter({ isAvailable: () => false });
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
    }
  });

  it("falls back to single active account when getAccounts is not present", async () => {
    const adapter = fakeAdapter({
      isAvailable: () => true,
      connect: async () => ok(ACCOUNT_A),
    });
    // No getAccounts method on this adapter.
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.activeAccount).toBe(ACCOUNT_A);
      expect(result.data.accounts).toEqual([ACCOUNT_A]);
    }
  });

  it("returns all accounts from getAccounts plus the active account", async () => {
    const adapter: WalletAdapter = {
      ...fakeAdapter({
        isAvailable: () => true,
        connect: async () => ok(ACCOUNT_A),
      }),
      getAccounts: vi.fn().mockResolvedValue(ok([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C])),
    };
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.activeAccount).toBe(ACCOUNT_A);
      expect(result.data.accounts).toEqual([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
    }
  });

  it("deduplicates accounts when the active account is also returned by getAccounts", async () => {
    const adapter: WalletAdapter = {
      ...fakeAdapter({
        isAvailable: () => true,
        connect: async () => ok(ACCOUNT_A),
      }),
      // getAccounts returns ACCOUNT_A again alongside ACCOUNT_B
      getAccounts: vi.fn().mockResolvedValue(ok([ACCOUNT_A, ACCOUNT_B])),
    };
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // ACCOUNT_A must not appear twice
      expect(result.data.accounts.filter((k) => k === ACCOUNT_A)).toHaveLength(1);
      expect(result.data.accounts).toContain(ACCOUNT_B);
    }
  });

  it("propagates error when connect() fails", async () => {
    const adapter = fakeAdapter({
      isAvailable: () => true,
      connect: async () => err(SorokitErrorCode.WALLET_CONNECT_FAILED, "wallet locked"),
    });
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
    }
  });

  it("propagates error when getAccounts() fails", async () => {
    const adapter: WalletAdapter = {
      ...fakeAdapter({
        isAvailable: () => true,
        connect: async () => ok(ACCOUNT_A),
      }),
      getAccounts: vi.fn().mockResolvedValue(
        err(SorokitErrorCode.WALLET_CONNECT_FAILED, "accounts unavailable"),
      ),
    };
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
    }
  });

  it("returns a single-item accounts list when wallet only exposes the active account", async () => {
    // getAccounts returns only the active account
    const adapter: WalletAdapter = {
      ...fakeAdapter({
        isAvailable: () => true,
        connect: async () => ok(ACCOUNT_B),
      }),
      getAccounts: vi.fn().mockResolvedValue(ok([ACCOUNT_B])),
    };
    const result = await listConnectedAccounts(adapter);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.accounts).toHaveLength(1);
      expect(result.data.accounts[0]).toBe(ACCOUNT_B);
      expect(result.data.activeAccount).toBe(ACCOUNT_B);
    }
  });
});

// ─── switchAccount ────────────────────────────────────────────────────────────

describe("switchAccount", () => {
  it("returns WALLET_BROWSER_ONLY when adapter is unavailable", async () => {
    const adapter = fakeAdapter({ isAvailable: () => false });
    const result = await switchAccount(adapter, ACCOUNT_B);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_BROWSER_ONLY);
    }
  });

  it("returns WALLET_NOT_FOUND when adapter does not implement setActiveAccount", async () => {
    // fakeAdapter has no setActiveAccount
    const adapter = fakeAdapter({ isAvailable: () => true });
    const result = await switchAccount(adapter, ACCOUNT_B);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_NOT_FOUND);
      expect(result.error.message).toContain("programmatic account switching");
    }
  });

  it("returns WALLET_CONNECT_FAILED when accountKey is empty", async () => {
    const adapter: WalletAdapter = {
      ...fakeAdapter({ isAvailable: () => true }),
      setActiveAccount: vi.fn().mockResolvedValue(ok(ACCOUNT_B)),
    };
    const result = await switchAccount(adapter, "   ");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
    }
  });

  it("calls setActiveAccount with the provided key and returns a connected WalletState", async () => {
    const setActiveAccount = vi.fn().mockResolvedValue(ok(ACCOUNT_B));
    const adapter: WalletAdapter = {
      ...fakeAdapter({ isAvailable: () => true, walletType: WalletType.FREIGHTER }),
      setActiveAccount,
    };

    const result = await switchAccount(adapter, ACCOUNT_B);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.publicKey).toBe(ACCOUNT_B);
      expect(result.data.walletState.connected).toBe(true);
      expect(result.data.walletState.publicKey).toBe(ACCOUNT_B);
      expect(result.data.walletState.walletType).toBe(WalletType.FREIGHTER);
    }
    expect(setActiveAccount).toHaveBeenCalledOnce();
    expect(setActiveAccount).toHaveBeenCalledWith(ACCOUNT_B);
  });

  it("propagates error when setActiveAccount fails", async () => {
    const adapter: WalletAdapter = {
      ...fakeAdapter({ isAvailable: () => true }),
      setActiveAccount: vi.fn().mockResolvedValue(
        err(SorokitErrorCode.WALLET_SIGN_REJECTED, "user cancelled"),
      ),
    };
    const result = await switchAccount(adapter, ACCOUNT_B);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    }
  });

  it("can switch between multiple accounts in sequence", async () => {
    let activeKey = ACCOUNT_A;
    const setActiveAccount = vi.fn().mockImplementation(async (key: string) => {
      activeKey = key;
      return ok(key);
    });
    const adapter: WalletAdapter = {
      ...fakeAdapter({ isAvailable: () => true, walletType: WalletType.XBULL }),
      setActiveAccount,
    };

    const switchToB = await switchAccount(adapter, ACCOUNT_B);
    expect(switchToB.status).toBe("ok");
    if (switchToB.status === "ok") expect(switchToB.data.publicKey).toBe(ACCOUNT_B);

    const switchToC = await switchAccount(adapter, ACCOUNT_C);
    expect(switchToC.status).toBe("ok");
    if (switchToC.status === "ok") expect(switchToC.data.publicKey).toBe(ACCOUNT_C);

    expect(setActiveAccount).toHaveBeenCalledTimes(2);
    expect(activeKey).toBe(ACCOUNT_C);
  });
});

describe("signTransactionOffline (#145)", () => {
  it("signs an unsigned transaction XDR with a secret key", () => {
    const source = Keypair.random();
    const unsigned = new TransactionBuilder(
      new Account(source.publicKey(), "1"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(
        Operation.manageData({ name: "offline-sign", value: "ok" }),
      )
      .setTimeout(30)
      .build()
      .toXDR();

    const result = signTransactionOffline(
      unsigned,
      source.secret(),
      Networks.TESTNET,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.data).not.toBe(unsigned);
    expect(envelopeSignatures(result.data)).toHaveLength(1);

    const signedTx = TransactionBuilder.fromXDR(result.data, Networks.TESTNET);
    expect(signedTx.signatures).toHaveLength(1);
  });

  it("returns WALLET_SIGN_FAILED for an invalid private key", () => {
    const result = signTransactionOffline(
      createUnsignedEnvelopeXdr(),
      "not-a-secret-seed",
      Networks.TESTNET,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    expect(result.error.message).toContain("secret seed");
  });

  it("returns WALLET_SIGN_FAILED for empty XDR", () => {
    const source = Keypair.random();
    const result = signTransactionOffline(
      "  ",
      source.secret(),
      Networks.TESTNET,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    expect(result.error.message).toContain("XDR");
  });

  it("returns WALLET_SIGN_FAILED for invalid XDR", () => {
    const source = Keypair.random();
    const result = signTransactionOffline(
      "not-valid-xdr",
      source.secret(),
      Networks.TESTNET,
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
  });

  it("returns WALLET_SIGN_FAILED when network passphrase is missing", () => {
    const source = Keypair.random();
    const result = signTransactionOffline(
      createUnsignedEnvelopeXdr(),
      source.secret(),
      "   ",
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    expect(result.error.message).toContain("passphrase");
  });

  it("produces a signature that matches the source keypair hint", () => {
    const source = Keypair.random();
    const unsigned = new TransactionBuilder(
      new Account(source.publicKey(), "42"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(Operation.manageData({ name: "hint-check", value: null }))
      .setTimeout(30)
      .build()
      .toXDR();

    const result = signTransactionOffline(
      unsigned,
      source.secret(),
      Networks.TESTNET,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const signatures = envelopeSignatures(result.data);
    expect(signatures).toHaveLength(1);
    expect(Buffer.from(signatures[0]!.hint())).toEqual(
      Buffer.from(source.signatureHint()),
    );
  });
});

describe("adapter signTransaction() with browser simulation (#274)", () => {
  it("FreighterAdapter returns ok with signed XDR when isAvailable() is mocked true", async () => {
    const kit = mockKit();
    const adapter = new FreighterAdapter(kit);
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

    const result = await adapter.signTransaction({
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("signed-xdr-string");
    }
  });

  it("FreighterAdapter returns WALLET_SIGN_REJECTED when user rejects in simulated browser", async () => {
    const kit = mockKit({
      signTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")),
    });
    const adapter = new FreighterAdapter(kit);
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

    const result = await adapter.signTransaction({
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    }
  });

  it("FreighterAdapter returns WALLET_SIGN_FAILED when signing throws a non-rejection error", async () => {
    const kit = mockKit({
      signTransaction: vi.fn().mockRejectedValue(new Error("Network timeout")),
    });
    const adapter = new FreighterAdapter(kit);
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

    const result = await adapter.signTransaction({
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
    }
  });

  it("XBullAdapter returns ok with signed XDR when isAvailable() is mocked true", async () => {
    const kit = mockKit();
    const adapter = new XBullAdapter(kit);
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

    const result = await adapter.signTransaction({
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("signed-xdr-string");
    }
  });

  it("LobstrAdapter returns ok with signed XDR when isAvailable() is mocked true", async () => {
    const kit = mockKit();
    const adapter = new LobstrAdapter(kit);
    vi.spyOn(adapter, "isAvailable").mockReturnValue(true);

    const result = await adapter.signTransaction({
      transactionXdr: "some-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("signed-xdr-string");
    }
  });

  it("all three adapters route user-rejection to WALLET_SIGN_REJECTED", async () => {
    const rejectedError = new Error("User rejected the request");
    const kitFn = () =>
      mockKit({ signTransaction: vi.fn().mockRejectedValue(rejectedError) });

    const adapters = [
      new FreighterAdapter(kitFn()),
      new XBullAdapter(kitFn()),
      new LobstrAdapter(kitFn()),
    ];

    for (const adapter of adapters) {
      vi.spyOn(adapter, "isAvailable").mockReturnValue(true);
      const result = await adapter.signTransaction({
        transactionXdr: "xdr",
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }
    }
  });
});

describe("signing delegation", () => {
  it("collects partial signatures and completes when all required signers are present", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const challenge = createSigningChallenge(envelopeXdr, ["GA", "GB"], {
      expiresAt: new Date(Date.now() + 60_000),
    });

    const partial = mergeSignatures(challenge, [
      { signer: "GA", signature: createDecoratedSignature() },
    ]);
    const complete = mergeSignatures(partial.challenge, [
      {
        signer: "GB",
        signature: createDecoratedSignature(Buffer.from([4, 3, 2, 1])),
      },
    ]);

    expect(partial.complete).toBe(false);
    expect(partial.missingSigners).toEqual(["GB"]);
    expect(complete.complete).toBe(true);
    expect(envelopeSignatures(complete.transactionXdr)).toHaveLength(2);
  });

  it("rejects duplicate and expired delegated signatures", () => {
    const envelopeXdr = createUnsignedEnvelopeXdr();
    const challenge = createSigningChallenge(envelopeXdr, ["GA"], {
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(() =>
      mergeSignatures(challenge, [
        { signer: "GA", signature: createDecoratedSignature() },
        {
          signer: "GA",
          signature: createDecoratedSignature(Buffer.from([9, 9, 9, 9])),
        },
      ]),
    ).toThrow(/Duplicate signature/);

    const expired = createSigningChallenge(envelopeXdr, ["GA"], {
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(() =>
      mergeSignatures(expired, [{ signer: "GA", signature: createDecoratedSignature() }]),
    ).toThrow(/expired/);
  });
});
