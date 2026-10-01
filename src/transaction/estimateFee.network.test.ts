import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Mirrors the pattern used by src/tests/estimateFeeFix.test.ts: a lightweight
// stellar-sdk surface so estimateFee can run without touching the network.
const mocks = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  isSimulationSuccess: vi.fn(),
  isSimulationError: vi.fn(),
  loadAccount: vi.fn(),
  transactionsCall: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    constructor(readonly sourceAccount: any, readonly options: any) {}
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { fee: "100", toXDR: () => MOCK_XDR };
    }
    static fromXDR(xdrString: string) {
      return { toXDR: () => xdrString };
    }
  }

  return {
    ...actual,
    BASE_FEE: "100",
    TransactionBuilder: MockTransactionBuilder,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mocks.loadAccount,
        transactions: () => ({
          order: () => ({
            limit: () => ({ call: mocks.transactionsCall }),
          }),
        }),
      })),
    },
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mocks.simulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mocks.isSimulationError,
        isSimulationSuccess: mocks.isSimulationSuccess,
      },
    },
  };
});

import {
  estimateFee,
  calculateFeeTiers,
  calculateAdaptiveFee,
  clearFeeHistory,
} from "./estimateFee";
import {
  PROTOCOL_BASE_FEE,
  NETWORK_BASE_FEE_MULTIPLIERS,
  getNetworkBaseFee,
  getNetworkBaseFeeMultiplier,
  resolveNetworkBaseFee,
} from "./feePolicy";

const MOCK_XDR = "AAAAAQAAAAA=";

const NETWORKS: Record<"mainnet" | "testnet" | "futurenet", ResolvedNetworkConfig> = {
  mainnet: {
    network: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://mainnet.example/rpc",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
  testnet: {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  futurenet: {
    network: "futurenet",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
};

function mockSimulationSuccess(minResourceFee: string): void {
  mocks.isSimulationSuccess.mockReturnValue(true);
  mocks.isSimulationError.mockReturnValue(false);
  mocks.simulateTransaction.mockResolvedValue({ minResourceFee });
}

function mockSimulationUnavailable(): void {
  mocks.isSimulationSuccess.mockReturnValue(false);
  mocks.isSimulationError.mockReturnValue(false);
  mocks.simulateTransaction.mockResolvedValue({});
}

beforeEach(() => {
  mocks.simulateTransaction.mockReset();
  mocks.isSimulationSuccess.mockReset();
  mocks.isSimulationError.mockReset();
  mocks.loadAccount.mockReset();
  mocks.transactionsCall.mockReset();
  clearFeeHistory();
});

describe("feePolicy — network base fee lookup", () => {
  it("exposes the protocol floor as 100 stroops", () => {
    expect(PROTOCOL_BASE_FEE).toBe(100);
  });

  it("uses the protocol floor on mainnet and testnet", () => {
    expect(getNetworkBaseFeeMultiplier("mainnet")).toBe(1);
    expect(getNetworkBaseFeeMultiplier("testnet")).toBe(1);
    expect(getNetworkBaseFee("mainnet")).toBe(100);
    expect(getNetworkBaseFee("testnet")).toBe(100);
  });

  it("scales the floor on futurenet", () => {
    expect(NETWORK_BASE_FEE_MULTIPLIERS.futurenet).toBe(2);
    expect(getNetworkBaseFeeMultiplier("futurenet")).toBe(2);
    expect(getNetworkBaseFee("futurenet")).toBe(200);
  });

  it("defaults unknown/custom networks to the protocol floor", () => {
    expect(getNetworkBaseFeeMultiplier("custom")).toBe(1);
    expect(getNetworkBaseFee("custom")).toBe(PROTOCOL_BASE_FEE);
    expect(getNetworkBaseFee(undefined)).toBe(PROTOCOL_BASE_FEE);
  });

  it("honours explicit overrides from a network config", () => {
    expect(resolveNetworkBaseFee({ network: "testnet", baseFeeMultiplier: 3 })).toBe(300);
    expect(getNetworkBaseFee("mainnet", { multiplier: 4 })).toBe(400);
  });
});

describe("calculateFeeTiers — network fallback", () => {
  it("falls back to the network floor when there is no fee data", () => {
    for (const key of ["mainnet", "testnet", "futurenet"] as const) {
      const base = getNetworkBaseFee(key);
      const tiers = calculateFeeTiers([], base);
      expect(tiers).toEqual({
        economy: String(base),
        standard: String(base),
        fast: String(base),
      });
    }
  });

  it("defaults to the protocol floor when no network floor is passed", () => {
    expect(calculateFeeTiers([]).standard).toBe("100");
  });

  it("still computes percentiles from valid data regardless of floor", () => {
    const tiers = calculateFeeTiers([100, 500, 900], getNetworkBaseFee("futurenet"));
    expect(tiers.economy).toBe("100");
    expect(tiers.standard).toBe("500");
    expect(tiers.fast).toBe("900");
  });
});

describe("calculateAdaptiveFee — network floor", () => {
  it("never recommends below the supplied floor", () => {
    expect(calculateAdaptiveFee(50, { baseFeeFloor: 200 })).toBe(200);
    expect(calculateAdaptiveFee(1000, { baseFeeFloor: 200 })).toBe(1000);
    expect(calculateAdaptiveFee(1000, { urgency: "low", baseFeeFloor: 200 })).toBe(500);
  });

  it("keeps urgency multipliers on top of the network floor", () => {
    expect(calculateAdaptiveFee(200, { urgency: "high", baseFeeFloor: 200 })).toBe(400);
    expect(calculateAdaptiveFee(200, { urgency: "urgent", baseFeeFloor: 200 })).toBe(1000);
  });
});

describe("estimateFee — consistent fees across network types (#705)", () => {
  it("returns the same simulated fee on every network for the same base fee", async () => {
    mockSimulationSuccess("500");

    for (const key of ["mainnet", "testnet", "futurenet"] as const) {
      const result = await estimateFee(
        NETWORKS[key].rpcUrl,
        NETWORKS[key].horizonUrl,
        NETWORKS[key],
        { kind: "xdr", transactionXdr: MOCK_XDR },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.fee).toBe("500");
        expect(result.data.simulated).toBe(true);
      }
    }
  });

  it("reports the network-specific base fee on the result", async () => {
    mockSimulationSuccess("500");

    const mainnet = await estimateFee(
      NETWORKS.mainnet.rpcUrl,
      NETWORKS.mainnet.horizonUrl,
      NETWORKS.mainnet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );
    const futurenet = await estimateFee(
      NETWORKS.futurenet.rpcUrl,
      NETWORKS.futurenet.horizonUrl,
      NETWORKS.futurenet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(mainnet.status === "ok" && mainnet.data.baseFee).toBe("100");
    expect(futurenet.status === "ok" && futurenet.data.baseFee).toBe("200");
  });

  it("uses the network-specific floor when simulation is unavailable", async () => {
    mockSimulationUnavailable();

    for (const [key, expectedBase] of [
      ["mainnet", "100"],
      ["testnet", "100"],
      ["futurenet", "200"],
    ] as const) {
      const result = await estimateFee(
        NETWORKS[key].rpcUrl,
        NETWORKS[key].horizonUrl,
        NETWORKS[key],
        { kind: "xdr", transactionXdr: MOCK_XDR },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.fee).toBe(expectedBase);
        expect(result.data.baseFee).toBe(expectedBase);
        expect(result.data.simulated).toBe(false);
      }
    }
  });

  it("clamps a below-floor simulation result up to the network base fee", async () => {
    mockSimulationSuccess("150");

    const mainnet = await estimateFee(
      NETWORKS.mainnet.rpcUrl,
      NETWORKS.mainnet.horizonUrl,
      NETWORKS.mainnet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );
    const futurenet = await estimateFee(
      NETWORKS.futurenet.rpcUrl,
      NETWORKS.futurenet.horizonUrl,
      NETWORKS.futurenet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(mainnet.status === "ok" && mainnet.data.fee).toBe("150");
    expect(futurenet.status === "ok" && futurenet.data.fee).toBe("200");
    expect(futurenet.status === "ok" && futurenet.data.baseFee).toBe("200");
  });

  it("applies urgency multipliers on top of the network floor", async () => {
    mockSimulationSuccess("40");

    const futurenet = await estimateFee(
      NETWORKS.futurenet.rpcUrl,
      NETWORKS.futurenet.horizonUrl,
      NETWORKS.futurenet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { priority: "high" },
    );

    expect(futurenet.status).toBe("ok");
    if (futurenet.status === "ok") {
      expect(futurenet.data.baseFee).toBe("200");
      expect(futurenet.data.fee).toBe("400"); // 200 floor x 2 (high)
      expect(futurenet.data.priority).toBe("high");
    }
  });

  it("honours custom priority multipliers and the network floor", async () => {
    mockSimulationSuccess("1000");

    const result = await estimateFee(
      NETWORKS.futurenet.rpcUrl,
      NETWORKS.futurenet.horizonUrl,
      NETWORKS.futurenet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { priority: "low", priorityMultipliers: { low: 1.5, normal: 1, high: 2, urgent: 5 } },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("1500");
    }
  });

  it("triggers onFeeSurge against the recent median on any network", async () => {
    mockSimulationSuccess("500");
    mocks.transactionsCall.mockResolvedValue({
      records: Array(10).fill({ fee_charged: "50" }),
    });
    const onFeeSurge = vi.fn();

    const result = await estimateFee(
      NETWORKS.futurenet.rpcUrl,
      NETWORKS.futurenet.horizonUrl,
      NETWORKS.futurenet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
      undefined,
      undefined,
      { onFeeSurge },
    );

    expect(result.status).toBe("ok");
    expect(onFeeSurge).toHaveBeenCalledOnce();
    expect(onFeeSurge).toHaveBeenCalledWith(
      expect.objectContaining({ fee: "500", baseFee: "200", surge: true }),
    );
  });

  it("does not regress the default (testnet) behaviour", async () => {
    mockSimulationSuccess("1000");

    const result = await estimateFee(
      NETWORKS.testnet.rpcUrl,
      NETWORKS.testnet.horizonUrl,
      NETWORKS.testnet,
      { kind: "xdr", transactionXdr: MOCK_XDR },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("1000");
      expect(result.data.baseFee).toBe("100");
      expect(result.data.feeXlm).toBe("0.0001000");
      expect(result.data.simulated).toBe(true);
    }
  });
});
