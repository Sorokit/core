import { describe, it, expect } from "vitest";
import {
  aggregatePortfolio,
  assetIdentifier,
  type PortfolioAssetPrice,
  type PortfolioWalletSource,
} from "../account/portfolioAggregation";
import type { AssetBalance } from "../account/types";

const ISSUER_A = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER_B = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Build a balance, defaulting to a credit asset. */
function bal(
  assetCode: string,
  amount: number,
  assetIssuer: string | null = ISSUER_A,
): AssetBalance {
  return {
    assetType: assetIssuer === null ? "native" : "credit_alphanum4",
    assetCode,
    assetIssuer,
    balance: amount.toFixed(7),
    balanceFloat: amount,
  };
}

/** Build a native XLM balance. */
function xlm(amount: number): AssetBalance {
  return bal("XLM", amount, null);
}

function wallet(
  accountId: string,
  balances: AssetBalance[],
  label?: string,
): PortfolioWalletSource {
  return label === undefined
    ? { accountId, balances }
    : { accountId, balances, label };
}

const prices: PortfolioAssetPrice[] = [
  { assetId: "native", price: 0.1 },
  { assetId: `USDC:${ISSUER_A}`, price: 1 },
  { assetId: `EURC:${ISSUER_A}`, price: 1.1 },
];

describe("assetIdentifier", () => {
  it("collapses the native asset to a single identifier", () => {
    expect(assetIdentifier("XLM", null)).toBe("native");
    expect(assetIdentifier("XLM", "")).toBe("native");
  });

  it("keys credit assets by code and issuer", () => {
    expect(assetIdentifier("USDC", ISSUER_A)).toBe(`USDC:${ISSUER_A}`);
  });

  it("distinguishes the same code from different issuers", () => {
    expect(assetIdentifier("USDC", ISSUER_A)).not.toBe(
      assetIdentifier("USDC", ISSUER_B),
    );
  });
});

describe("aggregatePortfolio", () => {
  it("combines balances from multiple wallets", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [xlm(1000), bal("USDC", 500)]),
      wallet("GWALLET2", [xlm(500)]),
    ]);

    const native = result.holdings.find((h) => h.assetId === "native");
    expect(native?.totalAmount).toBe(1500);
    expect(result.concentration.walletCount).toBe(2);
  });

  it("normalises holdings by asset identifier", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100)]),
      wallet("GWALLET2", [bal("USDC", 250)]),
    ]);

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]?.assetId).toBe(`USDC:${ISSUER_A}`);
    expect(result.holdings[0]?.totalAmount).toBe(350);
  });

  it("keeps same-code assets from different issuers separate", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100, ISSUER_A)]),
      wallet("GWALLET2", [bal("USDC", 100, ISSUER_B)]),
    ]);

    expect(result.holdings).toHaveLength(2);
    expect(result.concentration.assetCount).toBe(2);
  });

  it("preserves per-wallet attribution for each holding", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100)], "Freighter"),
      wallet("GWALLET2", [bal("USDC", 300)], "Lobstr"),
    ]);

    const holding = result.holdings[0];
    expect(holding?.totalAmount).toBe(400);
    // Sorted by descending amount.
    expect(holding?.attribution).toEqual([
      { accountId: "GWALLET2", label: "Lobstr", amount: 300 },
      { accountId: "GWALLET1", label: "Freighter", amount: 100 },
    ]);
  });

  it("folds repeated entries of one asset within a wallet into one row", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100), bal("USDC", 50)]),
    ]);

    const holding = result.holdings[0];
    expect(holding?.totalAmount).toBe(150);
    expect(holding?.attribution).toHaveLength(1);
    expect(holding?.attribution[0]?.amount).toBe(150);
  });

  it("omits the label from attribution when the source has none", () => {
    const result = aggregatePortfolio([wallet("GWALLET1", [bal("USDC", 100)])]);

    expect(result.holdings[0]?.attribution[0]).toEqual({
      accountId: "GWALLET1",
      amount: 100,
    });
  });

  it("detects duplicate account sources and counts them once", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100)]),
      wallet("GWALLET1", [bal("USDC", 100)]),
      wallet("GWALLET2", [bal("USDC", 50)]),
    ]);

    expect(result.duplicateSources).toEqual([
      { accountId: "GWALLET1", occurrences: 2 },
    ]);
    // The repeated wallet must not inflate the total.
    expect(result.holdings[0]?.totalAmount).toBe(150);
    expect(result.includedAccountIds).toEqual(["GWALLET1", "GWALLET2"]);
    expect(result.concentration.walletCount).toBe(2);
  });

  it("reports no duplicates for distinct sources", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 100)]),
      wallet("GWALLET2", [bal("USDC", 100)]),
    ]);

    expect(result.duplicateSources).toEqual([]);
  });

  it("calculates total value from supplied prices", () => {
    const result = aggregatePortfolio(
      [
        wallet("GWALLET1", [xlm(1000), bal("USDC", 500)]),
        wallet("GWALLET2", [bal("EURC", 200)]),
      ],
      { prices },
    );

    // 1000 * 0.1 + 500 * 1 + 200 * 1.1 = 100 + 500 + 220 = 820
    expect(result.totalValue).toBeCloseTo(820);
    expect(result.currency).toBe("USD");
  });

  it("uses the currency label supplied by the caller", () => {
    const result = aggregatePortfolio([wallet("GWALLET1", [xlm(10)])], {
      prices,
      currency: "EUR",
    });

    expect(result.currency).toBe("EUR");
  });

  it("calculates allocation percentages that sum to one", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [xlm(1000), bal("USDC", 500)])],
      { prices },
    );

    const total = result.holdings.reduce((sum, h) => sum + (h.allocation ?? 0), 0);
    expect(total).toBeCloseTo(1);

    const usdc = result.holdings.find((h) => h.assetCode === "USDC");
    // 500 of 600 total value.
    expect(usdc?.allocation).toBeCloseTo(500 / 600);
  });

  it("represents missing price data as null rather than zero", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [xlm(1000), bal("MYSTERY", 999)])],
      { prices },
    );

    const mystery = result.holdings.find((h) => h.assetCode === "MYSTERY");
    expect(mystery?.value).toBeNull();
    expect(mystery?.allocation).toBeNull();
    // The unpriced holding is excluded from the total, not counted as zero.
    expect(result.totalValue).toBeCloseTo(100);
  });

  it("reports which assets were missing prices", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [xlm(1000), bal("MYSTERY", 5), bal("OTHER", 5)])],
      { prices },
    );

    expect(result.coverage.hasMissingPrices).toBe(true);
    expect(result.coverage.unpricedHoldingCount).toBe(2);
    expect(result.coverage.pricedHoldingCount).toBe(1);
    expect(result.coverage.missingPriceAssetIds).toEqual([
      `MYSTERY:${ISSUER_A}`,
      `OTHER:${ISSUER_A}`,
    ]);
  });

  it("reports full coverage when every holding is priced", () => {
    const result = aggregatePortfolio([wallet("GWALLET1", [xlm(10)])], {
      prices,
    });

    expect(result.coverage.hasMissingPrices).toBe(false);
    expect(result.coverage.missingPriceAssetIds).toEqual([]);
  });

  it("returns a null total when no holding could be priced", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("MYSTERY", 100)]),
    ]);

    expect(result.totalValue).toBeNull();
    expect(result.holdings[0]?.allocation).toBeNull();
    expect(result.concentration.herfindahlIndex).toBeNull();
    expect(result.concentration.largestAssetAllocation).toBeNull();
  });

  it("ignores non-finite prices instead of producing NaN values", () => {
    const result = aggregatePortfolio([wallet("GWALLET1", [xlm(100)])], {
      prices: [{ assetId: "native", price: Number.NaN }],
    });

    expect(result.holdings[0]?.value).toBeNull();
    expect(result.totalValue).toBeNull();
  });

  it("computes concentration metrics over priced holdings", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [xlm(1000), bal("USDC", 900)])],
      { prices },
    );

    // Values: XLM 100, USDC 900, total 1000.
    expect(result.concentration.largestAssetId).toBe(`USDC:${ISSUER_A}`);
    expect(result.concentration.largestAssetAllocation).toBeCloseTo(0.9);
    // HHI = 0.9^2 + 0.1^2 = 0.82
    expect(result.concentration.herfindahlIndex).toBeCloseTo(0.82);
    expect(result.concentration.assetCount).toBe(2);
  });

  it("reports a concentration index of one for a single-asset portfolio", () => {
    const result = aggregatePortfolio([wallet("GWALLET1", [xlm(1000)])], {
      prices,
    });

    expect(result.concentration.herfindahlIndex).toBeCloseTo(1);
    expect(result.concentration.largestAssetAllocation).toBeCloseTo(1);
  });

  it("orders holdings by descending value", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [xlm(100), bal("USDC", 500), bal("EURC", 200)])],
      { prices },
    );

    expect(result.holdings.map((h) => h.assetCode)).toEqual([
      "USDC",
      "EURC",
      "XLM",
    ]);
  });

  it("places unpriced holdings after priced ones", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [bal("MYSTERY", 1_000_000), xlm(10)])],
      { prices },
    );

    expect(result.holdings[0]?.assetCode).toBe("XLM");
    expect(result.holdings[1]?.assetCode).toBe("MYSTERY");
  });

  it("excludes zero balances by default", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", [bal("USDC", 0), xlm(100)]),
    ]);

    expect(result.holdings.map((h) => h.assetCode)).toEqual(["XLM"]);
  });

  it("includes zero balances when asked", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [bal("USDC", 0), xlm(100)])],
      { includeZeroBalances: true },
    );

    expect(result.holdings).toHaveLength(2);
  });

  it("filters holdings below the dust threshold", () => {
    const result = aggregatePortfolio(
      [wallet("GWALLET1", [bal("USDC", 0.0001), xlm(100)])],
      { dustThreshold: 1 },
    );

    expect(result.holdings.map((h) => h.assetCode)).toEqual(["XLM"]);
  });

  it("handles a wallet with no balances", () => {
    const result = aggregatePortfolio([
      wallet("GWALLET1", []),
      wallet("GWALLET2", [xlm(100)]),
    ]);

    expect(result.holdings).toHaveLength(1);
    expect(result.concentration.walletCount).toBe(2);
    expect(result.includedAccountIds).toEqual(["GWALLET1", "GWALLET2"]);
  });

  it("treats a missing balances array as an empty one", () => {
    const result = aggregatePortfolio([
      { accountId: "GWALLET1" } as PortfolioWalletSource,
      wallet("GWALLET2", [xlm(100)]),
    ]);

    expect(result.holdings).toHaveLength(1);
    expect(result.concentration.walletCount).toBe(2);
  });

  it("falls back to the string balance when balanceFloat is absent", () => {
    const partial = {
      assetType: "native",
      assetCode: "XLM",
      assetIssuer: null,
      balance: "250.0000000",
    } as AssetBalance;

    const result = aggregatePortfolio([wallet("GWALLET1", [partial])]);

    expect(result.holdings[0]?.totalAmount).toBe(250);
  });

  it("treats an unparseable balance as zero rather than NaN", () => {
    const broken = {
      assetType: "native",
      assetCode: "XLM",
      assetIssuer: null,
      balance: "not-a-number",
    } as AssetBalance;

    const result = aggregatePortfolio(
      [wallet("GWALLET1", [broken])],
      { includeZeroBalances: true },
    );

    expect(result.holdings[0]?.totalAmount).toBe(0);
  });

  it("returns an empty portfolio for no wallets", () => {
    const result = aggregatePortfolio([]);

    expect(result.holdings).toEqual([]);
    expect(result.totalValue).toBeNull();
    expect(result.duplicateSources).toEqual([]);
    expect(result.concentration.walletCount).toBe(0);
    expect(result.concentration.assetCount).toBe(0);
  });

  it("does not mutate the caller's input", () => {
    const balances = [xlm(100)];
    const sources = [wallet("GWALLET1", balances)];
    const snapshot = JSON.parse(JSON.stringify(sources)) as unknown;

    aggregatePortfolio(sources, { prices });

    expect(JSON.parse(JSON.stringify(sources))).toEqual(snapshot);
  });
});
