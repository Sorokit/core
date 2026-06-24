import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import type { ContractAbi } from "../soroban/types";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorokitCache } from "../shared/cache";
import { getContractMethods } from "../soroban/contractMetadata";
import { prepareContractCall } from "../soroban/prepareCall";
import { readContract } from "../soroban/readContract";
import { SorokitErrorCode } from "../shared/response";

const {
  mockGetLedgerEntries,
  mockLoadAccount,
  mockSimulateTransaction,
  mockIsSimulationSuccess,
  mockIsSimulationError,
  mockAssembleTransaction,
  mockScValToNative,
} = vi.hoisted(() => ({
  mockGetLedgerEntries: vi.fn(),
  mockLoadAccount: vi.fn(),
  mockSimulateTransaction: vi.fn(),
  mockIsSimulationSuccess: vi.fn(),
  mockIsSimulationError: vi.fn(),
  mockAssembleTransaction: vi.fn(),
  mockScValToNative: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockContract {
    constructor(readonly contractId: string) {}

    getFootprint() {
      return { contractId: this.contractId };
    }

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
    ...actual,
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
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        getLedgerEntries: mockGetLedgerEntries,
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mockIsSimulationError,
        isSimulationSuccess: mockIsSimulationSuccess,
      },
      assembleTransaction: mockAssembleTransaction,
    },
  };
});

class MemoryCache implements SorokitCache {
  values = new Map<string, unknown>();
  ttlMs: number | undefined;

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.values.set(key, value);
    this.ttlMs = ttlMs;
  }

  invalidate(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

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

function contractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

function encodeLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;

  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);

  return bytes;
}

function contractSpecWasm(entries: xdr.ScSpecEntry[]): Buffer {
  const name = Buffer.from("contractspecv0");
  const spec = Buffer.concat(entries.map((entry) => entry.toXDR()));
  const sectionSize = name.length + encodeLeb128(name.length).length + spec.length;

  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...encodeLeb128(sectionSize),
    ...encodeLeb128(name.length),
    ...name,
    ...spec,
  ]);
}

function methodSpec(): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: "",
      name: "hello",
      inputs: [
        new xdr.ScSpecFunctionInputV0({
          doc: "",
          name: "to",
          type: xdr.ScSpecTypeDef.scSpecTypeSymbol(),
        }),
      ],
      outputs: [xdr.ScSpecTypeDef.scSpecTypeString()],
    }),
  );
}

function createXdrFunction(name: string, inputCount: number): xdr.ScSpecFunctionV0 {
  return {
    name: () => name,
    inputs: () => Array.from({ length: inputCount }),
  } as xdr.ScSpecFunctionV0;
}

function mockContractLedgerEntries(wasm: Buffer): void {
  mockGetLedgerEntries
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractData: () => ({
              val: () => ({
                instance: () => ({
                  executable: () =>
                    xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
                }),
              }),
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractCode: () => ({
              code: () => wasm,
            }),
          },
        },
      ],
    });
}

function mockStellarAssetContractEntry(): void {
  mockGetLedgerEntries.mockResolvedValueOnce({
    entries: [
      {
        val: {
          contractData: () => ({
            val: () => ({
              instance: () => ({
                executable: () => xdr.ContractExecutable.contractExecutableStellarAsset(),
              }),
            }),
          }),
        },
      },
    ],
  });
}

function resetRpcSimulationMocks(): void {
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
}

describe("soroban contract metadata", () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset();
    resetRpcSimulationMocks();
  });

  it("discovers contract methods from Soroban contract spec metadata", async () => {
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const result = await getContractMethods("https://rpc.example.com", contractId());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          name: "hello",
          inputs: [{ name: "to", type: "symbol" }],
          returnType: "string",
        },
      ]);
    }
  });

  it("caches discovered methods with the default one-hour TTL", async () => {
    const cache = new MemoryCache();
    const id = contractId();
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const first = await getContractMethods("https://rpc-cache.example.com", id, {
      cache,
      now: () => 1_000,
    });
    const second = await getContractMethods("https://rpc-cache.example.com", id, {
      cache,
      now: () => 2_000,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(2);
    expect(cache.ttlMs).toBe(60 * 60 * 1000);
  });

  it("misses the cache after TTL expiry and refetches metadata", async () => {
    const id = contractId();
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const first = await getContractMethods("https://rpc-expiry.example.com", id, {
      ttlMs: 10,
      now: () => 1_000,
    });
    const second = await getContractMethods("https://rpc-expiry.example.com", id, {
      ttlMs: 10,
      now: () => 1_011,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(4);
  });

  it("returns a typed error when the contract is not Wasm-backed", async () => {
    mockStellarAssetContractEntry();

    const result = await getContractMethods("https://rpc-sac.example.com", contractId());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
      expect(result.error.message).toContain("requires a Wasm contract");
    }
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it("validates cached metadata before preparing a contract call", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: contractId(),
        method: "missing",
        publicKey: Keypair.random().publicKey(),
        cachedMetadata: [
          {
            name: "hello",
            inputs: [],
            returnType: null,
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
    }
  });

  it("validates cached metadata before reading a contract", async () => {
    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: contractId(),
        method: "hello",
        publicKey: Keypair.random().publicKey(),
        cachedMetadata: [
          {
            name: "hello",
            inputs: [{ name: "to", type: "symbol" }],
            returnType: "string",
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
      expect(result.error.message).toContain("expects 1 argument");
    }
  });
});

describe("soroban contract ABI validation", () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset();
    resetRpcSimulationMocks();
  });

  it("allows prepareContractCall when method and argument count match the ABI", async () => {
    const result = await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: contractId(),
        method: "balance",
        args: [arg],
        contractAbi,
        publicKey: Keypair.random().publicKey(),
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
        contractId: contractId(),
        method: "missing",
        args: [],
        contractAbi,
        publicKey: Keypair.random().publicKey(),
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

  it("returns CONTRACT_READ_FAILED before simulation for a wrong read argument count", async () => {
    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: contractId(),
        method: "balance",
        args: [],
        contractAbi,
        publicKey: Keypair.random().publicKey(),
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
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
        contractId: contractId(),
        method: "missing",
        args: [],
        publicKey: Keypair.random().publicKey(),
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
        contractId: contractId(),
        method: "balance",
        args: [arg],
        contractAbi: {
          funcs: () => [createXdrFunction("balance", 1)],
        },
        publicKey: Keypair.random().publicKey(),
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
        contractId: contractId(),
        method: "increment",
        args: [arg],
        contractAbi: [createXdrFunction("increment", 0)],
        publicKey: Keypair.random().publicKey(),
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
        contractId: contractId(),
        method: "balance",
        args: [arg],
        contractAbi: {
          funcs: () => {
            throw new Error("bad spec");
          },
        },
        publicKey: Keypair.random().publicKey(),
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
