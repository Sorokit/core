import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSorokitClient } from "../client/createSorokitClient";
import { SorokitErrorCode, err, ok } from "../shared/response";
import { WalletType } from "../wallet/types";
import type { WalletAdapter } from "../wallet/types";

const { mockEstimateFee } = vi.hoisted(() => ({
  mockEstimateFee: vi.fn(),
}));

vi.mock("../transaction/estimateFee", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../transaction/estimateFee")>();
  return {
    ...actual,
    estimateFee: mockEstimateFee,
  };
});

const { mockStreamTransactions } = vi.hoisted(() => ({
  mockStreamTransactions: vi.fn(),
}));

vi.mock("../transaction/streamTransactions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../transaction/streamTransactions")>();
  return {
    ...actual,
    streamTransactions: mockStreamTransactions,
  };
});

const { mockSimulateTransaction } = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
}));

vi.mock("../soroban/simulateTransaction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../soroban/simulateTransaction")>();
  return {
    ...actual,
    simulateTransaction: mockSimulateTransaction,
  };
});

const { mockPrepareContractCall } = vi.hoisted(() => ({
  mockPrepareContractCall: vi.fn(),
}));

vi.mock("../soroban/prepareCall", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../soroban/prepareCall")>();
  return {
    ...actual,
    prepareContractCall: mockPrepareContractCall,
  };
});

const { mockExecuteContract } = vi.hoisted(() => ({
  mockExecuteContract: vi.fn(),
}));

vi.mock("../soroban/executeContract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../soroban/executeContract")>();
  return {
    ...actual,
    executeContract: mockExecuteContract,
  };
});

const { mockInvokeContract } = vi.hoisted(() => ({
  mockInvokeContract: vi.fn(),
}));

vi.mock("../soroban/invokeContract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../soroban/invokeContract")>();
  return {
    ...actual,
    invokeContract: mockInvokeContract,
  };
});

const { mockReadContract } = vi.hoisted(() => ({
  mockReadContract: vi.fn(),
}));

vi.mock("../soroban/readContract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../soroban/readContract")>();
  return {
    ...actual,
    readContract: mockReadContract,
  };
});

describe("createSorokitClient", () => {
  it("creates a client for testnet", () => {
    const result = createSorokitClient({ network: "testnet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const client = result.data;
      expect(client.networkConfig.network).toBe("testnet");
      // wallet namespace
      expect(typeof client.wallet.connect).toBe("function");
      expect(typeof client.wallet.disconnect).toBe("function");
      expect(typeof client.wallet.signTransaction).toBe("function");
      expect(typeof client.wallet.emptyState).toBe("function");
      // account namespace
      expect(typeof client.account.get).toBe("function");
      expect(typeof client.account.getAccountsBatch).toBe("function");
      expect(typeof client.account.getBalances).toBe("function");
      expect(typeof client.account.stream).toBe("function"); // #85
      expect(typeof client.account.formatAddress).toBe("function");
      expect(typeof client.account.isValidPublicKey).toBe("function"); // #293
      expect(typeof client.account.isValidContractId).toBe("function"); // #293
      // transaction namespace
      expect(typeof client.transaction.buildPayment).toBe("function");
      expect(typeof client.transaction.buildCreateAccount).toBe("function");
      expect(typeof client.transaction.buildTrustline).toBe("function");
      expect(typeof client.transaction.submit).toBe("function");
      expect(typeof client.transaction.getStatus).toBe("function");
      expect(typeof client.transaction.stream).toBe("function"); // #86
      // soroban namespace
      expect(typeof client.soroban.getContractMethods).toBe("function");
      expect(typeof client.soroban.simulate).toBe("function");
      expect(typeof client.soroban.prepare).toBe("function");
      expect(typeof client.soroban.execute).toBe("function");
      expect(typeof client.soroban.invoke).toBe("function");
      expect(typeof client.soroban.read).toBe("function");
      // network namespace
      expect(typeof client.network.getConfig).toBe("function");
    }
  });

  it("creates a client for mainnet", () => {
    const result = createSorokitClient({ network: "mainnet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.horizonUrl).toBe(
        "https://horizon.stellar.org",
      );
    }
  });

  it("creates a client for futurenet", () => {
    const result = createSorokitClient({ network: "futurenet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.network).toBe("futurenet");
    }
  });

  it("applies custom horizonUrl override", () => {
    const result = createSorokitClient({
      network: "testnet",
      horizonUrl: "https://custom-horizon.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.horizonUrl).toBe(
        "https://custom-horizon.example.com",
      );
    }
  });

  it("applies custom rpcUrl override", () => {
    const result = createSorokitClient({
      network: "testnet",
      rpcUrl: "https://custom-rpc.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.rpcUrl).toBe(
        "https://custom-rpc.example.com",
      );
    }
  });

  it("returns status error for invalid network", () => {
    // @ts-expect-error — intentionally testing invalid input
    const result = createSorokitClient({ network: "badnet" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
    }
  });

  describe("sorobanPoll validation (#285)", () => {
    it("returns CONTRACT_INVOKE_FAILED when maxAttempts is 0 or negative", () => {
      const res0 = createSorokitClient({
        network: "testnet",
        sorobanPoll: { maxAttempts: 0 },
      });
      expect(res0.status).toBe("error");
      if (res0.status === "error") {
        expect(res0.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
        expect(res0.error.message).toBe("sorobanPoll.maxAttempts must be a positive integer.");
      }

      const resNeg = createSorokitClient({
        network: "testnet",
        sorobanPoll: { maxAttempts: -5 },
      });
      expect(resNeg.status).toBe("error");
      if (resNeg.status === "error") {
        expect(resNeg.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
      }
    });

    it("returns CONTRACT_INVOKE_FAILED when intervalMs is negative", () => {
      const resNeg = createSorokitClient({
        network: "testnet",
        sorobanPoll: { intervalMs: -100 },
      });
      expect(resNeg.status).toBe("error");
      if (resNeg.status === "error") {
        expect(resNeg.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
        expect(resNeg.error.message).toBe("sorobanPoll.intervalMs must be a non-negative number.");
      }
    });

    it("creates client successfully with valid sorobanPoll override", () => {
      const res = createSorokitClient({
        network: "testnet",
        sorobanPoll: { maxAttempts: 10, intervalMs: 2000 },
      });
      expect(res.status).toBe("ok");
    });
  });

  describe("createSorokitClient required config validation (#755)", () => {
    it("returns INVALID_CONFIG when configuration object is missing (null or undefined)", () => {
      // @ts-expect-error — intentionally passing invalid config
      const resNull = createSorokitClient(null);
      expect(resNull.status).toBe("error");
      if (resNull.status === "error") {
        expect(resNull.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resNull.error.message).toContain("Configuration must be an object");
      }

      // @ts-expect-error — intentionally passing invalid config
      const resUndef = createSorokitClient(undefined);
      expect(resUndef.status).toBe("error");
      if (resUndef.status === "error") {
        expect(resUndef.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resUndef.error.message).toContain("Configuration must be an object");
      }
    });

    it("returns error when network is missing or invalid", () => {
      // @ts-expect-error — missing required network
      const resMissing = createSorokitClient({});
      expect(resMissing.status).toBe("error");
      if (resMissing.status === "error") {
        expect(resMissing.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
        expect(resMissing.error.message).toContain("network");
      }

      // @ts-expect-error — invalid network string
      const resInvalid = createSorokitClient({ network: "invalid-net" });
      expect(resInvalid.status).toBe("error");
      if (resInvalid.status === "error") {
        expect(resInvalid.error.code).toBe(SorokitErrorCode.INVALID_NETWORK);
        expect(resInvalid.error.message).toContain("Invalid network type: invalid-net");
      }
    });

    it("returns INVALID_CONFIG when horizonUrl is invalid", () => {
      const resEmpty = createSorokitClient({
        network: "testnet",
        horizonUrl: "",
      });
      expect(resEmpty.status).toBe("error");
      if (resEmpty.status === "error") {
        expect(resEmpty.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resEmpty.error.message).toContain("horizonUrl");
      }

      const resMalformed = createSorokitClient({
        network: "testnet",
        horizonUrl: "ftp://not-http-url",
      });
      expect(resMalformed.status).toBe("error");
      if (resMalformed.status === "error") {
        expect(resMalformed.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resMalformed.error.message).toContain("horizonUrl");
      }

      // @ts-expect-error — non-string type
      const resType = createSorokitClient({
        network: "testnet",
        horizonUrl: 12345,
      });
      expect(resType.status).toBe("error");
      if (resType.status === "error") {
        expect(resType.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resType.error.message).toContain("horizonUrl");
      }
    });

    it("returns INVALID_CONFIG when rpcUrl is invalid", () => {
      const resEmpty = createSorokitClient({
        network: "testnet",
        rpcUrl: "",
      });
      expect(resEmpty.status).toBe("error");
      if (resEmpty.status === "error") {
        expect(resEmpty.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resEmpty.error.message).toContain("rpcUrl");
      }

      const resMalformed = createSorokitClient({
        network: "testnet",
        rpcUrl: "not-a-valid-url",
      });
      expect(resMalformed.status).toBe("error");
      if (resMalformed.status === "error") {
        expect(resMalformed.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resMalformed.error.message).toContain("rpcUrl");
      }

      // @ts-expect-error — non-string type
      const resType = createSorokitClient({
        network: "testnet",
        rpcUrl: true,
      });
      expect(resType.status).toBe("error");
      if (resType.status === "error") {
        expect(resType.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resType.error.message).toContain("rpcUrl");
      }
    });

    it("returns INVALID_CONFIG when networkPassphrase is empty or invalid", () => {
      const resEmpty = createSorokitClient({
        network: "testnet",
        networkPassphrase: "",
      });
      expect(resEmpty.status).toBe("error");
      if (resEmpty.status === "error") {
        expect(resEmpty.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resEmpty.error.message).toContain("networkPassphrase");
      }

      const resWhitespace = createSorokitClient({
        network: "testnet",
        networkPassphrase: "   ",
      });
      expect(resWhitespace.status).toBe("error");
      if (resWhitespace.status === "error") {
        expect(resWhitespace.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resWhitespace.error.message).toContain("networkPassphrase");
      }

      // @ts-expect-error — non-string type
      const resType = createSorokitClient({
        network: "testnet",
        networkPassphrase: 12345,
      });
      expect(resType.status).toBe("error");
      if (resType.status === "error") {
        expect(resType.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
        expect(resType.error.message).toContain("networkPassphrase");
      }
    });

    it("allows valid networkPassphrase override and binds it to client", () => {
      const customPassphrase = "Custom Private Network ; 2026";
      const result = createSorokitClient({
        network: "testnet",
        networkPassphrase: customPassphrase,
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.networkConfig.networkPassphrase).toBe(customPassphrase);
        expect(result.data.network.getConfig().networkPassphrase).toBe(customPassphrase);
      }
    });
  });

  it("exposes version property matching package version", () => {
    const result = createSorokitClient({ network: "testnet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.version).toBe("0.1.0");
    }
  });

  it("network.getConfig() returns the resolved config", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const config = result.data.network.getConfig();
      expect(config).toEqual(result.data.networkConfig);
    }
  });

  it("network.getId() returns the network identifier string", () => {
    const testnetClient = createSorokitClient({ network: "testnet" });
    if (testnetClient.status === "ok") {
      expect(testnetClient.data.network.getId()).toBe("testnet");
    }

    const mainnetClient = createSorokitClient({ network: "mainnet" });
    if (mainnetClient.status === "ok") {
      expect(mainnetClient.data.network.getId()).toBe("mainnet");
    }

    const futurenetClient = createSorokitClient({ network: "futurenet" });
    if (futurenetClient.status === "ok") {
      expect(futurenetClient.data.network.getId()).toBe("futurenet");
    }
  });

  it("wallet.emptyState() returns status ok with disconnected state", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const state = result.data.wallet.emptyState();
      expect(state.status).toBe("ok");
      if (state.status === "ok") {
        expect(state.data.connected).toBe(false);
        expect(state.data.publicKey).toBeNull();
        expect(state.data.walletType).toBeNull();
      }
    }
  });

  it("account.formatAddress() shortens a public key (raw string)", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const formatted = result.data.account.formatAddress(key);
      // Pure utility — returns string directly, not SorokitResult
      expect(typeof formatted).toBe("string");
      expect(formatted).toContain("...");
    }
  });

  it("account.isValidPublicKey validates well-formed and malformed public keys (#293)", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const validKey = "GHOV4DKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2B";
      expect(result.data.account.isValidPublicKey(validKey)).toBe(true);
      expect(result.data.account.isValidPublicKey("not-a-key")).toBe(false);
    }
  });

  it("account.isValidContractId validates well-formed and malformed contract ids (#293)", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const validContractId = "CHOV4DKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2B";
      expect(result.data.account.isValidContractId(validContractId)).toBe(true);
      expect(result.data.account.isValidContractId("not-a-contract")).toBe(false);
    }
  });

  it("soroban exposes the full prepare → execute pipeline", () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      expect(typeof result.data.soroban.getContractMethods).toBe("function");
      expect(typeof result.data.soroban.prepare).toBe("function");
      expect(typeof result.data.soroban.execute).toBe("function");
      expect(typeof result.data.soroban.invoke).toBe("function");
    }
  });

  it("account.stream returns an async generator", async () => {
    const result = createSorokitClient({ network: "testnet" });
    if (result.status === "ok") {
      const stream = result.data.account.stream("GTEST...", { maxPolls: 1 });
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");
      // Consume one iteration to verify it's a working generator
      await stream.next();
    }
  });

  it("transaction.estimateFee delegates to estimateFee() with rpcUrl, horizonUrl, and networkConfig in order (#294)", async () => {
    mockEstimateFee.mockReset();
    mockEstimateFee.mockResolvedValue(
      ok({
        fee: "100",
        feeFloat: 100,
        feeXlm: "0.0000100",
        baseFee: "100",
        simulated: false,
      }),
    );

    const result = createSorokitClient({ network: "testnet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const input = { kind: "xdr" as const, transactionXdr: "AAAA" };
      const res = await result.data.transaction.estimateFee(input);

      expect(res.status).toBe("ok");
      expect(mockEstimateFee).toHaveBeenCalledOnce();
      const call = mockEstimateFee.mock.calls[0];
      // Wiring order matters — a swap here would silently misconfigure the estimate.
      expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
      expect(call[1]).toBe(result.data.networkConfig.horizonUrl);
      expect(call[2]).toBe(result.data.networkConfig);
      expect(call[3]).toBe(input);
    }
  });

  it("transaction.stream delegates to streamTransactions() with horizonUrl and publicKey (#294)", async () => {
    mockStreamTransactions.mockReset();
    mockStreamTransactions.mockImplementation(async function* () {
      yield ok({ transactions: [], nextCursor: null });
    });

    const result = createSorokitClient({ network: "testnet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const streamConfig = { maxPolls: 1 };
      const stream = result.data.transaction.stream("GTEST...", streamConfig);
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");

      const { value } = await stream.next();
      expect(value?.status).toBe("ok");

      expect(mockStreamTransactions).toHaveBeenCalledOnce();
      const call = mockStreamTransactions.mock.calls[0];
      expect(call[0]).toBe(result.data.networkConfig.horizonUrl);
      expect(call[1]).toBe("GTEST...");
      expect(call[2]).toBe(streamConfig);
    }
  });

  it("wallet.connect propagates error from failing adapter", async () => {
    const clientRes = createSorokitClient({ network: "testnet" });
    expect(clientRes.status).toBe("ok");
    if (clientRes.status === "ok") {
      const mockFailingAdapter: WalletAdapter = {
        walletType: WalletType.FREIGHTER,
        isAvailable: () => true,
        connect: async () => err(SorokitErrorCode.WALLET_CONNECT_FAILED, "Connect failed"),
        disconnect: async () => ok(undefined),
        signTransaction: async () => err(SorokitErrorCode.WALLET_SIGN_FAILED, "Sign failed"),
      };
      const res = await clientRes.data.wallet.connect(mockFailingAdapter);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
      }
    }
  });

  it("wallet.signTransaction propagates WALLET_SIGN_REJECTED error", async () => {
    const clientRes = createSorokitClient({ network: "testnet" });
    expect(clientRes.status).toBe("ok");
    if (clientRes.status === "ok") {
      const mockRejectingAdapter: WalletAdapter = {
        walletType: WalletType.FREIGHTER,
        isAvailable: () => true,
        connect: async () => ok("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        disconnect: async () => ok(undefined),
        signTransaction: async () => err(SorokitErrorCode.WALLET_SIGN_REJECTED, "User rejected"),
      };
      const res = await clientRes.data.wallet.signTransaction(mockRejectingAdapter, { xdr: "AAAA" });
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }
    }
  });

  // ── URL validation ────────────────────────────────────────────────────

  it("rejects empty horizonUrl override", () => {
    const result = createSorokitClient({
      network: "testnet",
      horizonUrl: "",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    }
  });

  it("rejects invalid horizonUrl override (not-a-url)", () => {
    const result = createSorokitClient({
      network: "testnet",
      horizonUrl: "not-a-url",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    }
  });

  it("rejects empty rpcUrl override", () => {
    const result = createSorokitClient({
      network: "testnet",
      rpcUrl: "",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    }
  });

  it("rejects invalid rpcUrl override (not-a-url)", () => {
    const result = createSorokitClient({
      network: "testnet",
      rpcUrl: "not-a-url",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
    }
  });

  it("accepts http:// horizonUrl", () => {
    const result = createSorokitClient({
      network: "testnet",
      horizonUrl: "http://localhost:8000",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.horizonUrl).toBe("http://localhost:8000");
    }
  });

  it("accepts https:// rpcUrl", () => {
    const result = createSorokitClient({
      network: "testnet",
      rpcUrl: "https://my-rpc.example.com",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.rpcUrl).toBe("https://my-rpc.example.com");
    }
  });

  it("accepts undefined horizonUrl (uses default)", () => {
    const result = createSorokitClient({
      network: "testnet",
      horizonUrl: undefined,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.horizonUrl).toBe(
        "https://horizon-testnet.stellar.org",
      );
    }
  });

  it("account.get returns ACCOUNT_NOT_FOUND when Horizon returns 404", async () => {
    const clientRes = createSorokitClient({
      network: "testnet",
      horizonUrl: "https://horizon-404-test.example.com",
      fetchFn: async () => new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }),
    });
    expect(clientRes.status).toBe("ok");
    if (clientRes.status === "ok") {
      const res = await clientRes.data.account.get("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      }
    }
  });

  it("account.getBalances propagates error when getAccount fails", async () => {
    const clientRes = createSorokitClient({
      network: "testnet",
      horizonUrl: "https://horizon-404-test.example.com",
      fetchFn: async () => new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }),
    });
    expect(clientRes.status).toBe("ok");
    if (clientRes.status === "ok") {
      const res = await clientRes.data.account.getBalances("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      }
    }
  });

  describe("soroban method wiring (#284)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("client.soroban.simulate(xdr) calls simulateTransaction with rpcUrl and networkPassphrase", async () => {
      mockSimulateTransaction.mockReset();
      mockSimulateTransaction.mockResolvedValue(ok({ fee: "100", success: true }));

      const result = createSorokitClient({ network: "testnet" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const xdr = "AAAAAQAAAA==";
        const res = await result.data.soroban.simulate(xdr);

        expect(res.status).toBe("ok");
        expect(mockSimulateTransaction).toHaveBeenCalledOnce();
        const call = mockSimulateTransaction.mock.calls[0];
        expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
        expect(call[1]).toBe(result.data.networkConfig.networkPassphrase);
        expect(call[2]).toBe(xdr);
      }
    });

    it("client.soroban.prepare(params) calls prepareContractCall with rpcUrl, networkConfig, horizonUrl, params", async () => {
      mockPrepareContractCall.mockReset();
      mockPrepareContractCall.mockResolvedValue(ok({ transactionXdr: "AAAA", fee: "1000" }));

      const result = createSorokitClient({ network: "testnet" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const params = {
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2B",
          publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          method: "transfer",
          args: [],
        };
        const res = await result.data.soroban.prepare(params);

        expect(res.status).toBe("ok");
        expect(mockPrepareContractCall).toHaveBeenCalledOnce();
        const call = mockPrepareContractCall.mock.calls[0];
        expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
        expect(call[1]).toBe(result.data.networkConfig);
        expect(call[2]).toBe(result.data.networkConfig.horizonUrl);
        expect(call[3]).toBe(params);
      }
    });

    it("client.soroban.execute(xdr) calls executeContract with rpcUrl, networkConfig, signedXdr, pollConfig", async () => {
      mockExecuteContract.mockReset();
      mockExecuteContract.mockResolvedValue(ok("txhash123"));

      const result = createSorokitClient({ network: "testnet" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const signedXdr = "AAAAAQAAAA==";
        const pollConfig = { maxAttempts: 5, intervalMs: 1000 };
        const res = await result.data.soroban.execute(signedXdr, pollConfig);

        expect(res.status).toBe("ok");
        expect(mockExecuteContract).toHaveBeenCalledOnce();
        const call = mockExecuteContract.mock.calls[0];
        expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
        expect(call[1]).toBe(result.data.networkConfig);
        expect(call[2]).toBe(signedXdr);
        expect(call[3]).toBe(pollConfig);
      }
    });

    it("client.soroban.invoke(params, signFn) calls invokeContract with rpcUrl, networkConfig, horizonUrl, params, signFn", async () => {
      mockInvokeContract.mockReset();
      mockInvokeContract.mockResolvedValue(ok("txhash456"));

      const result = createSorokitClient({ network: "testnet" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const params = {
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2B",
          publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          method: "transfer",
          args: [],
        };
        const signFn = async (xdr: string) => `SIGNED_${xdr}`;
        const res = await result.data.soroban.invoke(params, signFn);

        expect(res.status).toBe("ok");
        expect(mockInvokeContract).toHaveBeenCalledOnce();
        const call = mockInvokeContract.mock.calls[0];
        expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
        expect(call[1]).toBe(result.data.networkConfig);
        expect(call[2]).toBe(result.data.networkConfig.horizonUrl);
        expect(call[3]).toEqual(expect.objectContaining({
          contractId: params.contractId,
          publicKey: params.publicKey,
          method: params.method,
        }));
        expect(call[4]).toBe(signFn);
      }
    });

    it("client.soroban.read(params) calls readContract with rpcUrl, horizonUrl, networkConfig, params", async () => {
      mockReadContract.mockReset();
      mockReadContract.mockResolvedValue(ok({ result: {}, value: "42" }));

      const result = createSorokitClient({ network: "testnet" });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const params = {
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2B",
          publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          method: "balance",
          args: [],
        };
        const res = await result.data.soroban.read(params);

        expect(res.status).toBe("ok");
        expect(mockReadContract).toHaveBeenCalledOnce();
        const call = mockReadContract.mock.calls[0];
        expect(call[0]).toBe(result.data.networkConfig.rpcUrl);
        expect(call[1]).toBe(result.data.networkConfig.horizonUrl);
        expect(call[2]).toBe(result.data.networkConfig);
        expect(call[3]).toEqual(expect.objectContaining({
          contractId: params.contractId,
          publicKey: params.publicKey,
          method: params.method,
        }));
      }
    });
  });
});
