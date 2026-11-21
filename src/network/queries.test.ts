import { Asset } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { LiquidityPool } from "./queries";

// Mock only Horizon server construction so no request leaves the process.
// `horizon.calls` records every builder method invoked, in order, and
// `horizon.call` is what the Horizon call resolves or rejects with.
const horizon = vi.hoisted(() => ({
  call: vi.fn(),
  calls: [] as Array<[string, unknown[]]>,
  urls: [] as string[],
}));

vi.mock("../shared/serverFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/serverFactory")>();
  return {
    ...actual,
    createHorizonServer: vi.fn((url: string) => {
      horizon.urls.push(url);
      const builder: Record<string, unknown> = { call: horizon.call };
      for (const name of ["forAccount", "forAssets", "limit", "cursor", "order"]) {
        builder[name] = (...args: unknown[]) => {
          horizon.calls.push([name, args]);
          return builder;
        };
      }
      return { liquidityPools: () => builder };
    }),
  };
});

import * as sorokit from "../index";
import * as networkModule from "./index";
import { getLiquidityPoolByAssets, getLiquidityPools } from "./queries";
import { resolveAccountQueryHorizonUrl } from "../account/paymentHistory";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = { code: "USDC", issuer: ISSUER };
const EURT = { code: "EURT", issuer: ACCOUNT };

function poolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "a".repeat(64),
    paging_token: "a".repeat(64),
    fee_bp: 30,
    type: "constant_product",
    total_trustlines: "12",
    total_shares: "1000.0000000",
    reserves: [
      { asset: "native", amount: "100.0000000" },
      { asset: `USDC:${ISSUER}`, amount: "50.0000000" },
    ],
    last_modified_ledger: 555,
    last_modified_time: "2026-11-21T10:00:00Z",
    ...overrides,
  };
}

const respond = (records: unknown[]) => horizon.call.mockResolvedValue({ records });
const used = (name: string) => horizon.calls.filter(([n]) => n === name).map(([, args]) => args);
const horizonError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status } });

function expectOk(result: SorokitResult<LiquidityPool[]>): LiquidityPool[] {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

function expectError(result: SorokitResult<LiquidityPool[]>) {
  if (result.status !== "error") throw new Error("expected an error result");
  return result.error;
}

beforeEach(() => {
  horizon.call.mockReset();
  horizon.calls.length = 0;
  horizon.urls.length = 0;
  respond([poolRecord()]);
});

describe("getLiquidityPools", () => {
  it("maps a pool with its fee, shares and reserves", async () => {
    const [pool] = expectOk(await getLiquidityPools());

    expect(pool).toEqual({
      id: "a".repeat(64),
      pagingToken: "a".repeat(64),
      type: "constant_product",
      feeBps: 30,
      feePercent: 0.3,
      totalTrustlines: 12,
      totalShares: "1000.0000000",
      reserves: [
        { asset: "native", code: "XLM", amount: "100.0000000" },
        { asset: `USDC:${ISSUER}`, code: "USDC", issuer: ISSUER, amount: "50.0000000" },
      ],
      lastModifiedLedger: 555,
      lastModifiedTime: "2026-11-21T10:00:00Z",
    });
  });

  it("returns an empty list when there are no pools", async () => {
    respond([]);

    expect(expectOk(await getLiquidityPools())).toEqual([]);
  });

  it("applies no filters by default and asks for 10 pools", async () => {
    await getLiquidityPools();

    expect(used("forAccount")).toEqual([]);
    expect(used("forAssets")).toEqual([]);
    expect(used("limit")).toEqual([[10]]);
    expect(used("cursor")).toEqual([]);
    expect(used("order")).toEqual([]);
  });

  describe("account filter", () => {
    it("passes the account to Horizon", async () => {
      await getLiquidityPools({ account: ACCOUNT });

      expect(used("forAccount")).toEqual([[ACCOUNT]]);
    });

    it.each([["a malformed key", "not-a-key"], ["an empty string", ""]])(
      "rejects %s without calling Horizon",
      async (_name, account) => {
        const error = expectError(await getLiquidityPools({ account }));

        expect(error.code).not.toBe(SorokitErrorCode.NETWORK_ERROR);
        expect(horizon.urls).toEqual([]);
      },
    );
  });

  describe("asset filter", () => {
    it("filters by one asset", async () => {
      await getLiquidityPools({ assets: [USDC] });

      const [[asset]] = used("forAssets") as Asset[][];
      expect(asset.getCode()).toBe("USDC");
      expect(asset.getIssuer()).toBe(ISSUER);
    });

    it("filters by two assets, treating XLM as native", async () => {
      await getLiquidityPools({ assets: [{ code: "XLM" }, USDC] });

      const [[native, issued]] = used("forAssets") as Asset[][];
      expect(native.isNative()).toBe(true);
      expect(issued.getCode()).toBe("USDC");
    });

    it("accepts Asset instances", async () => {
      await getLiquidityPools({ assets: [Asset.native(), new Asset("USDC", ISSUER)] });

      expect((used("forAssets")[0] as Asset[]).map((a) => a.getCode())).toEqual(["XLM", "USDC"]);
    });

    it.each([
      ["an empty list", []],
      ["three assets", [USDC, EURT, { code: "XLM" }]],
      ["a non-array", "USDC"],
      ["an asset without an issuer", [{ code: "USDC" }]],
      ["a bad asset code", [{ code: "US DC", issuer: ISSUER }]],
      ["a bad issuer", [{ code: "USDC", issuer: "nope" }]],
      ["a non-object asset", [null]],
    ])("rejects %s without calling Horizon", async (_name, assets) => {
      const error = expectError(
        await getLiquidityPools({ assets: assets as unknown as LiquidityPoolAssetList }),
      );

      expect(error.code).toBeDefined();
      expect(horizon.urls).toEqual([]);
    });
  });

  describe("pagination", () => {
    it.each([
      [undefined, 10],
      [25, 25],
      [200, 200],
      [500, 200],
      [0, 1],
      [-5, 1],
      [7.9, 7],
      [Number.NaN, 10],
    ])("limit %s becomes %i", async (limit, expected) => {
      await getLiquidityPools({ limit });

      expect(used("limit")).toEqual([[expected]]);
    });

    it("passes the cursor and order", async () => {
      await getLiquidityPools({ cursor: "token-9", order: "desc" });

      expect(used("cursor")).toEqual([["token-9"]]);
      expect(used("order")).toEqual([["desc"]]);
    });

    it("pages by using the last pagingToken as the next cursor", async () => {
      respond([poolRecord({ id: "1", paging_token: "tok-1" }), poolRecord({ id: "2", paging_token: "tok-2" })]);
      const first = expectOk(await getLiquidityPools({ limit: 2 }));

      respond([poolRecord({ id: "3", paging_token: "tok-3" })]);
      await getLiquidityPools({ limit: 2, cursor: first[first.length - 1].pagingToken });

      expect(used("cursor")).toEqual([["tok-2"]]);
    });
  });

  describe("Horizon URL", () => {
    it("uses the default when none is given", async () => {
      await getLiquidityPools();

      expect(horizon.urls).toEqual([resolveAccountQueryHorizonUrl()]);
    });

    it("uses an explicit URL", async () => {
      await getLiquidityPools({ horizonUrl: "https://horizon.example.org" });

      expect(horizon.urls).toEqual(["https://horizon.example.org"]);
    });
  });

  describe("failures", () => {
    it("maps a server error to SERVICE_UNAVAILABLE, flagged retryable", async () => {
      horizon.call.mockRejectedValue(horizonError(500, "Internal Server Error"));

      const error = expectError(await getLiquidityPools());

      expect(error.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
      expect(error.recovery?.retryable).toBe(true);
    });

    it("flags a rate limit as retryable", async () => {
      horizon.call.mockRejectedValue(horizonError(429, "Too Many Requests"));

      expect(expectError(await getLiquidityPools()).recovery?.retryable).toBe(true);
    });

    it("maps a network failure to NETWORK_ERROR and keeps the cause", async () => {
      const failure = new Error("socket hang up");
      horizon.call.mockRejectedValue(failure);

      const error = expectError(await getLiquidityPools());

      expect(error.code).toBe(SorokitErrorCode.NETWORK_ERROR);
      expect(error.cause).toBe(failure);
    });

    it("never throws, even for a non-Error rejection", async () => {
      horizon.call.mockRejectedValue("boom");

      await expect(getLiquidityPools()).resolves.toMatchObject({ status: "error" });
    });
  });
});

describe("getLiquidityPoolByAssets", () => {
  const nativeUsdc = poolRecord({ id: "native-usdc" });
  const usdcEurt = poolRecord({
    id: "usdc-eurt",
    reserves: [
      { asset: `EURT:${ACCOUNT}`, amount: "10.0000000" },
      { asset: `USDC:${ISSUER}`, amount: "20.0000000" },
    ],
  });
  const nativeEurt = poolRecord({
    id: "native-eurt",
    reserves: [
      { asset: "native", amount: "1.0000000" },
      { asset: `EURT:${ACCOUNT}`, amount: "2.0000000" },
    ],
  });

  it("finds the pool for a native/issued pair", async () => {
    respond([nativeUsdc]);

    const pools = expectOk(await getLiquidityPoolByAssets({ code: "XLM" }, USDC));

    expect(pools.map((p) => p.id)).toEqual(["native-usdc"]);
  });

  it("finds the pool for an issued/issued pair", async () => {
    respond([usdcEurt]);

    expect(expectOk(await getLiquidityPoolByAssets(USDC, EURT)).map((p) => p.id)).toEqual(["usdc-eurt"]);
  });

  it("is order independent: (A, B) and (B, A) give the same pools", async () => {
    respond([nativeUsdc, usdcEurt, nativeEurt]);

    const forward = expectOk(await getLiquidityPoolByAssets(USDC, EURT));
    const reverse = expectOk(await getLiquidityPoolByAssets(EURT, USDC));

    expect(forward.map((p) => p.id)).toEqual(["usdc-eurt"]);
    expect(reverse.map((p) => p.id)).toEqual(forward.map((p) => p.id));
  });

  it("asks Horizon for both assets", async () => {
    await getLiquidityPoolByAssets(USDC, { code: "XLM" });

    const [[first, second]] = used("forAssets") as Asset[][];
    expect([first.getCode(), second.getCode()].sort()).toEqual(["USDC", "XLM"]);
    expect(used("limit")).toEqual([[200]]);
  });

  it("drops pools that do not hold both assets", async () => {
    respond([nativeUsdc, nativeEurt]);

    expect(expectOk(await getLiquidityPoolByAssets({ code: "XLM" }, USDC)).map((p) => p.id)).toEqual([
      "native-usdc",
    ]);
  });

  it("returns an empty list when no pool holds the pair", async () => {
    respond([]);

    expect(expectOk(await getLiquidityPoolByAssets(USDC, EURT))).toEqual([]);
  });

  it("treats Asset.native() and { code: 'XLM' } as the same asset", async () => {
    const error = expectError(await getLiquidityPoolByAssets(Asset.native(), { code: "XLM" }));

    expect(error.code).toBe(SorokitErrorCode.VALIDATION);
    expect(horizon.urls).toEqual([]);
  });

  it("rejects the same asset twice, even in different forms", async () => {
    const error = expectError(await getLiquidityPoolByAssets(USDC, new Asset("USDC", ISSUER)));

    expect(error.code).toBe(SorokitErrorCode.VALIDATION);
    expect(error.message).toContain("different");
  });

  it("rejects an invalid asset without calling Horizon", async () => {
    expectError(await getLiquidityPoolByAssets(USDC, { code: "EURT" }));
    expectError(await getLiquidityPoolByAssets({ code: "bad code", issuer: ISSUER }, USDC));

    expect(horizon.urls).toEqual([]);
  });

  it("passes a Horizon URL option and surfaces Horizon failures", async () => {
    horizon.call.mockRejectedValue(horizonError(503, "unavailable"));

    const error = expectError(
      await getLiquidityPoolByAssets(USDC, EURT, { horizonUrl: "https://horizon.example.org" }),
    );

    expect(horizon.urls).toEqual(["https://horizon.example.org"]);
    expect(error.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
  });
});

describe("exports", () => {
  it("is exported from src/network/index.ts and src/index.ts", () => {
    expect(networkModule.getLiquidityPools).toBe(getLiquidityPools);
    expect(networkModule.getLiquidityPoolByAssets).toBe(getLiquidityPoolByAssets);
    expect(sorokit.getLiquidityPools).toBe(getLiquidityPools);
    expect(sorokit.getLiquidityPoolByAssets).toBe(getLiquidityPoolByAssets);
  });
});

type LiquidityPoolAssetList = NonNullable<Parameters<typeof getLiquidityPools>[0]>["assets"];
