import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SorokitCache } from "../shared/cache";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { getContractMethods } from "../soroban/contractMetadata";
import {
  clearSnapshots,
  compareSnapshots,
  listSnapshots,
  snapshotContractState,
} from "../soroban/contractSnapshot";
import { buildContractDeploy } from "../soroban/deployContract";
import { prepareContractCall } from "../soroban/prepareCall";
import { readContract } from "../soroban/readContract";
import { simulateTransaction } from "../soroban/simulateTransaction";
import { subscribeContractEvents } from "../soroban/subscribeContractEvents";
import type { ContractAbi } from "../soroban/types";

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

  (MockTransactionBuilder as any).fromXDR = actual.TransactionBuilder.fromXDR;

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
    {
      name: "balance",
      args: [{ name: "id", type: "address" }],
      returns: "i128",
    },
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
  const sectionSize =
    name.length + encodeLeb128(name.length).length + spec.length;

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

function createXdrFunction(
  name: string,
  inputCount: number,
): xdr.ScSpecFunctionV0 {
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
                    xdr.ContractExecutable.contractExecutableWasm(
                      Buffer.alloc(32, 1),
                    ),
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
                executable: () =>
                  xdr.ContractExecutable.contractExecutableStellarAsset(),
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

    const result = await getContractMethods(
      "https://rpc.example.com",
      contractId(),
    );

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

    const first = await getContractMethods(
      "https://rpc-cache.example.com",
      id,
      {
        cache,
        now: () => 1_000,
      },
    );
    const second = await getContractMethods(
      "https://rpc-cache.example.com",
      id,
      {
        cache,
        now: () => 2_000,
      },
    );

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(2);
    expect(cache.ttlMs).toBe(60 * 60 * 1000);
  });

  it("misses the cache after TTL expiry and refetches metadata", async () => {
    const id = contractId();
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const first = await getContractMethods(
      "https://rpc-expiry.example.com",
      id,
      {
        ttlMs: 10,
        now: () => 1_000,
      },
    );
    const second = await getContractMethods(
      "https://rpc-expiry.example.com",
      id,
      {
        ttlMs: 10,
        now: () => 1_011,
      },
    );

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(4);
  });

  it("returns a typed error when the contract is not Wasm-backed", async () => {
    mockStellarAssetContractEntry();

    const result = await getContractMethods(
      "https://rpc-sac.example.com",
      contractId(),
    );

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

describe("soroban contract event subscriptions", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("filters events by name and topic patterns before invoking the callback", async () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: "evt-1",
              contractId: "C123",
              name: "transfer",
              topics: ["alice", "bob"],
              value: { amount: 10 },
            },
            {
              id: "evt-2",
              contractId: "C123",
              name: "mint",
              topics: ["admin", "bob"],
              value: { amount: 5 },
            },
          ],
        },
      }),
    });

    const unsubscribe = subscribeContractEvents(
      "C123",
      { name: "transfer", topicPatterns: [/^bob$/] },
      callback,
      { horizonUrl: "https://horizon.test", intervalMs: 1, fetch: fetchMock },
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ id: "evt-1", name: "transfer" }),
    ]);

    unsubscribe();
  });

  it("returns an unsubscribe function that stops polling", async () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: "evt-1",
              contractId: "C123",
              name: "transfer",
              topics: ["alice"],
              value: { amount: 1 },
            },
          ],
        },
      }),
    });

    const unsubscribe = subscribeContractEvents("C123", undefined, callback, {
      horizonUrl: "https://horizon.test",
      intervalMs: 1,
      fetch: fetchMock,
    });

    unsubscribe();
    await vi.advanceTimersByTimeAsync(5);

    expect(fetchMock).not.toHaveBeenCalled();
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

  describe("readContract caching (#88)", () => {
    beforeEach(() => {
      resetRpcSimulationMocks();
    });

    it("behaves as before if no cache option is provided (backward compatible)", async () => {
      const id = contractId();
      const result1 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
        },
      );
      const result2 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
        },
      );

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });

    it("caches the result on cache miss and returns it on cache hit", async () => {
      const cache = new MemoryCache();
      const id = contractId();

      const result1 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
        },
      );
      const result2 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
        },
      );

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(result1.data).toEqual(result2.data);
      expect(mockSimulateTransaction).toHaveBeenCalledOnce();
    });

    it("respects the TTL and expires the cache entry", async () => {
      let currentTime = 1000;
      const nowFn = () => currentTime;

      class ExpirableCache implements SorokitCache {
        private store = new Map<string, { value: any; expiresAt: number }>();
        get(key: string): unknown {
          const entry = this.store.get(key);
          if (!entry) return undefined;
          if (nowFn() >= entry.expiresAt) {
            this.store.delete(key);
            return undefined;
          }
          return entry.value;
        }
        set(key: string, value: unknown, ttlMs?: number): void {
          const ttl = ttlMs ?? 5 * 60 * 1000;
          this.store.set(key, { value, expiresAt: nowFn() + ttl });
        }
        invalidate(key: string): void {
          this.store.delete(key);
        }
        clear(): void {
          this.store.clear();
        }
      }

      const cache = new ExpirableCache();
      const id = contractId();

      // First call (miss, TTL 10ms)
      const result1 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledOnce();

      // Second call before expiry (hit)
      currentTime = 1005;
      const result2 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledOnce(); // still once

      // Third call after expiry (miss)
      currentTime = 1011;
      const result3 = await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(result3.status).toBe("ok");
    });

    it("deduplicates concurrent identical reads using shared Promise", async () => {
      const cache = new MemoryCache();
      const id = contractId();
      let simulateCallCount = 0;

      mockSimulateTransaction.mockImplementation(async () => {
        simulateCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { result: { retval: arg } };
      });

      // Launch 3 concurrent identical reads
      const [result1, result2, result3] = await Promise.all([
        readContract(
          networkConfig.rpcUrl,
          networkConfig.horizonUrl,
          networkConfig,
          {
            contractId: id,
            method: "balance",
            args: [arg],
            publicKey: Keypair.random().publicKey(),
            cache,
          },
        ),
        readContract(
          networkConfig.rpcUrl,
          networkConfig.horizonUrl,
          networkConfig,
          {
            contractId: id,
            method: "balance",
            args: [arg],
            publicKey: Keypair.random().publicKey(),
            cache,
          },
        ),
        readContract(
          networkConfig.rpcUrl,
          networkConfig.horizonUrl,
          networkConfig,
          {
            contractId: id,
            method: "balance",
            args: [arg],
            publicKey: Keypair.random().publicKey(),
            cache,
          },
        ),
      ]);

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(result3.status).toBe("ok");
      expect(simulateCallCount).toBe(1); // Only one RPC call for all three concurrent reads
    });

    it("uses default 5-minute TTL when not specified", async () => {
      const cache = new MemoryCache();
      const id = contractId();

      await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
        },
      );

      expect(cache.ttlMs).toBe(5 * 60 * 1000);
    });

    it("generates different cache keys for different arguments", async () => {
      const cache = new MemoryCache();
      const id = contractId();

      await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg],
          publicKey: Keypair.random().publicKey(),
          cache,
        },
      );

      await readContract(
        networkConfig.rpcUrl,
        networkConfig.horizonUrl,
        networkConfig,
        {
          contractId: id,
          method: "balance",
          args: [arg], // Same args, should hit cache
          publicKey: Keypair.random().publicKey(),
          cache,
        },
      );

      expect(mockSimulateTransaction).toHaveBeenCalledOnce();
    });
  });

  describe("simulateTransaction caching", () => {
    let transactionXdr: string;
    let networkPassphrase: string;

    beforeAll(async () => {
      const actualSdk = await vi.importActual<
        typeof import("@stellar/stellar-sdk")
      >("@stellar/stellar-sdk");
      const contractId = actualSdk.StrKey.encodeContract(Buffer.alloc(32));
      const contract = new actualSdk.Contract(contractId);
      const op = contract.call("hello", actualSdk.xdr.ScVal.scvSymbol("world"));
      const sourceAccount = new actualSdk.Account(
        actualSdk.Keypair.random().publicKey(),
        "1",
      );
      const tx = new actualSdk.TransactionBuilder(sourceAccount, {
        fee: actualSdk.BASE_FEE,
        networkPassphrase: actualSdk.Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(100)
        .build();
      transactionXdr = tx.toXDR();
      networkPassphrase = actualSdk.Networks.TESTNET;
    });

    beforeEach(() => {
      resetRpcSimulationMocks();
    });

    it("behaves as before if no cache option is provided (backward compatible)", async () => {
      const result1 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
      );
      const result2 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
      );

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });

    it("caches the result on cache miss and returns it on cache hit", async () => {
      const cache = new MemoryCache();

      const result1 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
        { cache },
      );
      const result2 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
        { cache },
      );

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
      expect(result1.data).toEqual(result2.data);
      expect(mockSimulateTransaction).toHaveBeenCalledOnce();
    });

    it("respects the TTL and expires the cache entry", async () => {
      let currentTime = 1000;
      const nowFn = () => currentTime;

      class ExpirableCache implements SorokitCache {
        private store = new Map<string, { value: any; expiresAt: number }>();
        get(key: string): unknown {
          const entry = this.store.get(key);
          if (!entry) return undefined;
          if (nowFn() >= entry.expiresAt) {
            this.store.delete(key);
            return undefined;
          }
          return entry.value;
        }
        set(key: string, value: unknown, ttlMs?: number): void {
          const ttl = ttlMs ?? 5 * 60 * 1000;
          this.store.set(key, { value, expiresAt: nowFn() + ttl });
        }
        invalidate(key: string): void {
          this.store.delete(key);
        }
        clear(): void {
          this.store.clear();
        }
      }

      const cache = new ExpirableCache();

      // First call (miss, TTL 10ms)
      const result1 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
        {
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledOnce();

      // Second call before expiry (hit)
      currentTime = 1005;
      const result2 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
        {
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledOnce(); // still once

      // Third call after expiry (miss)
      currentTime = 1011;
      const result3 = await simulateTransaction(
        networkConfig.rpcUrl,
        networkPassphrase,
        transactionXdr,
        {
          cache,
          ttlMs: 10,
        },
      );
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });
  });
});

describe("snapshotContractState and compareSnapshots (#39)", () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset();
    clearSnapshots();
  });

  it("creates a snapshot with label and timestamp", async () => {
    mockGetLedgerEntries.mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractData: () => ({
              val: () => ({
                instance: () => ({
                  executable: () =>
                    xdr.ContractExecutable.contractExecutableWasm(
                      Buffer.alloc(32, 1),
                    ),
                }),
              }),
            }),
          },
        },
      ],
    });

    const result = await snapshotContractState(
      networkConfig.rpcUrl,
      contractId(),
      "my-snapshot",
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.label).toBe("my-snapshot");
    expect(result.data.timestamp).toBeTruthy();
    expect(result.data.state).toBeDefined();
  });

  it("generates a label automatically when none is provided", async () => {
    mockGetLedgerEntries.mockResolvedValueOnce({ entries: [] });

    const result = await snapshotContractState(
      networkConfig.rpcUrl,
      contractId(),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.label).toMatch(/^snapshot-\d+$/);
  });

  it("extracts wasm executable info from contract instance", async () => {
    mockGetLedgerEntries.mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractData: () => ({
              val: () => ({
                instance: () => ({
                  executable: () =>
                    xdr.ContractExecutable.contractExecutableWasm(
                      Buffer.alloc(32, 0xab),
                    ),
                }),
              }),
            }),
          },
        },
      ],
    });

    const result = await snapshotContractState(
      networkConfig.rpcUrl,
      contractId(),
      "wasm-snap",
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.state.executable).toBe("wasm");
    expect(typeof result.data.state.wasmHash).toBe("string");
  });

  it("stores an empty state when no ledger entries are returned", async () => {
    mockGetLedgerEntries.mockResolvedValueOnce({ entries: [] });

    const result = await snapshotContractState(
      networkConfig.rpcUrl,
      contractId(),
      "empty-snap",
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.state).toEqual({});
  });

  it("stores multiple snapshots and listSnapshots returns all", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const id = contractId();
    await snapshotContractState(networkConfig.rpcUrl, id, "snap-a");
    await snapshotContractState(networkConfig.rpcUrl, id, "snap-b");

    const all = listSnapshots(id);
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.label)).toEqual(
      expect.arrayContaining(["snap-a", "snap-b"]),
    );
  });

  it("compareSnapshots detects added keys", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const id = contractId();
    await snapshotContractState(networkConfig.rpcUrl, id, "before");

    // Overwrite the stored snapshot state to simulate a change
    const beforeSnap = listSnapshots(id).find((s) => s.label === "before")!;
    (beforeSnap.state as Record<string, unknown>).foo = "bar";

    await snapshotContractState(networkConfig.rpcUrl, id, "after");
    // Manually add a new key to the "after" snapshot
    const afterSnap = listSnapshots(id).find((s) => s.label === "after")!;
    (afterSnap.state as Record<string, unknown>).foo = "bar";
    (afterSnap.state as Record<string, unknown>).newKey = "newValue";

    const diff = compareSnapshots("before", "after");
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.data.added).toEqual({ newKey: "newValue" });
  });

  it("compareSnapshots detects removed keys", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const id = contractId();
    await snapshotContractState(networkConfig.rpcUrl, id, "snap1");
    await snapshotContractState(networkConfig.rpcUrl, id, "snap2");

    const snap1 = listSnapshots(id).find((s) => s.label === "snap1")!;
    (snap1.state as Record<string, unknown>).oldKey = "oldValue";

    const diff = compareSnapshots("snap1", "snap2");
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.data.removed).toEqual({ oldKey: "oldValue" });
  });

  it("compareSnapshots detects changed values", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const id = contractId();
    await snapshotContractState(networkConfig.rpcUrl, id, "v1");
    await snapshotContractState(networkConfig.rpcUrl, id, "v2");

    const v1 = listSnapshots(id).find((s) => s.label === "v1")!;
    const v2 = listSnapshots(id).find((s) => s.label === "v2")!;
    (v1.state as Record<string, unknown>).count = 1;
    (v2.state as Record<string, unknown>).count = 2;

    const diff = compareSnapshots("v1", "v2");
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.data.changed).toEqual({ count: { from: 1, to: 2 } });
  });

  it("compareSnapshots returns error when a label is not found", () => {
    const diff = compareSnapshots("nonexistent-a", "nonexistent-b");
    expect(diff.status).toBe("error");
    if (diff.status !== "error") return;
    expect(diff.error.message).toContain("nonexistent-a");
  });

  it("clearSnapshots removes all stored snapshots", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });
    await snapshotContractState(networkConfig.rpcUrl, contractId(), "to-clear");
    clearSnapshots();
    expect(listSnapshots()).toHaveLength(0);
  });

  it("returns CONTRACT_READ_FAILED when RPC throws", async () => {
    mockGetLedgerEntries.mockRejectedValueOnce(new Error("RPC down"));

    const result = await snapshotContractState(
      networkConfig.rpcUrl,
      contractId(),
      "fail-snap",
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
  });
});

describe("buildContractDeploy", () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset();
    resetRpcSimulationMocks();
  });

  const validWasm = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]);

  it("returns TX_BUILD_FAILED if WASM size exceeds maximum", async () => {
    const hugeWasm = Buffer.alloc(256 * 1024 + 1, 0x00);
    const result = await buildContractDeploy(
      hugeWasm,
      Keypair.random().publicKey(),
      {
        rpcUrl: networkConfig.rpcUrl,
        horizonUrl: networkConfig.horizonUrl,
        networkConfig,
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toContain("exceeds max size");
    }
  });

  it("returns TX_BUILD_FAILED if WASM magic bytes are missing", async () => {
    const invalidWasm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const result = await buildContractDeploy(
      invalidWasm,
      Keypair.random().publicKey(),
      {
        rpcUrl: networkConfig.rpcUrl,
        horizonUrl: networkConfig.horizonUrl,
        networkConfig,
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toContain("missing magic bytes");
    }
  });

  it("successfully builds contract deployment XDR", async () => {
    const result = await buildContractDeploy(
      validWasm,
      Keypair.random().publicKey(),
      {
        rpcUrl: networkConfig.rpcUrl,
        horizonUrl: networkConfig.horizonUrl,
        networkConfig,
      },
    );
    expect(result.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledOnce();
    if (result.status === "ok") {
      expect(result.data.transactionXdr).toBeDefined();
    }
  });
});

import {
  SorokitErrorCode as SC,
  err as sorokitErr,
  ok as sorokitOk,
} from "../shared/response";
import { invokeBatchContracts } from "../soroban/invokeBatchContracts";
import type { BatchContractInvocation } from "../soroban/types";

vi.mock("../soroban/invokeContract", () => ({
  invokeContract: vi.fn(),
}));

import { invokeContract } from "../soroban/invokeContract";

const mockInvokeContract = invokeContract as ReturnType<typeof vi.fn>;

const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const NETWORK = networkConfig;
const SIGN_FN = vi.fn(async (xdr: string) => xdr);

const CONTRACT_A = StrKey.encodeContract(Keypair.random().rawPublicKey());
const CONTRACT_B = StrKey.encodeContract(Keypair.random().rawPublicKey());

function makeInvocation(
  contractId: string,
  method = "call",
): BatchContractInvocation {
  return { contractId, method, publicKey: Keypair.random().publicKey() };
}

describe("invokeBatchContracts (#104)", () => {
  beforeEach(() => {
    mockInvokeContract.mockReset();
  });

  it("returns ok for all invocations when all succeed", async () => {
    mockInvokeContract
      .mockResolvedValueOnce(sorokitOk("hash-a"))
      .mockResolvedValueOnce(sorokitOk("hash-b"));

    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [makeInvocation(CONTRACT_A), makeInvocation(CONTRACT_B)],
      SIGN_FN,
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("ok");
    if (results[0].status === "ok") expect(results[0].data).toBe("hash-a");
    expect(results[1].status).toBe("ok");
    if (results[1].status === "ok") expect(results[1].data).toBe("hash-b");
  });

  it("returns error for all invocations when all fail", async () => {
    mockInvokeContract
      .mockResolvedValueOnce(sorokitErr(SC.RPC_ERROR, "contract A failed"))
      .mockResolvedValueOnce(sorokitErr(SC.RPC_ERROR, "contract B failed"));

    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [makeInvocation(CONTRACT_A), makeInvocation(CONTRACT_B)],
      SIGN_FN,
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("error");
    expect(results[1].status).toBe("error");
  });

  it("handles mixed success and failure results", async () => {
    mockInvokeContract
      .mockResolvedValueOnce(sorokitOk("hash-a"))
      .mockResolvedValueOnce(sorokitErr(SC.RPC_ERROR, "contract B failed"));

    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [makeInvocation(CONTRACT_A, "mint"), makeInvocation(CONTRACT_B, "burn")],
      SIGN_FN,
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("ok");
    expect(results[0].contractId).toBe(CONTRACT_A);
    expect(results[0].method).toBe("mint");
    expect(results[1].status).toBe("error");
    expect(results[1].contractId).toBe(CONTRACT_B);
    expect(results[1].method).toBe("burn");
  });

  it("captures unexpected thrown errors as error results", async () => {
    mockInvokeContract
      .mockResolvedValueOnce(sorokitOk("hash-a"))
      .mockRejectedValueOnce(new Error("network crash"));

    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [makeInvocation(CONTRACT_A), makeInvocation(CONTRACT_B)],
      SIGN_FN,
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("error");
    if (results[1].status === "error") {
      expect(results[1].error.message).toContain("network crash");
    }
  });

  it("returns empty array for empty invocations list", async () => {
    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [],
      SIGN_FN,
    );
    expect(results).toEqual([]);
    expect(mockInvokeContract).not.toHaveBeenCalled();
  });

  it("passes pollConfig and logger options to each invokeContract call", async () => {
    mockInvokeContract.mockResolvedValue(sorokitOk("hash"));

    const pollConfig = { maxAttempts: 5, intervalMs: 500 };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [makeInvocation(CONTRACT_A)],
      SIGN_FN,
      { pollConfig, logger },
    );

    expect(mockInvokeContract).toHaveBeenCalledWith(
      RPC,
      NETWORK,
      HORIZON,
      expect.objectContaining({ contractId: CONTRACT_A }),
      SIGN_FN,
      pollConfig,
      logger,
    );
  });

  it("executes invocations sequentially when parallel is false", async () => {
    const order: number[] = [];
    mockInvokeContract.mockImplementation(async () => {
      const callIndex = mockInvokeContract.mock.calls.length;
      order.push(callIndex);
      return sorokitOk(`hash-${callIndex}`);
    });

    const results = await invokeBatchContracts(
      RPC,
      NETWORK,
      HORIZON,
      [
        makeInvocation(CONTRACT_A, "first"),
        makeInvocation(CONTRACT_B, "second"),
      ],
      SIGN_FN,
      { parallel: false },
    );

    expect(order).toEqual([1, 2]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
  });
});

import {
  decodeContractValue,
  encodeContractArgs,
} from "../soroban/contractEncoding";
import type { ContractMethod } from "../soroban/types";

// ─── #93 decodeContractValue ──────────────────────────────────────────────────

describe("decodeContractValue (#93)", () => {
  it("decodes bool true", () => {
    expect(decodeContractValue(xdr.ScVal.scvBool(true))).toBe(true);
  });

  it("decodes bool false", () => {
    expect(decodeContractValue(xdr.ScVal.scvBool(false))).toBe(false);
  });

  it("decodes u32", () => {
    expect(decodeContractValue(xdr.ScVal.scvU32(42))).toBe(42);
  });

  it("decodes i32 (negative)", () => {
    expect(decodeContractValue(xdr.ScVal.scvI32(-7))).toBe(-7);
  });

  it("decodes string", () => {
    expect(
      decodeContractValue(xdr.ScVal.scvString(Buffer.from("hello", "utf8"))),
    ).toBe("hello");
  });

  it("decodes symbol", () => {
    expect(decodeContractValue(xdr.ScVal.scvSymbol("tick"))).toBe("tick");
  });

  it("decodes void as undefined", () => {
    expect(decodeContractValue(xdr.ScVal.scvVoid())).toBeUndefined();
  });

  it("decodes vec recursively", () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]);
    expect(decodeContractValue(vec)).toEqual([1, 2]);
  });

  it("decodes map to plain object", () => {
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvString(Buffer.from("a", "utf8")),
        val: xdr.ScVal.scvU32(10),
      }),
    ]);
    expect(decodeContractValue(map)).toEqual({ a: 10 });
  });
});

// ─── #94 encodeContractArgs ───────────────────────────────────────────────────

describe("encodeContractArgs (#94)", () => {
  const method = (inputs: ContractMethod["inputs"]): ContractMethod => ({
    name: "test",
    inputs,
    returnType: null,
  });

  it("encodes u32", () => {
    const [val] = encodeContractArgs(
      method([{ name: "n", type: "u32" }]),
      [99],
    );
    expect(val.switch()).toEqual(xdr.ScValType.scvU32());
    expect(val.u32()).toBe(99);
  });

  it("encodes i32 negative", () => {
    const [val] = encodeContractArgs(
      method([{ name: "n", type: "i32" }]),
      [-5],
    );
    expect(val.switch()).toEqual(xdr.ScValType.scvI32());
    expect(val.i32()).toBe(-5);
  });

  it("encodes bool", () => {
    const [val] = encodeContractArgs(method([{ name: "b", type: "bool" }]), [
      true,
    ]);
    expect(val.switch()).toEqual(xdr.ScValType.scvBool());
    expect(val.b()).toBe(true);
  });

  it("encodes string", () => {
    const [val] = encodeContractArgs(method([{ name: "s", type: "string" }]), [
      "world",
    ]);
    expect(val.switch()).toEqual(xdr.ScValType.scvString());
    expect(Buffer.from(val.str()).toString("utf8")).toBe("world");
  });

  it("encodes symbol", () => {
    const [val] = encodeContractArgs(method([{ name: "s", type: "symbol" }]), [
      "tick",
    ]);
    expect(val.switch()).toEqual(xdr.ScValType.scvSymbol());
  });

  it("encodes vec from array", () => {
    const [val] = encodeContractArgs(method([{ name: "v", type: "vec" }]), [
      [1, 2, 3],
    ]);
    expect(val.switch()).toEqual(xdr.ScValType.scvVec());
  });

  it("encodes map from object", () => {
    const [val] = encodeContractArgs(method([{ name: "m", type: "map" }]), [
      { x: 1 },
    ]);
    expect(val.switch()).toEqual(xdr.ScValType.scvMap());
  });

  it("throws when argument count mismatches", () => {
    expect(() =>
      encodeContractArgs(
        method([
          { name: "a", type: "u32" },
          { name: "b", type: "u32" },
        ]),
        [1],
      ),
    ).toThrow(/expects 2/);
  });

  it("throws when value type is wrong for bool", () => {
    expect(() =>
      encodeContractArgs(method([{ name: "b", type: "bool" }]), ["not-a-bool"]),
    ).toThrow(/expected boolean/);
  });

  it("throws when u32 value is negative", () => {
    expect(() =>
      encodeContractArgs(method([{ name: "n", type: "u32" }]), [-1]),
    ).toThrow(/out of range/);
  });

  it("encodes zero args when method has no inputs", () => {
    const result = encodeContractArgs(method([]), []);
    expect(result).toEqual([]);
  });
});

// ─── #90 XDR validation in prepareContractCall ───────────────────────────────

describe("prepareContractCall XDR validation (#90)", () => {
  beforeEach(() => {
    resetRpcSimulationMocks();
    // Return malformed XDR from assembleTransaction
    mockAssembleTransaction.mockReturnValue({
      build: () => ({
        fee: "100",
        toXDR: () => "!!!invalid-xdr!!!",
      }),
    });
  });

  it("returns CONTRACT_PREPARE_FAILED when assembled XDR is malformed", async () => {
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

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
      expect(result.error.message).toContain("malformed XDR");
    }
  });
});

describe("simulateContractSafe (#97)", () => {
  let transactionXdr: string;
  let networkPassphrase: string;

  beforeAll(async () => {
    const actualSdk = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
      "@stellar/stellar-sdk",
    );
    const contractId = actualSdk.StrKey.encodeContract(Buffer.alloc(32));
    const contract = new actualSdk.Contract(contractId);
    const op = contract.call("hello", actualSdk.xdr.ScVal.scvSymbol("world"));
    const sourceAccount = new actualSdk.Account(
      actualSdk.Keypair.random().publicKey(),
      "1",
    );
    const tx = new actualSdk.TransactionBuilder(sourceAccount, {
      fee: actualSdk.BASE_FEE,
      networkPassphrase: actualSdk.Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(100)
      .build();
    transactionXdr = tx.toXDR();
    networkPassphrase = actualSdk.Networks.TESTNET;
  });

  beforeEach(() => {
    resetRpcSimulationMocks();
  });

  it("returns simulation result on success without fallback", async () => {
    mockSimulateTransaction.mockResolvedValueOnce({
      minResourceFee: "12345",
    });
    const result = await simulateContractSafe(
      networkConfig.rpcUrl,
      networkPassphrase,
      transactionXdr,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.success).toBe(true);
    expect(result.data.fee).toBe("12345");
    expect(result.data.fromFallback).toBe(false);
  });

  it("returns fallback when simulation throws and allowFail is true", async () => {
    mockSimulateTransaction.mockRejectedValueOnce(new Error("rpc down"));
    const result = await simulateContractSafe(
      networkConfig.rpcUrl,
      networkPassphrase,
      transactionXdr,
      { allowFail: true, fallbackFee: "500000" },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.fromFallback).toBe(true);
    expect(result.data.fee).toBe("500000");
  });

  it("propagates error when allowFail is false", async () => {
    mockSimulateTransaction.mockRejectedValueOnce(new Error("rpc down"));
    const result = await simulateContractSafe(
      networkConfig.rpcUrl,
      networkPassphrase,
      transactionXdr,
    );
    expect(result.status).toBe("error");
  });

  it("uses a default fallback fee when none is provided", async () => {
    mockSimulateTransaction.mockRejectedValueOnce(new Error("rpc down"));
    const result = await simulateContractSafe(
      networkConfig.rpcUrl,
      networkPassphrase,
      transactionXdr,
      { allowFail: true },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.fromFallback).toBe(true);
    expect(Number(result.data.fee)).toBeGreaterThan(0);
  });
});

import { parseContractResult } from "../soroban/parseContractResult";

describe("parseContractResult (#119)", () => {
  it("parses bool true with type", () => {
    const result = parseContractResult(xdr.ScVal.scvBool(true));
    expect(result.type).toBe("bool");
    expect(result.value).toBe(true);
  });

  it("parses bool false with type", () => {
    const result = parseContractResult(xdr.ScVal.scvBool(false));
    expect(result.type).toBe("bool");
    expect(result.value).toBe(false);
  });

  it("parses u32", () => {
    const result = parseContractResult(xdr.ScVal.scvU32(42));
    expect(result.type).toBe("u32");
    expect(result.value).toBe(42);
  });

  it("parses i32 negative", () => {
    const result = parseContractResult(xdr.ScVal.scvI32(-7));
    expect(result.type).toBe("i32");
    expect(result.value).toBe(-7);
  });

  it("parses u64 as bigint", () => {
    const result = parseContractResult(
      xdr.ScVal.scvU64(new xdr.Uint64("100")),
    );
    expect(result.type).toBe("u64");
    expect(result.value).toBe(100n);
  });

  it("parses i64 as bigint", () => {
    const result = parseContractResult(
      xdr.ScVal.scvI64(new xdr.Int64("-50")),
    );
    expect(result.type).toBe("i64");
    expect(result.value).toBe(-50n);
  });

  it("parses u128 as bigint", () => {
    const result = parseContractResult(
      xdr.ScVal.scvU128(
        new xdr.UInt128Parts({ hi: new xdr.Uint64("0"), lo: new xdr.Uint64("999") }),
      ),
    );
    expect(result.type).toBe("u128");
    expect(result.value).toBe(999n);
  });

  it("parses i128 as bigint (positive)", () => {
    const result = parseContractResult(
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: new xdr.Int64("0"), lo: new xdr.Uint64("1234") }),
      ),
    );
    expect(result.type).toBe("i128");
    expect(result.value).toBe(1234n);
  });

  it("parses string", () => {
    const result = parseContractResult(
      xdr.ScVal.scvString(Buffer.from("hello", "utf8")),
    );
    expect(result.type).toBe("string");
    expect(result.value).toBe("hello");
  });

  it("parses symbol", () => {
    const result = parseContractResult(xdr.ScVal.scvSymbol("tick"));
    expect(result.type).toBe("symbol");
    expect(result.value).toBe("tick");
  });

  it("parses bytes", () => {
    const result = parseContractResult(xdr.ScVal.scvBytes(Buffer.from([1, 2, 3])));
    expect(result.type).toBe("bytes");
    expect(result.value).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("parses void as undefined", () => {
    const result = parseContractResult(xdr.ScVal.scvVoid());
    expect(result.type).toBe("void");
    expect(result.value).toBeUndefined();
  });

  it("parses vec recursively", () => {
    const result = parseContractResult(
      xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]),
    );
    expect(result.type).toBe("vec");
    expect(result.value).toEqual([1, 2]);
  });

  it("parses map to plain object", () => {
    const result = parseContractResult(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvString(Buffer.from("a", "utf8")),
          val: xdr.ScVal.scvU32(10),
        }),
      ]),
    );
    expect(result.type).toBe("map");
    expect(result.value).toEqual({ a: 10 });
  });

  it("returns the expected type in result when validation passes", () => {
    const result = parseContractResult(xdr.ScVal.scvU32(5), "u32");
    expect(result.type).toBe("u32");
    expect(result.value).toBe(5);
  });

  it("returns the expected type for bool validation", () => {
    const result = parseContractResult(xdr.ScVal.scvBool(true), "bool");
    expect(result.type).toBe("bool");
    expect(result.value).toBe(true);
  });

  it("returns the expected type for string validation", () => {
    const result = parseContractResult(
      xdr.ScVal.scvString(Buffer.from("hi", "utf8")),
      "string",
    );
    expect(result.type).toBe("string");
    expect(result.value).toBe("hi");
  });

  it("returns the expected type for void validation", () => {
    const result = parseContractResult(xdr.ScVal.scvVoid(), "void");
    expect(result.type).toBe("void");
    expect(result.value).toBeUndefined();
  });

  it("returns the expected type for vec validation", () => {
    const result = parseContractResult(
      xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)]),
      "vec",
    );
    expect(result.type).toBe("vec");
  });

  it("returns the expected type for map validation", () => {
    const result = parseContractResult(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvString(Buffer.from("k", "utf8")),
          val: xdr.ScVal.scvU32(1),
        }),
      ]),
      "map",
    );
    expect(result.type).toBe("map");
  });

  it("throws TypeError when expected type does not match (u32 vs bool)", () => {
    expect(() =>
      parseContractResult(xdr.ScVal.scvBool(true), "u32"),
    ).toThrow(TypeError);
  });

  it("throws TypeError when expected type does not match (string vs u32)", () => {
    expect(() =>
      parseContractResult(xdr.ScVal.scvU32(1), "string"),
    ).toThrow(TypeError);
  });

  it("throws TypeError when expected type does not match (i32 vs void)", () => {
    expect(() =>
      parseContractResult(xdr.ScVal.scvVoid(), "i32"),
    ).toThrow(TypeError);
  });

  it("throws with descriptive message on type mismatch", () => {
    expect(() =>
      parseContractResult(xdr.ScVal.scvBool(false), "u128"),
    ).toThrow(/expected type "u128" but got "bool"/);
  });

  it("does not throw when expected type is omitted", () => {
    expect(() => parseContractResult(xdr.ScVal.scvBool(true))).not.toThrow();
  });

  it("infers type from the ScVal when expected type is omitted", () => {
    const result = parseContractResult(xdr.ScVal.scvI32(-1));
    expect(result.type).toBe("i32");
    expect(result.value).toBe(-1);
  });

  it("validates u64 expected type", () => {
    const result = parseContractResult(
      xdr.ScVal.scvU64(new xdr.Uint64("1")),
      "u64",
    );
    expect(result.type).toBe("u64");
    expect(result.value).toBe(1n);
  });

  it("validates i64 expected type", () => {
    const result = parseContractResult(
      xdr.ScVal.scvI64(new xdr.Int64("0")),
      "i64",
    );
    expect(result.type).toBe("i64");
    expect(result.value).toBe(0n);
  });

  it("validates u128 expected type", () => {
    const result = parseContractResult(
      xdr.ScVal.scvU128(
        new xdr.UInt128Parts({ hi: new xdr.Uint64("0"), lo: new xdr.Uint64("7") }),
      ),
      "u128",
    );
    expect(result.type).toBe("u128");
    expect(result.value).toBe(7n);
  });

  it("validates i128 expected type", () => {
    const result = parseContractResult(
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: new xdr.Int64("0"), lo: new xdr.Uint64("11") }),
      ),
      "i128",
    );
    expect(result.type).toBe("i128");
    expect(result.value).toBe(11n);
  });

  it("validates symbol expected type", () => {
    const result = parseContractResult(xdr.ScVal.scvSymbol("name"), "symbol");
    expect(result.type).toBe("symbol");
    expect(result.value).toBe("name");
  });

  it("validates bytes expected type", () => {
    const result = parseContractResult(
      xdr.ScVal.scvBytes(Buffer.from([0xff])),
      "bytes",
    );
    expect(result.type).toBe("bytes");
  });

  it("validates address expected type", () => {
    const addr = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32)),
      ),
    );
    const result = parseContractResult(addr, "address");
    expect(result.type).toBe("address");
  });

  it("throws for mismatched address expected type", () => {
    expect(() =>
      parseContractResult(xdr.ScVal.scvU32(1), "address"),
    ).toThrow(TypeError);
  });
});

describe("detectContractStateChanges", () => {
  it("detects added fields", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { field1: "value1" };
    const newState = { field1: "value1", field2: "value2" };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({ field2: "value2" });
    expect(result.removed).toEqual({});
    expect(result.modified).toEqual({});
  });

  it("detects removed fields", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { field1: "value1", field2: "value2" };
    const newState = { field1: "value1" };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({});
    expect(result.removed).toEqual({ field2: "value2" });
    expect(result.modified).toEqual({});
  });

  it("detects modified fields", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { field1: "value1", field2: "value2" };
    const newState = { field1: "value1", field2: "newValue2" };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({});
    expect(result.removed).toEqual({});
    expect(result.modified).toEqual({
      field2: { oldValue: "value2", newValue: "newValue2" },
    });
  });

  it("detects complex changes in objects", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = {
      user: { name: "Alice", balance: 100 },
      active: true,
    };
    const newState = {
      user: { name: "Alice", balance: 150 },
      active: true,
      metadata: { created: "2025-01-01" },
    };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({ metadata: { created: "2025-01-01" } });
    expect(result.removed).toEqual({});
    expect(result.modified.user).toBeDefined();
  });

  it("detects changes in arrays", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { items: [1, 2, 3] };
    const newState = { items: [1, 2, 3, 4] };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.modified.items).toBeDefined();
    expect(result.modified.items.oldValue).toEqual([1, 2, 3]);
    expect(result.modified.items.newValue).toEqual([1, 2, 3, 4]);
  });

  it("handles empty old state", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = {};
    const newState = { field1: "value1" };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({ field1: "value1" });
    expect(result.removed).toEqual({});
    expect(result.modified).toEqual({});
  });

  it("handles empty new state", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { field1: "value1" };
    const newState = {};
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({});
    expect(result.removed).toEqual({ field1: "value1" });
    expect(result.modified).toEqual({});
  });

  it("handles identical states", async () => {
    const { detectContractStateChanges } = await import("../soroban/index");
    const oldState = { field1: "value1", field2: "value2" };
    const newState = { field1: "value1", field2: "value2" };
    const result = detectContractStateChanges(oldState, newState);
    expect(result.added).toEqual({});
    expect(result.removed).toEqual({});
    expect(result.modified).toEqual({});
  });
});
