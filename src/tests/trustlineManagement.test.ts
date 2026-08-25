import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const mockLoadAccount = vi.fn();

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    loadAccount: mockLoadAccount,
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

const publicKey = Keypair.random().publicKey();
const usdcIssuer = Keypair.random().publicKey();
const eurcIssuer = Keypair.random().publicKey();

const network = {
  horizonUrl: "https://example.invalid",
  networkPassphrase: Networks.TESTNET,
  sorobanRpcUrl: "https://example.invalid",
};

function horizonAccount(balances: any[]) {
  return {
    account_id: publicKey,
    accountId: () => publicKey,
    sequence: "1",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    balances,
  };
}

function operations(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

describe("validateTrustline (#402)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports native XLM as always trusted, without a Horizon call", async () => {
    const { validateTrustline } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await validateTrustline(network.horizonUrl, publicKey, {
      code: "XLM",
      issuer: null,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(true);
    }
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("reports an existing trustline with its balance and limit", async () => {
    const { validateTrustline } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(
      horizonAccount([
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: usdcIssuer,
          balance: "42.0000000",
          limit: "1000.0000000",
        },
      ]),
    );

    const result = await validateTrustline(network.horizonUrl, publicKey, {
      code: "USDC",
      issuer: usdcIssuer,
    });

    if (result.status === "error") console.log("DEBUG:", result.error);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(true);
      expect(result.data.balance).toBe("42.0000000");
      expect(result.data.limit).toBe("1000.0000000");
    }
  });

  it("reports a missing trustline as not existing", async () => {
    const { validateTrustline } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(horizonAccount([]));

    const result = await validateTrustline(network.horizonUrl, publicKey, {
      code: "USDC",
      issuer: usdcIssuer,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(false);
      expect(result.data.balance).toBeNull();
      expect(result.data.limit).toBeNull();
    }
  });

  it("rejects an invalid asset (empty code)", async () => {
    const { validateTrustline } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await validateTrustline(network.horizonUrl, publicKey, {
      code: "",
      issuer: usdcIssuer,
    });

    expect(result.status).toBe("error");
  });

  it("surfaces an account-fetch failure", async () => {
    const { validateTrustline } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockRejectedValue(new Error("not found"));

    const result = await validateTrustline(network.horizonUrl, publicKey, {
      code: "USDC",
      issuer: usdcIssuer,
    });

    expect(result.status).toBe("error");
  });
});

describe("getBulkTrustlines (#402)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks multiple assets and reports each independently", async () => {
    const { getBulkTrustlines } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(
      horizonAccount([
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: usdcIssuer,
          balance: "10.0000000",
          limit: "500.0000000",
        },
      ]),
    );

    const results = await getBulkTrustlines(network.horizonUrl, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "EURC", issuer: eurcIssuer },
      { code: "XLM", issuer: null },
    ]);

    expect(Object.keys(results)).toHaveLength(3);

    const usdcResult = results[`USDC:${usdcIssuer}`];
    expect(usdcResult?.status).toBe("ok");
    if (usdcResult?.status === "ok") {
      expect(usdcResult.data.exists).toBe(true);
      expect(usdcResult.data.balance).toBe("10.0000000");
    }

    const eurcResult = results[`EURC:${eurcIssuer}`];
    expect(eurcResult?.status).toBe("ok");
    if (eurcResult?.status === "ok") {
      expect(eurcResult.data.exists).toBe(false);
    }

    const xlmResult = results["XLM:native"];
    expect(xlmResult?.status).toBe("ok");
    if (xlmResult?.status === "ok") {
      expect(xlmResult.data.exists).toBe(true);
    }
  });

  it("performs lookups concurrently (a single account load serves every asset)", async () => {
    const { getBulkTrustlines } = await import(
      "../transaction/trustlineManagement"
    );

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    mockLoadAccount.mockImplementation(async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 5));
      concurrentCalls--;
      return horizonAccount([]);
    });

    await getBulkTrustlines(network.horizonUrl, publicKey, [
      { code: "A1", issuer: usdcIssuer },
      { code: "A2", issuer: usdcIssuer },
      { code: "A3", issuer: usdcIssuer },
    ]);

    // A single account load serves every asset — proving assets are
    // resolved from one shared fetch rather than N sequential Horizon
    // round trips (one per asset).
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated assets in the request", async () => {
    const { getBulkTrustlines } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(horizonAccount([]));

    const results = await getBulkTrustlines(network.horizonUrl, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "USDC", issuer: usdcIssuer },
    ]);

    expect(Object.keys(results)).toHaveLength(1);
  });

  it("reflects an account-fetch failure for every requested asset", async () => {
    const { getBulkTrustlines } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockRejectedValue(new Error("horizon down"));

    const results = await getBulkTrustlines(network.horizonUrl, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "EURC", issuer: eurcIssuer },
    ]);

    expect(results[`USDC:${usdcIssuer}`]?.status).toBe("error");
    expect(results[`EURC:${eurcIssuer}`]?.status).toBe("error");
  });

  it("isolates a malformed individual asset without failing the whole batch", async () => {
    const { getBulkTrustlines } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(
      horizonAccount([
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: usdcIssuer,
          balance: "5.0000000",
          limit: "500",
        },
      ]),
    );

    const results = await getBulkTrustlines(network.horizonUrl, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "", issuer: eurcIssuer }, // malformed
    ]);

    expect(results[`USDC:${usdcIssuer}`]?.status).toBe("ok");
    expect(results[`:${eurcIssuer}`]?.status).toBe("error");
  });
});

describe("buildBulkTrustlineTransaction (#402)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs multiple trustline operations in a single transaction", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(horizonAccount([]));

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [
          { asset: { code: "USDC", issuer: usdcIssuer } },
          { asset: { code: "EURC", issuer: eurcIssuer } },
        ],
      },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = operations(result.data);
      expect(ops).toHaveLength(2);
      expect(ops.every((op) => op.type === "changeTrust")).toBe(true);
    }
  });

  it("respects a provided trust limit, including removal via limit '0'", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(horizonAccount([]));

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [{ asset: { code: "USDC", issuer: usdcIssuer }, limit: "0" }],
      },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = operations(result.data);
      if (ops[0]?.type === "changeTrust") {
        expect(ops[0].limit).toBe("0.0000000");
      }
    }
  });

  it("validates asset inputs before construction", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [{ asset: { code: "", issuer: usdcIssuer } }],
      },
    );

    expect(result.status).toBe("error");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("rejects native XLM as a trustline target", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [{ asset: { code: "XLM", issuer: null } }],
      },
    );

    expect(result.status).toBe("error");
  });

  it("rejects an empty operations list", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      { sourcePublicKey: publicKey, operations: [] },
    );

    expect(result.status).toBe("error");
  });

  it("handles a duplicate trustline entry by deduplicating (keeping the last)", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    mockLoadAccount.mockResolvedValue(horizonAccount([]));

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [
          { asset: { code: "USDC", issuer: usdcIssuer }, limit: "100" },
          { asset: { code: "USDC", issuer: usdcIssuer }, limit: "200" },
        ],
      },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ops = operations(result.data);
      expect(ops).toHaveLength(1);
      if (ops[0]?.type === "changeTrust") {
        expect(ops[0].limit).toBe("200.0000000");
      }
    }
  });

  it("respects the Stellar 100-operations-per-transaction limit", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    const manyOperations = Array.from({ length: 101 }, (_, i) => ({
      asset: { code: `A${i}`.slice(0, 4), issuer: usdcIssuer },
    }));

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      { sourcePublicKey: publicKey, operations: manyOperations },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("exceed the maximum");
    }
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("builds offline when a sequence number is supplied, without a Horizon call", async () => {
    const { buildBulkTrustlineTransaction } = await import(
      "../transaction/trustlineManagement"
    );

    const result = await buildBulkTrustlineTransaction(
      network.horizonUrl,
      network,
      {
        sourcePublicKey: publicKey,
        operations: [{ asset: { code: "USDC", issuer: usdcIssuer } }],
        sequenceNumber: "42",
      },
    );

    expect(result.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});
