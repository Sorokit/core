import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import baselineData from "./benchmarks.baseline.json";

const loadAccountMock = vi.hoisted(() => vi.fn());
const simulateTransactionMock = vi.hoisted(() => vi.fn());

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockAsset {
    constructor(
      public code: string,
      public issuer?: string,
    ) {}

    static native() {
      return new MockAsset("XLM");
    }
  }

  class MockTransactionBuilder {
    constructor(_sourceAccount: unknown, _options: unknown) {}

    addOperation() {
      return this;
    }

    setTimeout() {
      return this;
    }

    build() {
      return {
        toXDR: () => "AAAAAQAAAAA=",
      };
    }

    static fromXDR(_xdr: string) {
      return { operations: [] };
    }
  }

  return {
    ...actual,
    Asset: MockAsset,
    Operation: {
      payment: () => ({ type: "payment" }),
    },
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: loadAccountMock,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: simulateTransactionMock,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: vi.fn(() => true),
        isSimulationError: vi.fn(() => false),
      },
    },
  };
});

import { BASE_FEE, TransactionBuilder } from "@stellar/stellar-sdk";
import { estimateFee } from "../../transaction/estimateFee";
import { getAccount } from "../../account/getAccount";
import { simulateTransaction } from "../../soroban/simulateTransaction";

export interface BenchmarkBaseline {
  baselineMs: number;
  maxRegressionPct: number;
  iterations: number;
}

export interface BenchmarkResult {
  name: string;
  baselineMs: number;
  measuredMs: number;
  regressionPct: number;
  passed: boolean;
}

export interface BenchmarkReport {
  generatedAt: string;
  results: BenchmarkResult[];
}

export const benchmarkBaselines = baselineData as Record<string, BenchmarkBaseline>;

function asMs(durationNs: bigint): number {
  return Number(durationNs) / 1e6;
}

async function measureAsync(fn: () => Promise<unknown>, iterations: number): Promise<number> {
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    await fn();
  }
  const durationMs = asMs(process.hrtime.bigint() - start);
  return durationMs / iterations;
}

function measureSync(fn: () => unknown, iterations: number): number {
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    fn();
  }
  const durationMs = asMs(process.hrtime.bigint() - start);
  return durationMs / iterations;
}

function getBaseline(name: string): BenchmarkBaseline {
  const baseline = benchmarkBaselines[name];
  if (!baseline) {
    throw new Error(`No benchmark baseline found for ${name}`);
  }
  return baseline;
}

async function prepareMocks() {
  loadAccountMock.mockReset();
  simulateTransactionMock.mockReset();

  loadAccountMock.mockResolvedValue({
    account_id: "GB3N7LQ3X4PSM6V6Y4N2W4R3EJ7B3X6JDA4L2W2Y2D5F5VJ3L5MZQW",
    sequence: "1",
    subentry_count: 1,
    balances: [
      {
        balance: "100.0000000",
        asset_type: "native",
      },
      {
        balance: "10.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GA5Z5A4R5Z3D3V5P8H7F7J2K6M8N4L5U3R1V2W3X4Y5Z6A7B8C9D0",
      },
    ],
  });

  simulateTransactionMock.mockResolvedValue({
    minResourceFee: "100",
    result: { xdr: "simulated" },
  });
}

export async function runBenchmarkSuite(): Promise<BenchmarkReport> {
  await prepareMocks();

  const results = await Promise.all([
    (async () => {
      const baseline = getBaseline("xdrParsing");
      const measuredMs = await measureAsync(async () => {
        TransactionBuilder.fromXDR("AAAAAQAAAAA=", "Test SDF Network ; September 2015");
      }, baseline.iterations);
      return {
        name: "xdrParsing",
        baselineMs: baseline.baselineMs,
        measuredMs,
        regressionPct: ((measuredMs / baseline.baselineMs) - 1) * 100,
        passed: measuredMs <= baseline.baselineMs * 1.1,
      } satisfies BenchmarkResult;
    })(),
    (async () => {
      const baseline = getBaseline("feeCalculation");
      const measuredMs = await measureAsync(async () => {
        await estimateFee(
          "https://rpc.testnet.stellar.org",
          "https://horizon.testnet.stellar.org",
          {
            network: "testnet",
            horizonUrl: "https://horizon.testnet.stellar.org",
            rpcUrl: "https://rpc.testnet.stellar.org",
            networkPassphrase: "Test SDF Network ; September 2015",
          },
          {
            kind: "payment",
            publicKey: "GB3N7LQ3X4PSM6V6Y4N2W4R3EJ7B3X6JDA4L2W2Y2D5F5VJ3L5MZQW",
            destination: "GDKP2X2U3F4R5J6Q7T8V9W0X1Y2Z3A4B5C6D7E8F9G0H1J2K3L4M5N6P7",
            amount: "1",
          },
        );
      }, baseline.iterations);
      return {
        name: "feeCalculation",
        baselineMs: baseline.baselineMs,
        measuredMs,
        regressionPct: ((measuredMs / baseline.baselineMs) - 1) * 100,
        passed: measuredMs <= baseline.baselineMs * 1.1,
      } satisfies BenchmarkResult;
    })(),
    (async () => {
      const baseline = getBaseline("accountFetch");
      const measuredMs = await measureAsync(async () => {
        await getAccount(
          "https://horizon.testnet.stellar.org",
          "GB3N7LQ3X4PSM6V6Y4N2W4R3EJ7B3X6JDA4L2W2Y2D5F5VJ3L5MZQW",
        );
      }, baseline.iterations);
      return {
        name: "accountFetch",
        baselineMs: baseline.baselineMs,
        measuredMs,
        regressionPct: ((measuredMs / baseline.baselineMs) - 1) * 100,
        passed: measuredMs <= baseline.baselineMs * 1.1,
      } satisfies BenchmarkResult;
    })(),
    (async () => {
      const baseline = getBaseline("contractSimulation");
      const measuredMs = await measureAsync(async () => {
        await simulateTransaction(
          "https://rpc.testnet.stellar.org",
          "Test SDF Network ; September 2015",
          "AAAAAQAAAAA=",
        );
      }, baseline.iterations);
      return {
        name: "contractSimulation",
        baselineMs: baseline.baselineMs,
        measuredMs,
        regressionPct: ((measuredMs / baseline.baselineMs) - 1) * 100,
        passed: measuredMs <= baseline.baselineMs * 1.1,
      } satisfies BenchmarkResult;
    })(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    results,
  };
}

export async function evaluateBenchmarks(outputFile?: string): Promise<BenchmarkReport> {
  const report = await runBenchmarkSuite();
  if (outputFile) {
    writeFileSync(resolve(outputFile), JSON.stringify(report, null, 2));
  }
  return report;
}

beforeEach(async () => {
  await prepareMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});
