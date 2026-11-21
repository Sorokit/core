import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";
import { SorokitErrorCode } from "../shared/response";

const { mockSendTransaction, mockGetTransaction, mockSleep, callOrder } =
  vi.hoisted(() => ({
    mockSendTransaction: vi.fn(),
    mockGetTransaction: vi.fn(),
    mockSleep: vi.fn(),
    callOrder: [] as string[],
  }));

vi.mock("../shared/serverFactory", () => ({
  createSorobanServer: () => ({
    sendTransaction: mockSendTransaction,
    getTransaction: mockGetTransaction,
  }),
  createHorizonServer: vi.fn(),
}));

vi.mock("../shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared")>();
  return { ...actual, sleep: mockSleep };
});

vi.mock("../shared/mainnetSafety", () => ({
  checkMainnetSafety: () => ({ status: "ok", data: undefined }),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: vi.fn(() => ({ operations: [] })),
    },
  };
});

import { executeContract } from "../soroban/executeContract";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const SIGNED_XDR = "AAAAAgAAAAA=";

describe("executeContract polling (#739)", () => {
  beforeEach(() => {
    callOrder.length = 0;
    mockSendTransaction.mockReset().mockImplementation(async () => {
      callOrder.push("send");
      return { status: "PENDING", hash: "tx-hash" };
    });
    mockSleep.mockReset().mockImplementation(async (ms: number) => {
      callOrder.push(`sleep:${ms}`);
    });
    mockGetTransaction.mockReset();
  });

  it("checks the transaction status immediately after submission", async () => {
    mockGetTransaction.mockImplementation(async () => {
      callOrder.push("get");
      return { status: "SUCCESS" };
    });

    const result = await executeContract(
      networkConfig.rpcUrl,
      networkConfig,
      SIGNED_XDR,
      { maxAttempts: 5, intervalMs: 1000 },
    );

    expect(result.status).toBe("ok");
    expect(result.data).toBe("tx-hash");
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["send", "get"]);
  });

  it("waits intervalMs only between later attempts", async () => {
    mockGetTransaction
      .mockImplementationOnce(async () => {
        callOrder.push("get");
        return { status: "NOT_FOUND" };
      })
      .mockImplementationOnce(async () => {
        callOrder.push("get");
        return { status: "NOT_FOUND" };
      })
      .mockImplementationOnce(async () => {
        callOrder.push("get");
        return { status: "SUCCESS" };
      });

    const result = await executeContract(
      networkConfig.rpcUrl,
      networkConfig,
      SIGNED_XDR,
      { maxAttempts: 5, intervalMs: 250 },
    );

    expect(result.status).toBe("ok");
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(250);
    expect(callOrder).toEqual([
      "send",
      "get",
      "sleep:250",
      "get",
      "sleep:250",
      "get",
    ]);
  });

  it("still makes exactly maxAttempts status checks before timing out", async () => {
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const result = await executeContract(
      networkConfig.rpcUrl,
      networkConfig,
      SIGNED_XDR,
      { maxAttempts: 3, intervalMs: 100 },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_INVOKE_FAILED);
      expect(result.error.message).toContain("timed out after 3 attempts");
    }
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("does not sleep at all when maxAttempts is 1", async () => {
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const result = await executeContract(
      networkConfig.rpcUrl,
      networkConfig,
      SIGNED_XDR,
      { maxAttempts: 1, intervalMs: 100 },
    );

    expect(result.status).toBe("error");
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });
});
