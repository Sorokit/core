import { describe, expect, it, vi } from "vitest";
import { getFactoryStatistics } from "../soroban/factoryStatistics";

describe("factory statistics endpoint logic", () => {
  it("returns the standard structured response", async () => {
    const result = await getFactoryStatistics("CFACTORY", {
      getTotalPairs: vi.fn().mockResolvedValue(12),
      getDeploymentMetadata: vi.fn().mockResolvedValue({
        network: "testnet",
        ledger: 123,
        deployedAt: "2026-07-29T00:00:00.000Z",
      }),
    });
    expect(result).toEqual({
      status: "ok",
      error: null,
      data: {
        factoryId: "CFACTORY",
        totalPairs: 12,
        deployment: {
          network: "testnet",
          ledger: 123,
          deployedAt: "2026-07-29T00:00:00.000Z",
        },
      },
    });
  });
});
