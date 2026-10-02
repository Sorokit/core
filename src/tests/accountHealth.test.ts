import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessAccountHealth,
  getAccountHealthScore,
  type AccountHealthInput,
} from "../account/accountHealth";
import { getSigners, getThresholds } from "../account/signers";
import type { AccountSigner } from "../account/signers";
import { err, ok, SorokitErrorCode } from "../shared/response";

vi.mock("../account/signers", () => ({
  getSigners: vi.fn(),
  getThresholds: vi.fn(),
}));

const mockGetSigners = vi.mocked(getSigners);
const mockGetThresholds = vi.mocked(getThresholds);

const HORIZON = "https://horizon-testnet.stellar.org";
const PUBLIC_KEY = "GACCOUNT1234567890123456789012345678901234567890ABCDEF";

function signer(
  key: string,
  weight: number,
  type = "ed25519_public_key",
): AccountSigner {
  return { key, type, weight };
}

/** Three equally weighted signers plus a disabled master key: a healthy setup. */
const HEALTHY: AccountHealthInput = {
  publicKey: PUBLIC_KEY,
  masterWeight: 0,
  thresholds: { low: 1, medium: 2, high: 3 },
  signers: [signer("GA1", 1), signer("GB1", 1), signer("GC1", 1)],
};

describe("assessAccountHealth", () => {
  it("scores a well-configured multisig account as low risk", () => {
    const report = assessAccountHealth(HEALTHY);

    expect(report.components).toEqual({
      masterWeight: 10,
      thresholds: 10,
      diversity: 9,
    });
    // 0.4 * 10 + 0.3 * 10 + 0.3 * 9 = 9.7 → 97
    expect(report.score).toBe(97);
    expect(report.riskLevel).toBe("low");
    expect(report.risks).toEqual([]);
    expect(report.activeSigners).toBe(3);
    expect(report.totalWeight).toBe(3);
  });

  it("treats a disabled master key as the safest configuration", () => {
    const report = assessAccountHealth(HEALTHY);

    expect(report.components.masterWeight).toBe(10);
    expect(report.riskDetails.some((r) => r.id.startsWith("master."))).toBe(false);
  });

  it("flags an enabled master key that stays below the low threshold", () => {
    const report = assessAccountHealth({
      masterWeight: 1,
      thresholds: { low: 2, medium: 3, high: 4 },
      signers: [
        signer(PUBLIC_KEY, 1, "master"),
        signer("GA1", 2),
        signer("GB1", 2),
      ],
    });

    expect(report.components.masterWeight).toBe(8);
    expect(report.riskDetails.map((r) => r.id)).toContain("master.enabled");
  });

  it("flags a master key that can single-handedly meet the high threshold", () => {
    const report = assessAccountHealth({
      masterWeight: 255,
      thresholds: { low: 1, medium: 2, high: 3 },
      signers: [signer(PUBLIC_KEY, 255, "master")],
    });

    const ids = report.riskDetails.map((r) => r.id);
    expect(ids).toContain("master.enabled");
    expect(ids).toContain("master.meets-high");
    expect(ids).toContain("master.sole-signer");
    expect(report.components.masterWeight).toBe(1);
    expect(report.riskDetails.find((r) => r.id === "master.meets-high")?.severity).toBe(
      "critical",
    );
    expect(report.riskLevel).toBe("elevated");
  });

  it("flags a single-signer account as risky", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 0, medium: 0, high: 1 },
      signers: [signer("GA1", 1)],
    });

    expect(report.components.diversity).toBe(3);
    expect(report.riskDetails.map((r) => r.id)).toContain(
      "diversity.single-signer",
    );
  });

  it("flags unordered thresholds", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 3, medium: 1, high: 2 },
      signers: [signer("GA1", 3)],
    });

    expect(report.riskDetails.map((r) => r.id)).toContain("thresholds.unordered");
    expect(report.components.thresholds).toBeLessThan(10);
  });

  it("flags an unprotected high threshold of zero", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 0, medium: 0, high: 0 },
      signers: [signer("GA1", 1)],
    });

    expect(report.riskDetails.map((r) => r.id)).toContain("thresholds.high-zero");
    expect(report.components.thresholds).toBeLessThan(5);
  });

  it("flags thresholds the signer set cannot reach (lock-out risk)", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 2, high: 5 },
      signers: [signer("GA1", 2), signer("GB1", 1)],
    });

    const unreachable = report.riskDetails.find(
      (r) => r.id === "thresholds.high-unreachable",
    );
    expect(unreachable).toBeDefined();
    expect(unreachable?.severity).toBe("critical");
    expect(report.components.thresholds).toBeLessThanOrEqual(6);
  });

  it("flags a signer whose weight alone meets the high threshold", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 1, high: 3 },
      signers: [signer("GA1", 5), signer("GB1", 1)],
    });

    expect(report.riskDetails.map((r) => r.id)).toContain(
      "diversity.dominant-signer",
    );
    expect(report.components.diversity).toBe(4);
  });

  it("flags duplicate signer keys", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 2, high: 3 },
      signers: [signer("GA1", 1), signer("GA1", 1), signer("GB1", 1)],
    });

    expect(report.riskDetails.map((r) => r.id)).toContain(
      "diversity.duplicate-signers",
    );
    // Duplicate weights are summed: GA1 = 2, GB1 = 1.
    expect(report.totalWeight).toBe(3);
    expect(report.activeSigners).toBe(2);
  });

  it("reports zero diversity when no signer carries weight", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 2, high: 3 },
      signers: [signer("GA1", 0), signer("GB1", 0)],
    });

    expect(report.components.diversity).toBe(0);
    expect(report.riskDetails.map((r) => r.id)).toContain("diversity.no-signers");
    expect(report.score).toBeLessThan(70);
  });

  it("flags a master key that can meet the medium or low threshold", () => {
    const medium = assessAccountHealth({
      masterWeight: 2,
      thresholds: { low: 1, medium: 2, high: 3 },
      signers: [signer(PUBLIC_KEY, 2, "master"), signer("GA1", 1), signer("GB1", 1)],
    });
    const low = assessAccountHealth({
      masterWeight: 1,
      thresholds: { low: 1, medium: 2, high: 3 },
      signers: [signer(PUBLIC_KEY, 1, "master"), signer("GA1", 1), signer("GB1", 1)],
    });

    expect(medium.riskDetails.map((r) => r.id)).toContain("master.meets-medium");
    expect(medium.components.masterWeight).toBe(3);
    expect(low.riskDetails.map((r) => r.id)).toContain("master.meets-low");
    expect(low.components.masterWeight).toBe(5);
  });

  it("notes an extreme but reachable high threshold", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 1, high: 255 },
      signers: [signer("GA1", 255)],
    });

    expect(report.riskDetails.map((r) => r.id)).toContain("thresholds.high-max");
  });

  it("awards full diversity credit to four or more signers", () => {
    const report = assessAccountHealth({
      masterWeight: 0,
      thresholds: { low: 1, medium: 2, high: 4 },
      signers: [
        signer("GA1", 1),
        signer("GB1", 1),
        signer("GC1", 1),
        signer("GD1", 1),
      ],
    });

    expect(report.components.diversity).toBe(10);
    expect(report.activeSigners).toBe(4);
  });

  it("keeps the score within 0-100 for extreme configurations", () => {
    const report = assessAccountHealth({
      masterWeight: 255,
      thresholds: { low: 255, medium: 255, high: 255 },
      signers: [signer(PUBLIC_KEY, 255, "master"), signer("GA1", 255)],
    });

    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(report.score)).toBe(true);
  });

  it("mirrors riskDetails summaries in the risks array", () => {
    const report = assessAccountHealth({
      masterWeight: 4,
      thresholds: { low: 3, medium: 2, high: 1 },
      signers: [signer(PUBLIC_KEY, 4, "master")],
    });

    expect(report.risks).toEqual(report.riskDetails.map((r) => r.summary));
    expect(report.risks.length).toBeGreaterThan(0);
  });

  it("is deterministic for a fixed timestamp", () => {
    const options = { now: 1_700_000_000_000 };
    const first = assessAccountHealth(HEALTHY, options);
    const second = assessAccountHealth(HEALTHY, options);

    expect(first).toEqual(second);
    expect(first.assessedAt).toBe(new Date(options.now).toISOString());
  });

  it("clamps out-of-range weights and handles missing signers", () => {
    const report = assessAccountHealth({
      masterWeight: -5,
      thresholds: { low: 0, medium: 0, high: 0 },
    });

    expect(report.masterWeight).toBe(0);
    expect(report.totalWeight).toBe(0);
    expect(report.activeSigners).toBe(0);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe("getAccountHealthScore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches signers and thresholds and returns a health report", async () => {
    mockGetSigners.mockResolvedValue(
      ok({
        masterWeight: 0,
        signers: [
          signer(PUBLIC_KEY, 0, "master"),
          signer("GA1", 1),
          signer("GB1", 1),
          signer("GC1", 1),
        ],
      }),
    );
    mockGetThresholds.mockResolvedValue(
      ok({ low: 1, medium: 2, high: 3 }),
    );

    const result = await getAccountHealthScore(HORIZON, PUBLIC_KEY);

    expect(mockGetSigners).toHaveBeenCalledWith(HORIZON, PUBLIC_KEY);
    expect(mockGetThresholds).toHaveBeenCalledWith(HORIZON, PUBLIC_KEY);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.score).toBeGreaterThanOrEqual(0);
      expect(result.data.score).toBeLessThanOrEqual(100);
      expect(result.data.components.masterWeight).toBe(10);
      expect(result.data.risks).toEqual([]);
    }
  });

  it("propagates ACCOUNT_NOT_FOUND from the signer fetch", async () => {
    mockGetSigners.mockResolvedValue(
      err(SorokitErrorCode.ACCOUNT_NOT_FOUND, `Account not found: ${PUBLIC_KEY}`),
    );
    mockGetThresholds.mockResolvedValue(ok({ low: 1, medium: 2, high: 3 }));

    const result = await getAccountHealthScore(HORIZON, PUBLIC_KEY);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("propagates errors from the threshold fetch", async () => {
    mockGetSigners.mockResolvedValue(
      ok({ masterWeight: 0, signers: [signer(PUBLIC_KEY, 0, "master")] }),
    );
    mockGetThresholds.mockResolvedValue(
      err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "boom"),
    );

    const result = await getAccountHealthScore(HORIZON, PUBLIC_KEY);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
    }
  });
});
