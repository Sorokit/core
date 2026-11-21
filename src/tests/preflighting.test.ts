import { describe, expect, it } from "vitest";
import { preflightTransaction } from "../transaction/preflighting";
import type { AccountInfo } from "../account/types";

describe("Transaction Preflighting (#952)", () => {
  const mockAccount: AccountInfo = {
    publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAc4SGS7N7M6K",
    sequence: "100",
    balances: [
      {
        assetType: "native",
        balance: "10.0000000",
      },
    ],
    subentryCount: 0,
    thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
    signers: [],
    data: {},
    flags: { authRequired: false, authRevocable: false, authImmutable: false, authClawbackEnabled: false },
  };

  it("validates correct sequence number (current + 1)", async () => {
    const res = await preflightTransaction(
      { sequence: "101", fee: "100" },
      mockAccount.publicKey,
      { account: mockAccount },
    );

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.sequenceValid).toBe(true);
      expect(res.data.currentSequence).toBe("100");
      expect(res.data.expectedSequence).toBe("101");
      expect(res.data.sufficientBalance).toBe(true);
      expect(res.data.estimatedFee).toBe("100");
    }
  });

  it("detects sequence number mismatch", async () => {
    const res = await preflightTransaction(
      { sequence: "105", fee: "100" },
      mockAccount.publicKey,
      { account: mockAccount },
    );

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.sequenceValid).toBe(false);
      expect(res.data.warnings.length).toBeGreaterThan(0);
      expect(res.data.warnings[0]).toContain("Sequence mismatch");
    }
  });

  it("warns on insufficient balance", async () => {
    const lowBalanceAccount: AccountInfo = {
      ...mockAccount,
      balances: [
        {
          assetType: "native",
          balance: "0.0000010",
        },
      ],
    };

    const res = await preflightTransaction(
      { sequence: "101", fee: "1000000" },
      lowBalanceAccount.publicKey,
      { account: lowBalanceAccount },
    );

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.sufficientBalance).toBe(false);
      expect(res.data.warnings.some((w) => w.includes("Insufficient balance"))).toBe(true);
    }
  });

  it("warns on low balance near minimum reserve", async () => {
    const accountNearReserve: AccountInfo = {
      ...mockAccount,
      balances: [
        {
          assetType: "native",
          balance: "1.0000050",
        },
      ],
    };

    const res = await preflightTransaction(
      { sequence: "101", fee: "100" },
      accountNearReserve.publicKey,
      { account: accountNearReserve, minBalanceReserve: "1.0" },
    );

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.sufficientBalance).toBe(true);
      expect(res.data.warnings.some((w) => w.includes("Low balance warning"))).toBe(true);
    }
  });
});
