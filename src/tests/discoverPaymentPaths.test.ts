import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createInMemoryCache } from "../shared/cache";

const mockStrictReceivePaths = vi.fn();
const mockCall = vi.fn();

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    strictReceivePaths: mockStrictReceivePaths,
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

const HORIZON_URL = "https://example.invalid";
const SOURCE = Keypair.random().publicKey();
const EURC_ISSUER = Keypair.random().publicKey();
const HOP_ISSUER = Keypair.random().publicKey();

function pathRecord(sourceAmount: string, hops: { code: string; issuer: string }[] = []) {
  return {
    source_amount: sourceAmount,
    destination_amount: "100.0000000",
    path: hops.map((h) => ({
      asset_type: "credit_alphanum4",
      asset_code: h.code,
      asset_issuer: h.issuer,
    })),
  };
}

describe("discoverPaymentPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStrictReceivePaths.mockReturnValue({ call: mockCall });
  });

  it("discovers and ranks paths by required source amount, cheapest first", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockResolvedValue({
      records: [
        pathRecord("120.0000000"),
        pathRecord("95.0000000", [{ code: "USDC", issuer: HOP_ISSUER }]),
        pathRecord("110.0000000"),
      ],
    });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.paths).toHaveLength(3);
      expect(result.data.paths[0]?.sourceAmount).toBe("95.0000000");
      expect(result.data.paths[1]?.sourceAmount).toBe("110.0000000");
      expect(result.data.paths[2]?.sourceAmount).toBe("120.0000000");
      expect(result.data.fromCache).toBe(false);
    }
  });

  it("returns source/output amounts for each discovered path", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockResolvedValue({
      records: [pathRecord("95.0000000", [{ code: "USDC", issuer: HOP_ISSUER }])],
    });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const path = result.data.paths[0];
      expect(path?.sourceAmount).toBe("95.0000000");
      expect(path?.destinationAmount).toBe("100.0000000");
      expect(path?.hops).toBe(1);
      expect(path?.path).toEqual([{ assetCode: "USDC", assetIssuer: HOP_ISSUER }]);
    }
  });

  it("caps results at three preferred paths even when more are returned", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockResolvedValue({
      records: [
        pathRecord("100"),
        pathRecord("101"),
        pathRecord("102"),
        pathRecord("103"),
        pathRecord("104"),
      ],
    });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.paths).toHaveLength(3);
      expect(result.data.paths.map((p) => p.sourceAmount)).toEqual(["100", "101", "102"]);
    }
  });

  it("handles the no-viable-path case without error", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockResolvedValue({ records: [] });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.paths).toEqual([]);
    }
  });

  it("rejects a non-positive destination amount", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "0",
    );

    expect(result.status).toBe("error");
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("surfaces a Horizon query failure as an error result", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockRejectedValue(new Error("network unreachable"));

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      SOURCE,
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("path discovery failed");
    }
  });

  describe("caching", () => {
    it("caches discovered paths and serves a cache hit without querying Horizon again", async () => {
      const { discoverPaymentPaths } = await import("../transaction/pathPayment");
      const cache = createInMemoryCache();

      mockCall.mockResolvedValue({
        records: [pathRecord("95.0000000")],
      });

      const first = await discoverPaymentPaths(
        HORIZON_URL,
        SOURCE,
        { code: "EURC", issuer: EURC_ISSUER },
        "100",
        { cache },
      );
      expect(first.status).toBe("ok");
      if (first.status === "ok") expect(first.data.fromCache).toBe(false);
      expect(mockCall).toHaveBeenCalledTimes(1);

      const second = await discoverPaymentPaths(
        HORIZON_URL,
        SOURCE,
        { code: "EURC", issuer: EURC_ISSUER },
        "100",
        { cache },
      );
      expect(second.status).toBe("ok");
      if (second.status === "ok") {
        expect(second.data.fromCache).toBe(true);
        expect(second.data.paths[0]?.sourceAmount).toBe("95.0000000");
      }
      // No second Horizon query was made — served entirely from cache.
      expect(mockCall).toHaveBeenCalledTimes(1);
    });

    it("uses the default 5-minute TTL when none is provided", async () => {
      const { discoverPaymentPaths, DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS } = await import(
        "../transaction/pathPayment"
      );
      expect(DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS).toBe(5 * 60 * 1000);

      const setSpy = vi.fn();
      const cache = { get: vi.fn(() => null), set: setSpy, invalidate: vi.fn(), clear: vi.fn() };

      mockCall.mockResolvedValue({ records: [pathRecord("95")] });

      await discoverPaymentPaths(
        HORIZON_URL,
        SOURCE,
        { code: "EURC", issuer: EURC_ISSUER },
        "100",
        { cache },
      );

      expect(setSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
      );
    });

    it("does not treat a cached result as guaranteed — fromCache is surfaced to the caller", async () => {
      // This is a documentation-level assertion: the API must expose
      // whether a result was cached so integrators can decide how much to
      // trust it as current liquidity, per the issue's stale-cache warning.
      const { discoverPaymentPaths } = await import("../transaction/pathPayment");
      const cache = createInMemoryCache();

      mockCall.mockResolvedValue({ records: [pathRecord("95")] });

      await discoverPaymentPaths(
        HORIZON_URL,
        SOURCE,
        { code: "EURC", issuer: EURC_ISSUER },
        "100",
        { cache },
      );
      const cached = await discoverPaymentPaths(
        HORIZON_URL,
        SOURCE,
        { code: "EURC", issuer: EURC_ISSUER },
        "100",
        { cache },
      );

      expect(cached.status).toBe("ok");
      if (cached.status === "ok") {
        expect(cached.data).toHaveProperty("fromCache", true);
      }
    });
  });

  it("accepts an explicit list of candidate source assets instead of an account key", async () => {
    const { discoverPaymentPaths } = await import("../transaction/pathPayment");

    mockCall.mockResolvedValue({ records: [pathRecord("95")] });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      [{ code: "XLM", issuer: null }],
      { code: "EURC", issuer: EURC_ISSUER },
      "100",
    );

    expect(result.status).toBe("ok");
    expect(mockStrictReceivePaths).toHaveBeenCalled();
  });
});
