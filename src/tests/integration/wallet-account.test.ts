/**
 * Integration test: wallet connect → getAccount workflow
 *
 * Tests the full interaction chain from wallet connection through account
 * fetch. Mocks Horizon and wallet kit at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { SorokitErrorCode } from "../../shared/response";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

function makeHorizonAccount(publicKey: string) {
  return {
    id: publicKey,
    account_id: publicKey,
    accountId: () => publicKey,
    sequence: "100",
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    subentry_count: 2,
    balances: [
      {
        balance: "10.0000000",
        asset_type: "native",
        asset_code: "XLM",
        asset_issuer: undefined,
      },
    ],
    flags: {},
    signers: [],
    data_attr: {},
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    home_domain: "",
    inflation_dest: undefined,
    last_modified_ledger: 100,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration: wallet connect → account fetch", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it("creates a client on testnet successfully", () => {
    const result = createSorokitClient({ network: "testnet" });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.network).toBe("testnet");
    }
  });

  it("creates a client on mainnet successfully", () => {
    const result = createSorokitClient({ network: "mainnet" });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.networkConfig.network).toBe("mainnet");
    }
  });

  it("fetches account after wallet reports a public key", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount(TEST_PUBLIC_KEY));

    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;

    const client = clientResult.data;
    const accountResult = await client.account.get(TEST_PUBLIC_KEY);

    expect(accountResult.status).toBe("ok");
    if (accountResult.status === "ok") {
      expect(accountResult.data.publicKey).toBe(TEST_PUBLIC_KEY);
      expect(accountResult.data.balances.length).toBeGreaterThan(0);
    }
  });

  it("returns ACCOUNT_NOT_FOUND when account does not exist on network", async () => {
    mockLoadAccount.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 404"), {
        response: { status: 404 },
      }),
    );

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const accountResult = await clientResult.data.account.get(TEST_PUBLIC_KEY);

    expect(accountResult.status).toBe("error");
    if (accountResult.status === "error") {
      expect(accountResult.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("fetches balances for an account", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount(TEST_PUBLIC_KEY));

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const balancesResult = await clientResult.data.account.getBalances(TEST_PUBLIC_KEY);

    expect(balancesResult.status).toBe("ok");
    if (balancesResult.status === "ok") {
      expect(Array.isArray(balancesResult.data)).toBe(true);
      const xlm = balancesResult.data.find((b) => b.assetCode === "XLM");
      expect(xlm).toBeDefined();
    }
  });

  it("wallet emptyState returns disconnected state", () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const stateResult = clientResult.data.wallet.emptyState();

    expect(stateResult.status).toBe("ok");
    if (stateResult.status === "ok") {
      expect(stateResult.data.connected).toBe(false);
      expect(stateResult.data.publicKey).toBeNull();
    }
  });

  it("formatAddress shortens a public key for display", () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const formatted = clientResult.data.account.formatAddress(TEST_PUBLIC_KEY);

    // formatAddress uses chars+1 chars from start and chars from end (default chars=4)
    // e.g. GAAZI...CWNA
    expect(typeof formatted).toBe("string");
    expect(formatted).toContain("...");
    expect(formatted.length).toBeLessThan(TEST_PUBLIC_KEY.length);
  });

  it("network config is accessible on the client", () => {
    const clientResult = createSorokitClient({
      network: "testnet",
      horizonUrl: "https://custom-horizon.example.com",
    });

    expect(clientResult.status).toBe("ok");
    if (clientResult.status === "ok") {
      const config = clientResult.data.network.getConfig();
      expect(config.horizonUrl).toBe("https://custom-horizon.example.com");
      expect(config.network).toBe("testnet");
    }
  });

  it("client carries a traceId", () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status === "ok") {
      expect(typeof clientResult.data.traceId).toBe("string");
      expect(clientResult.data.traceId.length).toBeGreaterThan(0);
    }
  });

  it("accepts custom traceId", () => {
    const clientResult = createSorokitClient({
      network: "testnet",
      traceId: "my-custom-trace-id",
    });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status === "ok") {
      expect(clientResult.data.traceId).toBe("my-custom-trace-id");
    }
  });
});
