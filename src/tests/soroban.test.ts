import { describe, it, expect, vi, beforeEach } from "vitest";
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractAbi } from "../soroban/types";
import type { ResolvedNetworkConfig } from "../shared/types";

const {
  mockLoadAccount,
  mockSimulateTransaction,
  mockIsSimulationSuccess,
  mockIsSimulationError,
  mockAssembleTransaction,
  mockScValToNative,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockSimulateTransaction: vi.fn(),
  mockIsSimulationSuccess: vi.fn(),
  mockIsSimulationError: vi.fn(),
  mockAssembleTransaction: vi.fn(),
  mockScValToNative: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", () => {
  class MockContract {
    constructor(readonly contractId: string) {}

    call(method: string, ...params: unknown[]) {
      return { contractId: this.contractId, method, params };
    }
  }

  class MockTransactionBuilder {
    operation?: unknown;
    timeout?: number;

    constructor(
      readonly sourceAccount: unknown,
      readonly options: unknown,
    ) {}

    addOperation(operation: unknown) {
      this.operation = operation;
      return this;
    }

    setTimeout(timeout: number) {
      this.timeout = timeout;
      return this;
    }

    build() {
      return {
        fee: "100",
        toXDR: () => "mock-xdr",
      };
    }
  }

  return {
    BASE_FEE: "100",
    Contract: MockContract,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
    scValToNative: mockScValToNative,
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
        isSimulationSuccess: mockIsSimulationSuccess,
      },
      assembleTransaction: mockAssembleTransaction,
    },
  };
});

import { prepareContractCall } from "../soroban/prepareCall";
import { readContract } from "../soroban/readContract";
import { SorokitErrorCode } from "../shared/response";

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const contractAbi: ContractAbi = {
  methods: [
    { name: "balance", args: [{ name: "id", type: "address" }], returns: "i128" },
    { name: "increment", args: [], returns: "u32" },
  ],
};

const arg = {} as xdr.ScVal;

function createXdrFunction(name: string, inputCount: number): xdr.ScSpecFunctionV0 {
  return {
    name: () => name,
    inputs: () => Array.from({ length: inputCount }),
  } as xdr.ScSpecFunctionV0;
}

describe("soroban contract ABI validation", () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockLoadAccount.mockResolvedValue({});
    mockSimulateTransaction.mockReset();
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: arg },
    });
    mockIsSimulationError.mockReset();
    mockIsSimulationError.mockReturnValue(false);
    mockIsSimulationSuccess.mockReset();
    mockIsSimulationSuccess.mockReturnValue(true);
    mockAssembleTransaction.mockReset();
    mockAssembleTransaction.mockReturnValue({
      build: () => ({
        fee: "100",
        toXDR: () => "assembled-xdr",
      }),
    });
    mockScValToNative.mockReset();
    mockScValToNative.mockReturnValue("native-value");
  });

  it("allows prepareContractCall when method and argument count match the ABI", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "balance",
        args: [arg],
        contractAbi,
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledOnce();
  });

  it("returns CONTRACT_PREPARE_FAILED before simulation for an unknown method", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "missing",
        args: [],
        contractAbi,
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
      expect(result.error.message).toContain("missing");
    }
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns CONTRACT_PREPARE_FAILED before simulation for a wrong argument count", async () => {
    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "balance",
        args: [],
        contractAbi,
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
      expect(result.error.message).toContain("expects 1 argument");
    }
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("keeps validation optional when no ABI is provided", async () => {
    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "missing",
        args: [],
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledOnce();
  });

  it("accepts SDK contract spec instances", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "balance",
        args: [arg],
        contractAbi: {
          funcs: () => [createXdrFunction("balance", 1)],
        },
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledOnce();
  });

  it("accepts ABI function arrays using Soroban XDR function specs", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "increment",
        args: [arg],
        contractAbi: [createXdrFunction("increment", 0)],
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
      expect(result.error.message).toContain("expects 0 argument");
    }
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("returns CONTRACT_PREPARE_FAILED when ABI inspection fails", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
        method: "balance",
        args: [arg],
        contractAbi: {
          funcs: () => {
            throw new Error("bad spec");
          },
        },
        publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
      expect(result.error.message).toContain("Invalid contract ABI");
    }
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });
});
