/**
 * Multi-wallet portfolio aggregation and valuation (#525).
 *
 * Combines balances from several wallets or accounts into one portfolio view
 * while preserving which wallet each holding came from, and derives allocation
 * percentages, total value, and concentration metrics.
 *
 * This layer operates purely on already-normalised account data. It performs no
 * network calls and knows nothing about wallet connection lifecycle, so it can
 * be fed by any provider.
 */

import type { AssetBalance } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One wallet or account contributing balances to a portfolio. */
export interface PortfolioWalletSource {
  /**
   * Account public key. Two sources sharing an accountId are duplicates.
   */
  accountId: string;
  /** Optional display label, e.g. the wallet name it was read from. */
  label?: string;
  /** Balances held by this account. */
  balances: AssetBalance[];
}

/** A price for one asset, used to value holdings. */
export interface PortfolioAssetPrice {
  /** Asset identifier, as produced by {@link assetIdentifier}. */
  assetId: string;
  /** Price of one unit in the valuation currency. */
  price: number;
}

/** The portion of a holding attributable to one wallet. */
export interface WalletAttribution {
  accountId: string;
  label?: string;
  /** Amount of the asset held by this wallet. */
  amount: number;
}

/** All holdings of a single asset across every source wallet. */
export interface PortfolioHolding {
  /** Canonical asset identifier, e.g. "native" or "USDC:GA5Z…". */
  assetId: string;
  assetCode: string;
  assetIssuer: string | null;
  /** Combined amount across all sources. */
  totalAmount: number;
  /** Per-wallet breakdown, ordered by descending amount then accountId. */
  attribution: WalletAttribution[];
  /**
   * Value in the valuation currency, or null when no price was supplied.
   * Null is never coerced to zero — an unpriced holding is unknown, not
   * worthless.
   */
  value: number | null;
  /**
   * Share of the priced portfolio value, 0–1, or null when unpriced.
   * Percentages are computed over priced value only, so unpriced holdings
   * do not silently dilute the allocation of everything else.
   */
  allocation: number | null;
}

/** How much of the portfolio could not be valued. */
export interface PortfolioValuationCoverage {
  /** Asset identifiers with no price available. */
  missingPriceAssetIds: string[];
  /** Number of holdings that were priced. */
  pricedHoldingCount: number;
  /** Number of holdings that could not be priced. */
  unpricedHoldingCount: number;
  /** True when at least one holding lacks a price. */
  hasMissingPrices: boolean;
}

/** Concentration metrics over the priced portion of the portfolio. */
export interface PortfolioConcentration {
  /** Largest single-asset allocation, 0–1, or null when nothing is priced. */
  largestAssetAllocation: number | null;
  /** Asset identifier holding the largest allocation, or null. */
  largestAssetId: string | null;
  /**
   * Herfindahl-Hirschman index over allocations, 0–1. 1 means the entire
   * priced portfolio sits in a single asset; lower values mean more spread.
   * Null when nothing is priced.
   */
  herfindahlIndex: number | null;
  /** Number of distinct assets held. */
  assetCount: number;
  /** Number of distinct source wallets. */
  walletCount: number;
}

/** A source that was supplied more than once. */
export interface DuplicateSource {
  accountId: string;
  /** How many times the account appeared in the input. */
  occurrences: number;
}

/** The aggregated portfolio. */
export interface PortfolioAggregation {
  /** Holdings ordered by descending value, then descending amount, then id. */
  holdings: PortfolioHolding[];
  /**
   * Total value of all priced holdings in the valuation currency, or null
   * when no holding could be priced.
   */
  totalValue: number | null;
  /** Currency the valuation is expressed in. */
  currency: string;
  /** Which holdings could and could not be valued. */
  coverage: PortfolioValuationCoverage;
  /** Concentration metrics over the priced holdings. */
  concentration: PortfolioConcentration;
  /**
   * Accounts supplied more than once. Duplicates are counted only once in the
   * aggregation, so re-supplying a wallet cannot inflate the portfolio.
   */
  duplicateSources: DuplicateSource[];
  /** Account IDs actually included, in input order. */
  includedAccountIds: string[];
}

/** Options for {@link aggregatePortfolio}. */
export interface AggregatePortfolioOptions {
  /** Prices used for valuation. Holdings with no entry stay unpriced. */
  prices?: PortfolioAssetPrice[];
  /** Currency label recorded on the result. Default: "USD". */
  currency?: string;
  /** Drop holdings whose combined amount is below this. Default: 0. */
  dustThreshold?: number;
  /**
   * Include assets whose combined amount is zero. Default: false — a
   * zero-balance trustline is not a holding.
   */
  includeZeroBalances?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Canonical identifier for an asset.
 *
 * The native asset has no issuer, so it collapses to "native". Every other
 * asset is keyed by code *and* issuer, because two issuers can and do use the
 * same code — merging them would silently combine unrelated assets.
 */
export function assetIdentifier(
  assetCode: string,
  assetIssuer: string | null,
): string {
  if (assetIssuer === null || assetIssuer === "") return "native";
  return `${assetCode}:${assetIssuer}`;
}

function parseBalance(balance: AssetBalance): number {
  // Prefer the parsed float when present, but fall back to the string form,
  // which is the authoritative value.
  const parsed =
    typeof balance.balanceFloat === "number"
      ? balance.balanceFloat
      : Number.parseFloat(balance.balance);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Aggregate balances across multiple wallets into a single portfolio.
 *
 * Balances are normalised by asset identifier and combined, while each
 * holding retains a per-wallet attribution breakdown. Repeated accounts are
 * detected and counted once.
 *
 * Valuation is optional. Where a price is missing the holding's value and
 * allocation are `null` rather than zero, and the shortfall is reported in
 * `coverage`, so an unpriced asset is never mistaken for a worthless one.
 *
 * @param wallets - Wallet/account sources to combine.
 * @param options - Prices, currency, and filtering thresholds.
 */
export function aggregatePortfolio(
  wallets: PortfolioWalletSource[],
  options: AggregatePortfolioOptions = {},
): PortfolioAggregation {
  const {
    prices = [],
    currency = "USD",
    dustThreshold = 0,
    includeZeroBalances = false,
  } = options;

  // ── Detect and collapse duplicate sources ──
  const occurrences = new Map<string, number>();
  for (const wallet of wallets) {
    occurrences.set(wallet.accountId, (occurrences.get(wallet.accountId) ?? 0) + 1);
  }

  const duplicateSources: DuplicateSource[] = [...occurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([accountId, count]) => ({ accountId, occurrences: count }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  const seenAccounts = new Set<string>();
  const includedWallets: PortfolioWalletSource[] = [];
  for (const wallet of wallets) {
    if (seenAccounts.has(wallet.accountId)) continue;
    seenAccounts.add(wallet.accountId);
    includedWallets.push(wallet);
  }

  // ── Normalise and combine balances by asset ──
  interface Accumulator {
    assetId: string;
    assetCode: string;
    assetIssuer: string | null;
    totalAmount: number;
    attribution: WalletAttribution[];
  }

  const byAsset = new Map<string, Accumulator>();

  for (const wallet of includedWallets) {
    // A missing balances array is treated as "nothing held", not an error —
    // a wallet whose balances could not be read still belongs in the portfolio.
    for (const balance of wallet.balances ?? []) {
      const assetId = assetIdentifier(balance.assetCode, balance.assetIssuer);
      const amount = parseBalance(balance);

      const existing = byAsset.get(assetId);
      const accumulator: Accumulator = existing ?? {
        assetId,
        assetCode: balance.assetCode,
        assetIssuer: balance.assetIssuer,
        totalAmount: 0,
        attribution: [],
      };

      accumulator.totalAmount += amount;

      // One wallet can list the same asset more than once; fold those into a
      // single attribution entry so the breakdown has one row per wallet.
      const walletEntry = accumulator.attribution.find(
        (entry) => entry.accountId === wallet.accountId,
      );
      if (walletEntry) {
        walletEntry.amount += amount;
      } else {
        accumulator.attribution.push({
          accountId: wallet.accountId,
          ...(wallet.label === undefined ? {} : { label: wallet.label }),
          amount,
        });
      }

      byAsset.set(assetId, accumulator);
    }
  }

  // ── Filter dust and zero balances ──
  const retained = [...byAsset.values()].filter((accumulator) => {
    if (!includeZeroBalances && accumulator.totalAmount === 0) return false;
    return Math.abs(accumulator.totalAmount) >= dustThreshold;
  });

  // ── Value the holdings ──
  const priceByAssetId = new Map<string, number>();
  for (const price of prices) {
    if (Number.isFinite(price.price)) {
      priceByAssetId.set(price.assetId, price.price);
    }
  }

  const missingPriceAssetIds: string[] = [];
  let pricedValue = 0;
  let pricedHoldingCount = 0;

  interface Valued extends Accumulator {
    value: number | null;
  }

  const valued: Valued[] = retained.map((accumulator) => {
    const price = priceByAssetId.get(accumulator.assetId);
    if (price === undefined) {
      missingPriceAssetIds.push(accumulator.assetId);
      return { ...accumulator, value: null };
    }
    const value = accumulator.totalAmount * price;
    pricedValue += value;
    pricedHoldingCount += 1;
    return { ...accumulator, value };
  });

  missingPriceAssetIds.sort();

  // Allocation is a share of priced value. A zero or negative total makes the
  // share undefined, so allocations stay null rather than dividing by zero.
  const allocationBase = pricedValue > 0 ? pricedValue : null;

  const holdings: PortfolioHolding[] = valued
    .map((entry) => ({
      assetId: entry.assetId,
      assetCode: entry.assetCode,
      assetIssuer: entry.assetIssuer,
      totalAmount: entry.totalAmount,
      attribution: [...entry.attribution].sort(
        (a, b) =>
          b.amount - a.amount || a.accountId.localeCompare(b.accountId),
      ),
      value: entry.value,
      allocation:
        entry.value === null || allocationBase === null
          ? null
          : entry.value / allocationBase,
    }))
    .sort(
      (a, b) =>
        (b.value ?? -1) - (a.value ?? -1) ||
        b.totalAmount - a.totalAmount ||
        a.assetId.localeCompare(b.assetId),
    );

  // ── Concentration over the priced portion ──
  let largestAssetAllocation: number | null = null;
  let largestAssetId: string | null = null;
  let herfindahlIndex: number | null = null;

  if (allocationBase !== null) {
    let sumOfSquares = 0;
    for (const holding of holdings) {
      if (holding.allocation === null) continue;
      sumOfSquares += holding.allocation * holding.allocation;
      if (
        largestAssetAllocation === null ||
        holding.allocation > largestAssetAllocation
      ) {
        largestAssetAllocation = holding.allocation;
        largestAssetId = holding.assetId;
      }
    }
    herfindahlIndex = sumOfSquares;
  }

  return {
    holdings,
    totalValue: pricedHoldingCount === 0 ? null : pricedValue,
    currency,
    coverage: {
      missingPriceAssetIds,
      pricedHoldingCount,
      unpricedHoldingCount: missingPriceAssetIds.length,
      hasMissingPrices: missingPriceAssetIds.length > 0,
    },
    concentration: {
      largestAssetAllocation,
      largestAssetId,
      herfindahlIndex,
      assetCount: holdings.length,
      walletCount: includedWallets.length,
    },
    duplicateSources,
    includedAccountIds: includedWallets.map((wallet) => wallet.accountId),
  };
}
