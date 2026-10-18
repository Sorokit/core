import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Hoisted mock factory ─────────────────────────────────────────────────────

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
  };
});

// Import under test after vi.mock so they pick up the mocked module
import {
  buildTimeLockTransaction,
  isTimeBoundsValid,
  getTimeLockStatus,
} from "./timeLocks";
import type { TimeBounds } from "./timeLocks";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_NETWORK: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const SOURCE_KEY =
  "GCFQYP2MMXX2G2PLAQP5ASKP3WBDX6IDXVBOEQOBE7HC3W3N5YX5IGOB";

/** A mock Horizon AccountRecord with a realistic sequence number. */
function makeMockAccount(sequence: string) {
  return {
    id: SOURCE_KEY,
    sequence,
    sequenceNumber: () => sequence,
    account_id: SOURCE_KEY,
    balances: [],
    subentry_count: 0,
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    signers: [],
    data: {},
    incrementSequenceNumber: vi.fn(),
  };
}

const FAR_FUTURE = 9_999_999_999; // year 2286 — safely in the future
const PAST_TIME = 1_000;          // year 1970 — safely in the past

// Clear the mock between every test to prevent state leakage
beforeEach(() => {
  mockLoadAccount.mockClear();
});

// ─── isTimeBoundsValid ───────────────────────────────────────────────────────

describe("isTimeBoundsValid", () => {
  it("accepts zero/zero (no bounds)", () => {
    expect(isTimeBoundsValid({ minTime: 0, maxTime: 0 })).toBe(true);
  });

  it("accepts valid min < max", () => {
    expect(isTimeBoundsValid({ minTime: 1000, maxTime: 2000 })).toBe(true);
  });

  it("accepts minTime === maxTime", () => {
    expect(isTimeBoundsValid({ minTime: 1000, maxTime: 1000 })).toBe(true);
  });

  it("accepts minTime only (maxTime === 0 means no upper bound)", () => {
    expect(isTimeBoundsValid({ minTime: 5000, maxTime: 0 })).toBe(true);
  });

  it("rejects inverted bounds where minTime > maxTime (and maxTime !== 0)", () => {
    expect(isTimeBoundsValid({ minTime: 3000, maxTime: 2000 })).toBe(false);
  });

  it("rejects negative minTime", () => {
    expect(isTimeBoundsValid({ minTime: -1, maxTime: 0 })).toBe(false);
  });

  it("rejects negative maxTime", () => {
    expect(isTimeBoundsValid({ minTime: 0, maxTime: -1 })).toBe(false);
  });
});

// ─── getTimeLockStatus ──────────────────────────────────────────

describe("getTimeLockStatus", () => {
  it("returns 'invalid' for inverted time bounds", () => {
    const bounds: TimeBounds = { minTime: 3000, maxTime: 2000 };
    expect(getTimeLockStatus(bounds, 2500)).toBe("invalid");
  });

  it("returns 'pending' when now < minTime", () => {
    const bounds: TimeBounds = { minTime: FAR_FUTURE, maxTime: 0 };
    const now = FAR_FUTURE - 1000;
    expect(getTimeLockStatus(bounds, now)).toBe("pending");
  });

  it("returns 'executable' when now is within bounds", () => {
    const bounds: TimeBounds = { minTime: PAST_TIME, maxTime: FAR_FUTURE };
    const now = 1_000_000_000; // comfortably within range
    expect(getTimeLockStatus(bounds, now)).toBe("executable");
  });

  it("returns 'executable' when minTime === 0 and now < maxTime", () => {
    const bounds: TimeBounds = { minTime: 0, maxTime: FAR_FUTURE };
    expect(getTimeLockStatus(bounds, 1_000_000_000)).toBe("executable");
  });

  it("returns 'expired' when now > maxTime", () => {
    const bounds: TimeBounds = { minTime: 0, maxTime: PAST_TIME };
    const now = PAST_TIME + 1;
    expect(getTimeLockStatus(bounds, now)).toBe("expired");
  });

  it("returns 'executable' when maxTime === 0 (no upper bound) and now >= minTime", () => {
    const bounds: TimeBounds = { minTime: PAST_TIME, maxTime: 0 };
    const now = 1_000_000_000;
    expect(getTimeLockStatus(bounds, now)).toBe("executable");
  });

  it("uses Date.now() when nowSeconds is omitted", () => {
    // With both bounds 0, the result should always be "executable"
    const bounds: TimeBounds = { minTime: 0, maxTime: 0 };
    expect(getTimeLockStatus(bounds)).toBe("executable");
  });
});

// ─── buildTimeLockTransaction ─────────────────────────────────────────────────

describe("buildTimeLockTransaction — sequence fetching", () => {
  const MOCK_SEQUENCE = "12345678";

  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(makeMockAccount(MOCK_SEQUENCE));
  });

  it("calls loadAccount when no sequence is provided", async () => {
    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      { timeBounds: { minTime: 0, maxTime: FAR_FUTURE } },
    );

    expect(result.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(mockLoadAccount).toHaveBeenCalledWith(SOURCE_KEY);
  });

  it("does NOT call loadAccount when a sequence is provided", async () => {
    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      {
        timeBounds: { minTime: 0, maxTime: FAR_FUTURE },
        sequence: MOCK_SEQUENCE,
      },
    );

    expect(result.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("returns a non-empty XDR string when the sequence comes from Horizon", async () => {
    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      { timeBounds: { minTime: 0, maxTime: FAR_FUTURE } },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(typeof result.data).toBe("string");
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("returns a non-empty XDR string when a caller-supplied sequence is used", async () => {
    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      {
        timeBounds: { minTime: 0, maxTime: 0 },
        sequence: "99999999",
      },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(typeof result.data).toBe("string");
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("produces different XDRs for different sequences (sequence is encoded in XDR)", async () => {
    const result1 = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      { timeBounds: { minTime: 0, maxTime: FAR_FUTURE }, sequence: "100" },
    );
    const result2 = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      { timeBounds: { minTime: 0, maxTime: FAR_FUTURE }, sequence: "200" },
    );

    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status !== "ok" || result2.status !== "ok") return;
    expect(result1.data).not.toBe(result2.data);
  });
});

describe("buildTimeLockTransaction — validation", () => {
  it("returns TX_BUILD_FAILED when time bounds are inverted", async () => {
    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      {
        timeBounds: { minTime: 9000, maxTime: 1000 },
        sequence: "1",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("returns TX_BUILD_FAILED when loadAccount rejects", async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error("network error"));

    const result = await buildTimeLockTransaction(
      TEST_NETWORK.horizonUrl,
      TEST_NETWORK,
      SOURCE_KEY,
      { timeBounds: { minTime: 0, maxTime: FAR_FUTURE } },
    );

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("TX_BUILD_FAILED");
  });
});
