import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateHealthScore } from "./healthScore";
import { getAccount } from "./getAccount";
import { getSigners, getThresholds } from "./signers";
import { ok } from "../shared/response";

vi.mock("./getAccount", () => ({ getAccount: vi.fn() }));
vi.mock("./signers", () => ({ getSigners: vi.fn(), getThresholds: vi.fn() }));

const mockGetAccount = vi.mocked(getAccount);
const mockGetSigners = vi.mocked(getSigners);
const mockGetThresholds = vi.mocked(getThresholds);
const publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const horizonUrl = "https://horizon-testnet.stellar.org";

function configure(balance: string, signers = [
  { key: publicKey, type: "master", weight: 0 },
  { key: "GA1", type: "ed25519_public_key", weight: 1 },
  { key: "GB1", type: "ed25519_public_key", weight: 1 },
  { key: "GC1", type: "ed25519_public_key", weight: 1 },
]) {
  mockGetAccount.mockResolvedValue(ok({
    publicKey,
    displayAddress: publicKey,
    sequence: "1",
    subentryCount: 2,
    balances: [{
      assetType: "native",
      assetCode: "XLM",
      assetIssuer: null,
      balance,
      balanceFloat: Number(balance),
    }],
  }));
  mockGetSigners.mockResolvedValue(ok({ masterWeight: 0, signers }));
  mockGetThresholds.mockResolvedValue(ok({ low: 1, medium: 2, high: 3 }));
}

describe("calculateHealthScore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scores a funded multisig account with backup signers as safe", async () => {
    configure("100");

    const result = await calculateHealthScore(horizonUrl, publicKey);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.riskLevel).toBe("safe");
      expect(result.data.balanceRatio).toBeGreaterThan(0.9);
      expect(result.data.hasRecoverySigner).toBe(true);
      expect(result.data.risks).toEqual([]);
    }
  });

  it("marks a balance below the estimated native reserve as critical", async () => {
    configure("1");

    const result = await calculateHealthScore(horizonUrl, publicKey);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.riskLevel).toBe("critical");
      expect(result.data.spendableNativeBalance).toBe(0);
      expect(result.data.risks.some((risk) => risk.includes("minimum reserve"))).toBe(true);
    }
  });

  it("warns when no backup signer is configured", async () => {
    configure("100", [{ key: publicKey, type: "master", weight: 1 }]);

    const result = await calculateHealthScore(horizonUrl, publicKey);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.hasRecoverySigner).toBe(false);
      expect(result.data.risks).toContain("No active backup signer is configured.");
      expect(result.data.score).toBeLessThan(result.data.security.score);
    }
  });
});