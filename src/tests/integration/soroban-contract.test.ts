/**
 * Integration test: contract discovery → prepare → execute workflow
 *
 * Tests the Soroban contract interaction chain: simulating a transaction,
 * executing (submit + poll), and verifying contract-level error propagation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSorokitClient } from "../../client/createSorokitClient";
import { SorokitErrorCode } from "../../shared/response";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockLoadAccount,
  mockRpcSimulate,
  mockRpcGetTransaction,
  mockRpcSendTransaction,
  mockRpcGetLedgerEntries,
  mockRpcIsSimulationSuccess,
  mockRpcIsSimulationError,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockRpcSimulate: vi.fn(),
  mockRpcGetTransaction: vi.fn(),
  mockRpcSendTransaction: vi.fn(),
  mockRpcGetLedgerEntries: vi.fn(),
  mockRpcIsSimulationSuccess: vi.fn(),
  mockRpcIsSimulationError: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  fromXDR: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    static fromXDR = mocks.fromXDR;

    constructor(_source: unknown, _opts: unknown) {}
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return { toXDR: () => MOCK_XDR }; }
  }

  return {
    ...actual,
    TransactionBuilder: MockTransactionBuilder,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mockRpcSimulate,
        getTransaction: mockRpcGetTransaction,
        sendTransaction: mockRpcSendTransaction,
        getLedgerEntries: mockRpcGetLedgerEntries,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: mockRpcIsSimulationSuccess,
        isSimulationError: mockRpcIsSimulationError,
        GetTransactionStatus: actual.rpc.Api.GetTransactionStatus,
      },
    },
  };
});

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const MOCK_XDR = "AAAAAQAAAAA=";
// Must be valid base64 with decoded byte count divisible by 4 to pass isXdrInvalidError
const MOCK_SIGNED_XDR = "AAAAAgAAAAA=";
const TX_HASH = "deadbeef1234567890";

// Minimal mock transaction for fromXDR calls
const MOCK_TX = {
  source: SOURCE_KEY,
  signatures: [],
  hash: () => Buffer.alloc(32),
  toXDR: () => MOCK_XDR,
  networkPassphrase: "Test SDF Network ; September 2015",
  operations: [],
  fee: "100",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration: Soroban contract discovery → prepare → execute", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockRpcSimulate.mockReset();
    mockRpcGetTransaction.mockReset();
    mockRpcSendTransaction.mockReset();
    mockRpcGetLedgerEntries.mockReset();
    mockRpcIsSimulationSuccess.mockReset();
    mockRpcIsSimulationError.mockReset();
    mocks.fromXDR.mockReset();
    mocks.fromXDR.mockReturnValue(MOCK_TX);
  });

  it("simulates a Soroban transaction XDR — success path", async () => {
    mockRpcIsSimulationSuccess.mockReturnValue(true);
    mockRpcIsSimulationError.mockReturnValue(false);
    mockRpcSimulate.mockResolvedValue({
      minResourceFee: "500",
      results: [{ xdr: "result_xdr" }],
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;

    const simResult = await clientResult.data.soroban.simulate(MOCK_XDR);

    expect(simResult.status).toBe("ok");
    if (simResult.status === "ok") {
      expect(simResult.data.success).toBe(true);
      expect(simResult.data.fee).toBeDefined();
    }
  });

  it("simulates a Soroban transaction XDR — simulation error path returns ok with success=false", async () => {
    // When the RPC reports a simulation error, simulate() returns ok({success: false})
    // rather than an error result — the caller checks result.data.success
    mockRpcIsSimulationSuccess.mockReturnValue(false);
    mockRpcIsSimulationError.mockReturnValue(true);
    mockRpcSimulate.mockResolvedValue({
      error: "simulation failed: contract error",
    });

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const simResult = await clientResult.data.soroban.simulate(MOCK_XDR);

    expect(simResult.status).toBe("ok");
    if (simResult.status === "ok") {
      expect(simResult.data.success).toBe(false);
      expect(simResult.data.error).toBeDefined();
    }
  });

  it("returns TX_SIMULATE_FAILED when RPC call throws", async () => {
    mockRpcSimulate.mockRejectedValue(new Error("RPC connection refused"));

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status !== "ok") return;

    const simResult = await clientResult.data.soroban.simulate(MOCK_XDR);

    expect(simResult.status).toBe("error");
    if (simResult.status === "error") {
      expect(simResult.error.code).toBe(SorokitErrorCode.TX_SIMULATE_FAILED);
    }
  });

  it("executes a signed Soroban transaction and polls for result", async () => {
    mockRpcSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: TX_HASH,
    });
    mockRpcGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      txHash: TX_HASH,
    });

    const clientResult = createSorokitClient({
      network: "testnet",
      sorobanPoll: { maxAttempts: 3, intervalMs: 10 },
    });
    if (clientResult.status !== "ok") return;

    const executeResult = await clientResult.data.soroban.execute(MOCK_SIGNED_XDR);

    expect(executeResult.status).toBe("ok");
    if (executeResult.status === "ok") {
      expect(executeResult.data).toBe(TX_HASH);
    }
  });

  it("returns CONTRACT_INVOKE_FAILED when RPC send returns ERROR status", async () => {
    mockRpcSendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: TX_HASH,
      errorResult: { toXDR: () => "error_xdr" },
    });

    const clientResult = createSorokitClient({
      network: "testnet",
      sorobanPoll: { maxAttempts: 2, intervalMs: 10 },
    });
    if (clientResult.status !== "ok") return;

    const executeResult = await clientResult.data.soroban.execute(MOCK_SIGNED_XDR);

    expect(executeResult.status).toBe("error");
    if (executeResult.status === "error") {
      expect(executeResult.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
    }
  });

  it("returns CONTRACT_INVOKE_FAILED when transaction times out during polling", async () => {
    mockRpcSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: TX_HASH,
    });
    // Always return NOT_FOUND to simulate timeout
    mockRpcGetTransaction.mockResolvedValue({
      status: "NOT_FOUND",
    });

    const clientResult = createSorokitClient({
      network: "testnet",
      sorobanPoll: { maxAttempts: 2, intervalMs: 10 },
    });
    if (clientResult.status !== "ok") return;

    const executeResult = await clientResult.data.soroban.execute(MOCK_SIGNED_XDR);

    expect(executeResult.status).toBe("error");
    if (executeResult.status === "error") {
      expect(executeResult.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
    }
  });

  it("returns CONTRACT_INVOKE_FAILED when on-chain execution fails", async () => {
    mockRpcSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: TX_HASH,
    });
    mockRpcGetTransaction.mockResolvedValue({
      status: "FAILED",
      txHash: TX_HASH,
    });

    const clientResult = createSorokitClient({
      network: "testnet",
      sorobanPoll: { maxAttempts: 3, intervalMs: 10 },
    });
    if (clientResult.status !== "ok") return;

    const executeResult = await clientResult.data.soroban.execute(MOCK_SIGNED_XDR);

    expect(executeResult.status).toBe("error");
    if (executeResult.status === "error") {
      expect(executeResult.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
    }
  });
});
