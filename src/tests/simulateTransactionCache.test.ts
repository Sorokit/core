/**
 * Tests for simulateTransaction's result caching (Issue #856).
 *
 * Verifies:
 *   - A repeated simulation of the same contract call (same contractId,
 *     method, and args) is served from cache with no second RPC call.
 *   - The cache key created by createSimulationCacheKey is scoped to the
 *     contract call identity, so a different method/args produces a miss.
 *   - The default TTL (5 minutes) and a custom ttlMs are both honored.
 *   - A simulation without a cache passed does not throw and does not cache.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryCache } from "../shared/cache";
import { simulateTransaction } from "../soroban/simulateTransaction";

const { mockSimulateTransaction, mockIsSimulationSuccess, mockIsSimulationError } =
  vi.hoisted(() => ({
    mockSimulateTransaction: vi.fn(),
    mockIsSimulationSuccess: vi.fn(),
    mockIsSimulationError: vi.fn(),
  }));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mockIsSimulationError,
        isSimulationSuccess: mockIsSimulationSuccess,
      },
    },
  };
});

function randomContractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";

function buildInvocationXdr(contractId: string, method: string, args: string[] = []) {
  const source = Keypair.random();
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => nativeToScVal(a, { type: "string" }));
  const op = contract.call(method, ...scArgs);
  const account = new Account(source.publicKey(), "1");
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}

const MOCK_SUCCESS_RESULT = {
  result: { retval: {} },
  minResourceFee: "100",
  transactionData: { build: () => ({ toXDR: () => "mock-resource-data" }) },
};

function setupMocks() {
  mockSimulateTransaction.mockReset();
  mockSimulateTransaction.mockResolvedValue(MOCK_SUCCESS_RESULT);
  mockIsSimulationError.mockReset();
  mockIsSimulationError.mockReturnValue(false);
  mockIsSimulationSuccess.mockReset();
  mockIsSimulationSuccess.mockReturnValue(true);
}

describe("simulateTransaction — cache behaviour (#856)", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("caches a successful simulation — a repeated identical call is a cache hit with no second RPC call", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const xdr = buildInvocationXdr(contractId, "balance", ["GABC"]);

    const first = await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache });
    expect(first.ok).toBe(true);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    const second = await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache });
    expect(second.ok).toBe(true);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    if (second.ok) {
      expect(second.value).toEqual(first.ok ? first.value : undefined);
    }
  });

  it("misses the cache for a different method on the same contract", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const balanceXdr = buildInvocationXdr(contractId, "balance", ["GABC"]);
    const transferXdr = buildInvocationXdr(contractId, "transfer", ["GABC", "GXYZ", "10"]);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, balanceXdr, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, transferXdr, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("misses the cache for the same method on a different contract", async () => {
    const cache = createInMemoryCache();
    const xdrA = buildInvocationXdr(randomContractId(), "balance", ["GABC"]);
    const xdrB = buildInvocationXdr(randomContractId(), "balance", ["GABC"]);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdrA, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdrB, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("uses the default TTL of 5 minutes when none is passed", async () => {
    const cache = createInMemoryCache();
    const setSpy = vi.spyOn(cache, "set");
    const xdr = buildInvocationXdr(randomContractId(), "balance", ["GABC"]);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache });

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.anything(), 5 * 60 * 1000);
  });

  it("respects a custom ttlMs", async () => {
    const cache = createInMemoryCache();
    const setSpy = vi.spyOn(cache, "set");
    const xdr = buildInvocationXdr(randomContractId(), "balance", ["GABC"]);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache, ttlMs: 1000 });

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.anything(), 1000);
  });

  it("does not throw and does not cache when no cache is passed", async () => {
    const xdr = buildInvocationXdr(randomContractId(), "balance", ["GABC"]);

    const result = await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr);
    expect(result.ok).toBe(true);

    const second = await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr);
    expect(second.ok).toBe(true);
    // No cache supplied, so both calls must hit the RPC.
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("invalidate() on the cache forces the next call to hit the RPC again", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const xdr = buildInvocationXdr(contractId, "balance", ["GABC"]);

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    cache.clear();

    await simulateTransaction(RPC_URL, NETWORK_PASSPHRASE, xdr, { cache });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });
});
