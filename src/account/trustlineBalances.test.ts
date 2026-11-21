import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const loadAccount = vi.fn();
const serverUrls: string[] = [];

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class {
        constructor(url: string) {
          serverUrls.push(url);
        }
        loadAccount = loadAccount;
      },
    },
  };
});

import { getTrustlineBalances } from "./queries";
import { SorokitErrorCode } from "../shared/response";

const ACCOUNT = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();
const POOL_ID = "a".repeat(64);

function horizonAccount(overrides: Record<string, unknown> = {}) {
  return {
    subentry_count: 3,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "250.5000000",
        limit: "1000.0000000",
        buying_liabilities: "100.0000000",
        selling_liabilities: "50.0000000",
        is_authorized: true,
      },
      {
        asset_type: "credit_alphanum12",
        asset_code: "LONGASSET",
        asset_issuer: OTHER_ISSUER,
        balance: "0.0000000",
        limit: "922337203685.4775807",
        buying_liabilities: "0.0000000",
        selling_liabilities: "0.0000000",
        is_authorized: false,
      },
      {
        asset_type: "liquidity_pool_shares",
        liquidity_pool_id: POOL_ID,
        balance: "12.0000000",
        limit: "922337203685.4775807",
      },
      {
        asset_type: "native",
        balance: "100.0000000",
        buying_liabilities: "0.0000000",
        selling_liabilities: "10.0000000",
      },
    ],
    ...overrides,
  };
}

describe("getTrustlineBalances", () => {
  beforeEach(() => {
    loadAccount.mockReset();
    serverUrls.length = 0;
    loadAccount.mockResolvedValue(horizonAccount());
  });

  it("returns native first, then every trustline with limit and available amounts", async () => {
    const r = await getTrustlineBalances(ACCOUNT);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;

    expect(r.data.map((b) => b.assetCode)).toEqual(["XLM", "USDC", "LONGASSET", POOL_ID]);

    const [xlm, usdc, long, pool] = r.data;
    // 100 − 10 selling − (2 + 3 subentries) × 0.5 reserve = 87.5
    expect(xlm).toEqual({
      assetType: "native",
      assetCode: "XLM",
      assetIssuer: null,
      isNative: true,
      balance: "100.0000000",
      limit: null,
      available: "87.5000000",
      availableToReceive: null,
      sellingLiabilities: "10.0000000",
      buyingLiabilities: "0.0000000",
      isAuthorized: null,
    });
    // available = 250.5 − 50; availableToReceive = 1000 − 250.5 − 100
    expect(usdc).toMatchObject({
      assetType: "credit_alphanum4",
      assetIssuer: ISSUER,
      limit: "1000.0000000",
      available: "200.5000000",
      availableToReceive: "649.5000000",
      isAuthorized: true,
    });
    expect(long).toMatchObject({ assetType: "credit_alphanum12", isAuthorized: false, available: "0.0000000" });
    expect(pool).toMatchObject({
      assetType: "liquidity_pool_shares",
      liquidityPoolId: POOL_ID,
      assetIssuer: null,
      isAuthorized: null,
      available: "12.0000000",
    });
  });

  it("accounts for sponsorship and a custom base reserve in native available", async () => {
    loadAccount.mockResolvedValue(horizonAccount({ subentry_count: 3, num_sponsoring: 2, num_sponsored: 1 }));
    const r = await getTrustlineBalances(ACCOUNT, { baseReserve: "1" });
    // (2 + 3 + 2 − 1) × 1 = 6 → 100 − 10 − 6
    expect(r.status === "ok" && r.data[0]!.available).toBe("84.0000000");
  });

  it("never reports a negative available amount", async () => {
    loadAccount.mockResolvedValue({
      subentry_count: 0,
      balances: [{ asset_type: "native", balance: "0.5000000", selling_liabilities: "0.0000000", buying_liabilities: "0.0000000" }],
    });
    const r = await getTrustlineBalances(ACCOUNT);
    expect(r.status === "ok" && r.data[0]!.available).toBe("0.0000000");
  });

  it("keeps full 7-decimal precision for large amounts", async () => {
    loadAccount.mockResolvedValue({
      subentry_count: 0,
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "BIG",
          asset_issuer: ISSUER,
          balance: "922337203685.4775806",
          limit: "922337203685.4775807",
          selling_liabilities: "0.0000001",
          buying_liabilities: "0.0000000",
        },
      ],
    });
    const r = await getTrustlineBalances(ACCOUNT);
    expect(r.status === "ok" && r.data[0]).toMatchObject({ available: "922337203685.4775805", availableToReceive: "0.0000001" });
  });

  it("filters by asset code, issuer, type, native and zero balances", async () => {
    const codes = async (filters: Parameters<typeof getTrustlineBalances>[1]) => {
      const r = await getTrustlineBalances(ACCOUNT, filters);
      return r.status === "ok" ? r.data.map((b) => b.assetCode) : r.error.message;
    };
    expect(await codes({ assetCode: "usdc" })).toEqual(["USDC"]);
    expect(await codes({ assetCode: "xlm" })).toEqual(["XLM"]);
    expect(await codes({ assetIssuer: OTHER_ISSUER })).toEqual(["LONGASSET"]);
    expect(await codes({ assetType: ["credit_alphanum4", "credit_alphanum12"] })).toEqual(["USDC", "LONGASSET"]);
    expect(await codes({ includeNative: false })).toEqual(["USDC", "LONGASSET", POOL_ID]);
    expect(await codes({ excludeZero: true })).toEqual(["XLM", "USDC", POOL_ID]);
  });

  it("returns only native XLM for an account with no trustlines", async () => {
    loadAccount.mockResolvedValue({
      subentry_count: 0,
      balances: [{ asset_type: "native", balance: "5.0000000", selling_liabilities: "0.0000000", buying_liabilities: "0.0000000" }],
    });
    const r = await getTrustlineBalances(ACCOUNT);
    expect(r.status === "ok" && r.data).toHaveLength(1);
  });

  it("supports an explicit Horizon URL as first argument or filter", async () => {
    await getTrustlineBalances("https://horizon.example", ACCOUNT);
    await getTrustlineBalances(ACCOUNT, { horizonUrl: "https://other.example" });
    expect(serverUrls).toEqual(["https://horizon.example", "https://other.example"]);
    expect(loadAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it("validates inputs before calling Horizon", async () => {
    const bad = await getTrustlineBalances("GNOTAKEY");
    expect(bad.status === "error" && bad.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    const badIssuer = await getTrustlineBalances(ACCOUNT, { assetIssuer: "nope" });
    expect(badIssuer.status === "error" && badIssuer.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    const badReserve = await getTrustlineBalances(ACCOUNT, { baseReserve: "-1" });
    expect(badReserve.status === "error" && badReserve.error.code).toBe(SorokitErrorCode.VALIDATION);
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("maps Horizon failures to SorokitResult errors", async () => {
    loadAccount.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { response: { status: 404 } }));
    const missing = await getTrustlineBalances(ACCOUNT);
    expect(missing.status === "error" && missing.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);

    loadAccount.mockRejectedValueOnce(new Error("socket hang up"));
    const down = await getTrustlineBalances(ACCOUNT);
    expect(down.status === "error" && down.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
    expect(down.status === "error" && down.error.message).toContain("socket hang up");
  });
});
