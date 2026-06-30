/**
 * Integration test: buildPayment → sign → submit workflow
 *
 * Tests the multi-step transaction flow: build a payment transaction XDR,
 * sign it via a wallet adapter, then submit it to Horizon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { SorokitErrorCode } from "../../shared/response";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockLoadAccount, mockSubmitTransaction, mockTransactionCall } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockSubmitTransaction: vi.fn(),
  mockTransactionCall: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  fromXDR: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  const mockAsset = vi.fn().mockImplementation((code: string, issuer?: string) => ({
    code,
    issuer: issuer ?? null,
  }));
  (mockAsset as unknown as { native: () => { code: string; issuer: null } }).native = () => ({
    code: "XLM",
    issuer: null,
  });

  class MockTransactionBuilder {
    static fromXDR = mocks.fromXDR;

    constructor(_source: unknown, _opts: unknown) {}

    addOperation() { return this; }
    setTimeout() { return this; }
    addMemo() { return this; }
    build() {
      return { toXDR: () => MOCK_XDR };
    }
  }

  return {
    ...actual,
    Asset: mockAsset,
    TransactionBuilder: MockTransactionBuilder,
    Operation: {
      ...actual.Operation,
      payment: vi.fn().mockReturnValue({ type: "payment" }),
      createAccount: vi.fn().mockReturnValue({ type: "createAccount" }),
      changeTrust: vi.fn().mockReturnValue({ type: "changeTrust" }),
    },
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
        transactions: vi.fn().mockImplementation(() => {
          const b: Record<string, unknown> = {
            forAccount: vi.fn(() => b),
            limit: vi.fn(() => b),
            order: vi.fn(() => b),
            cursor: vi.fn(() => b),
            transaction: vi.fn().mockReturnValue({ call: mockTransactionCall }),
          };
          return b;
        }),
      })),
    },
  };
});

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const DEST_KEY = "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2";
const MOCK_XDR = "AAAAAQAAAAA=";
const TX_HASH = "abc123def456";

// A minimal mock transaction object that satisfies detectNetworkPassphraseMismatch
const MOCK_TX = {
  source: SOURCE_KEY,
  signatures: [],
  hash: () => Buffer.alloc(32),
  toXDR: () => MOCK_XDR,
  networkPassphrase: "Test SDF Network ; September 2015",
  operations: [],
  fee: "100",
};

function makeHorizonAccount() {
  return {
    accountId: () => SOURCE_KEY,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    subentry_count: 0,
    balances: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration: buildPayment → sign → submit", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
    mockTransactionCall.mockReset();
    mocks.fromXDR.mockReset();
    // Default fromXDR returns a proper mock transaction for submitTransaction to work
    mocks.fromXDR.mockReturnValue(MOCK_TX);
  });

  it("builds a payment transaction XDR", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount());

    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;

    const buildResult = await clientResult.data.transaction.buildPayment(SOURCE_KEY, {
      destination: DEST_KEY,
      amount: "10",
    });

    expect(buildResult.status).toBe("ok");
    if (buildResult.status === "ok") {
      expect(typeof buildResult.data).toBe("string");
      expect(buildResult.data.length).toBeGreaterThan(0);
    }
  });

  it("submits a signed transaction XDR", async () => {
    mockSubmitTransaction.mockResolvedValue({
      hash: TX_HASH,
      ledger: 500,
      envelope_xdr: MOCK_XDR,
      result_xdr: "result",
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const submitResult = await clientResult.data.transaction.submit(MOCK_XDR);

    expect(submitResult.status).toBe("ok");
    if (submitResult.status === "ok") {
      expect(submitResult.data.hash).toBe(TX_HASH);
      expect(submitResult.data.status).toBe("success");
    }
  });

  it("retrieves transaction status by hash", async () => {
    mockTransactionCall.mockResolvedValue({
      hash: TX_HASH,
      successful: true,
      ledger_attr: 500,
      created_at: "2024-01-01T00:00:00Z",
      fee_charged: "100",
      envelope_xdr: MOCK_XDR,
      result_xdr: "result",
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const statusResult = await clientResult.data.transaction.getStatus(TX_HASH);

    expect(statusResult.status).toBe("ok");
    if (statusResult.status === "ok") {
      expect(statusResult.data.hash).toBe(TX_HASH);
      expect(statusResult.data.status).toBe("success");
    }
  });

  it("full payment flow: build → manual sign → submit", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount());
    mockSubmitTransaction.mockResolvedValue({
      hash: TX_HASH,
      ledger: 501,
      envelope_xdr: MOCK_XDR,
      result_xdr: "result",
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;
    const client = clientResult.data;

    // Step 1: build
    const buildResult = await client.transaction.buildPayment(SOURCE_KEY, {
      destination: DEST_KEY,
      amount: "5",
      memo: "Integration test",
    });
    expect(buildResult.status).toBe("ok");
    if (buildResult.status !== "ok") return;

    // Step 2: submit (wallet would sign in production; we skip signing in this mock test)
    const submitResult = await client.transaction.submit(buildResult.data);
    expect(submitResult.status).toBe("ok");
    if (submitResult.status === "ok") {
      expect(submitResult.data.hash).toBe(TX_HASH);
    }
  });

  it("returns TX_SUBMIT_FAILED when Horizon rejects submission", async () => {
    mockSubmitTransaction.mockRejectedValue(
      new Error("Transaction submission failed: tx_bad_auth"),
    );

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const submitResult = await clientResult.data.transaction.submit(MOCK_XDR);

    expect(submitResult.status).toBe("error");
    if (submitResult.status === "error") {
      expect(submitResult.error.code).toBe(SorokitErrorCode.TX_SUBMIT_FAILED);
    }
  });

  it("returns TX_BUILD_FAILED when account load fails during build", async () => {
    mockLoadAccount.mockRejectedValue(new Error("network error"));

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const buildResult = await clientResult.data.transaction.buildPayment(SOURCE_KEY, {
      destination: DEST_KEY,
      amount: "10",
    });

    expect(buildResult.status).toBe("error");
    if (buildResult.status === "error") {
      expect(buildResult.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });

  it("builds a createAccount transaction", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount());

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const buildResult = await clientResult.data.transaction.buildCreateAccount(SOURCE_KEY, {
      destination: DEST_KEY,
      startingBalance: "2",
    });

    expect(buildResult.status).toBe("ok");
    if (buildResult.status === "ok") {
      expect(typeof buildResult.data).toBe("string");
    }
  });

  it("builds a trustline transaction", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccount());

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const buildResult = await clientResult.data.transaction.buildTrustline(SOURCE_KEY, {
      assetCode: "USDC",
      assetIssuer: "GBBD47IF6LWK5P7V6XZCHJSAXTSPG4FJHOUOHAUZTF5YQK4Q2GB7S7V2",
    });

    expect(buildResult.status).toBe("ok");
    if (buildResult.status === "ok") {
      expect(typeof buildResult.data).toBe("string");
    }
  });
});
