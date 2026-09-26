import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";
import { SorokitErrorCode } from "../shared/response";

const { mockPrepareContractCall, mockExecuteContract } = vi.hoisted(() => ({
  mockPrepareContractCall: vi.fn(),
  mockExecuteContract: vi.fn(),
}));

vi.mock("../soroban/prepareCall", () => ({
  prepareContractCall: mockPrepareContractCall,
}));

vi.mock("../soroban/executeContract", () => ({
  executeContract: mockExecuteContract,
  validateSorobanPollConfig: vi.fn().mockReturnValue(null),
}));

import { invokeContract } from "../soroban/invokeContract";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const params = {
  contractId: "CC1234567890",
  method: "transfer",
  publicKey: "GBXGQ6VYV4R7Y7S7Z7M7K7V7K7Y7S7Z7M7K7V7K7Y7S7Z7M7K7V7",
};

describe("invokeContract", () => {
  beforeEach(() => {
    mockPrepareContractCall.mockReset();
    mockExecuteContract.mockReset();

    mockPrepareContractCall.mockResolvedValue({
      status: "ok",
      data: { transactionXdr: "mock-prepared-xdr", fee: "100" },
    });
  });

  it("returns WALLET_SIGN_FAILED when signFn resolves to an empty string", async () => {
    const result = await invokeContract(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      params,
      async () => "",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
      expect(result.error.message).toContain("empty or invalid XDR string");
    }
    expect(mockExecuteContract).not.toHaveBeenCalled();
  });

  it("returns WALLET_SIGN_FAILED when signFn resolves to null", async () => {
    const result = await invokeContract(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      params,
      async () => null as never,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
      expect(result.error.message).toContain("empty or invalid XDR string");
    }
    expect(mockExecuteContract).not.toHaveBeenCalled();
  });

  it("calls executeContract when signFn resolves with a valid XDR string", async () => {
    mockExecuteContract.mockResolvedValue({
      status: "ok",
      data: "tx-hash",
    });

    const result = await invokeContract(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      params,
      async () => "signed-xdr",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe("tx-hash");
    }
    expect(mockExecuteContract).toHaveBeenCalledWith(
      networkConfig.rpcUrl,
      networkConfig,
      "signed-xdr",
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
  it("forwards explicit Mainnet confirmation to execution", async () => {
    mockExecuteContract.mockResolvedValue({ status: "ok", data: "tx-hash" });
    const safety = { bypassMainnetSafety: true, mainnetSafetyThresholdXlm: 500 };
    await invokeContract(networkConfig.rpcUrl, networkConfig, networkConfig.horizonUrl,
      params, async () => "signed-xdr", undefined, undefined, safety);
    expect(mockExecuteContract).toHaveBeenCalledWith(networkConfig.rpcUrl,
      networkConfig, "signed-xdr", undefined, undefined, undefined, safety);
  });

});
