/**
 * Portfolio Dashboard and Asset Allocation Tracker (#592).
 *
 * Provides a real-time portfolio view across one or more accounts:
 * aggregated asset balances, portfolio composition percentages, and
 * historical value tracking. Real-time updates are exposed via a subscription
 * helper that polls the underlying account provider.
 *
 * This layer operates on already-normalised account data. It knows nothing
 * about wallet connection lifecycle, so it can be fed by any provider.
 */

import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { AssetBalance } from "./types";

interface PriceMap {
  [assetId: string]: number;
}

/** A holding aggregated across accounts for a single asset. */
export interface PortfolioHolding {
  assetId: string;
  /** Total amount across all accounts. */
  amount: number;
  /** Per-account attribution of this holding. */
  attribution: { accountId: string; amount: number }[];
  /** Optional price used for valuation. */
  price?: number;
  /** Optional value in the price currency. */
  value?: number;
}

/** Portfolio composition entry by asset. */
export interface PortfolioAllocation {
  assetId: string;
  /** Percentage of total value (0 - 100). */
  percentage: number;
  /** Absolute value contribution if prices are available. */
  value?: number;
}

/** Concentration metrics over the priced portion. */
export interface PortfolioConcentration {
  largestAssetAllocation: number | null;
  largestAssetId: string | null;
  herfindahlIndex: number | null;
  assetCount: number;
  walletCount: number;
}

/** Valuation coverage summary. */
export interface PortfolioCoverage {
  missingPriceAssetIds: string[];
  pricedHoldingCount: number;
  unpricedHoldingCount: number;
  hasMissingPrices: boolean;
}

/** A single historical sample of the portfolio. */
export interface PortfolioHistoricalPoint {
  /** UNIX timestamp in milliseconds. */
  timestamp: number;
  /** Total value at this point if prices are available. */
  totalValue: number | null;
  /** Allocation at this point. */
  allocation: PortfolioAllocation[];
  /** Holdings at this point. */
  holdings: PortfolioHolding[];
}

/** Historical change summary between two points. */
export interface PortfolioHistory {
  /** Chronological samples, oldest first. */
  points: PortfolioHistoricalPoint[];
  /** Absolute change in total value over the window. */
  valueChange: number | null;
  /** Percentage change in total value over the window. */
  valueChangePercent: number | null;
  /** Allocation shifts between the first and last point. */
  allocationShifts: { assetId: string; deltaPercentage: number }[];
}

/** The full portfolio view returned by `PortfolioDashboard`. */
export interface PortfolioData {
  /** Aggregated holdings across all accounts. */
  assets: PortfolioHolding[];
  /** Total value as a human-readable string (e.g. `"50000 USD"`). */
  totalValue: string;
  /** Numeric total value if prices are available. */
  totalValueNumeric: number | null;
  /** Portfolio composition percentages by asset. */
  allocation: PortfolioAllocation[];
  /** Per-account breakdown of holdings. */
  accountBreakdown: { accountId: string; holdings: PortfolioHolding[] }[];
  /** Valuation coverage summary. */
  coverage: PortfolioCoverage;
  /** Concentration metrics over the priced portion. */
  concentration: PortfolioConcentration;
  /** Timestamp of the snapshot. */
  timestamp: number;
}

/** Options accepted by the portfolio helpers. */
export interface PortfolioOptions {
  /** Prices by asset id, used for valuation. */
  prices?: PriceMap | { assetId: string; price: number }[];
  /** Currency label for the total value string. Defaults to `"USD"`. */
  currency?: string;
  /** Pre-fetched balances by account. */
  balances?: Record<string, AssetBalance[]>;
}

export interface PortfolioWatchOptions extends PortfolioOptions {
  intervalMs?: number;
}

/** Callback invoked on every portfolio update. */
export type PortfolioUpdateHandler = (updated: PortfolioData) => void;

/** Handle returned by `watchPortfolio`. */
export interface PortfolioWatch {
  /** Stop watching and release any timers. */
  unsubscribe: () => void;
  /** Resolves with the latest snapshot on demand. */
  refresh: () => Promise<SorokitResult<PortfolioData>>;
}

/** Provider that supplies raw balances for an account. */
export type BalanceProvider = (accountId: string) => Promise<AssetBalance[]>;

const DEFAULT_CURRENCY = "USD";

const DEFAULT_POLL_INTERVAL_MS = 15_000;

function assetId(balance: AssetBalance): string {
  return balance.assetType === "native"
    ? "native"
    : `${balance.assetCode}:${balance.assetIssuer ?? ""}`;
}

function normalisePrices(
  prices?: PriceMap | { assetId: string; price: number }[],
): PriceMap {
  if (!prices) return {};
  if (Array.isArray(prices)) {
    const map: PriceMap = {};
    for (const entry of prices) {
      if (entry && typeof entry.assetId === "string" && typeof entry.price === "number") {
        map[entry.assetId] = entry.price;
      }
    }
    return map;
  }
  const map: PriceMap = {};
  for (const [key, value] of Object.entries(prices)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      map[key] = value;
    }
  }
  return map;
}

function round(value: number, precision = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatTotalValue(value: number | null, currency: string): string {
  if (value === null) return `0.00 ${currency}`;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${currency}`;
}

/**
 * Aggregate balances from multiple accounts into a single holding list.
 */
function aggregateHoldings(
  accounts: string[],
  balancesByAccount: Record<string, AssetBalance[]>,
): PortfolioHolding[] {
  const bucket = new Map<string, PortfolioHolding>();
  for (const accountId of accounts) {
    const balances = balancesByAccount[accountId] ?? [];
    for (const balance of balances) {
      if (!balance) continue;
      const id = assetId(balance);
      const amount = balance.balanceFloat;
      if (!Number.isFinite(amount) || amount === 0) continue;
      const existing = bucket.get(id);
      if (existing) {
        existing.amount += amount;
        existing.attribution.push({ accountId, amount });
      } else {
        bucket.set(id, {
          assetId: id,
          amount,
          attribution: [{ accountId, amount }],
        });
      }
    }
  }
  return Array.from(bucket.values()).sort((a, b) => b.amount - a.amount);
}

function applyPrices(holdings: PortfolioHolding[], prices: PriceMap): {
  holdings: PortfolioHolding[];
  totalValue: number | null;
  coverage: PortfolioCoverage;
} {
  const missingPriceAssetIds = new Set<string>();
  let pricedHoldingCount = 0;
  let unpricedHoldingCount = 0;
  let totalValue = 0;
  let hasAnyPrice = false;
  const enriched = holdings.map($holding => {
    const price = prices[$holding.assetId];
    if (typeof price === "number" && Number.isFinite(price)) {
      const value = round($holding.amount * price);
      totalValue += value;
      pricedHoldingCount += 1;
      hasAnyPrice = true;
      return { ...$holding, price, value };
    }
    missingPriceAssetIds.add($holding.assetId);
    unpricedHoldingCount += 1;
    return { ...$holding };
  });
  return {
    holdings: enriched,
    totalValue: hasAnyPrice ? round(totalValue) : null,
    coverage: {
      missingPriceAssetIds: Array.from(missingPriceAssetIds),
      pricedHoldingCount,
      unpricedHoldingCount,
      hasMissingPrices: missingPriceAssetIds.size > 0,
    },
  };
}

function computeAllocation(holdings: PortfolioHolding[]): PortfolioAllocation[] {
  const totalValue = holdings.reduce((acc, h) => acc + (h && typeof h.value === "number" ? h.value : 0), 0);
  if (totalValue <= 0) {
    // Fall back to amount-based allocation when no prices are available.
    const totalAmount = holdings.reduce((acc, h) => acc + h.amount, 0);
    if (totalAmount <= 0) return [];
    return holdings.map(h => ({
      assetId: h.assetId,
      percentage: round((h.amount / totalAmount) * 100, 4),
    }));
  }
  return holdings.map(h => ({
    assetId: h.assetId,
    percentage: round(((typeof h.value === "number" ? h.value : 0) / totalValue) * 100, 4),
    ...(typeof h.value === "number" ? { value: h.value } : {}),
  }));
}

function computeConcentration(
  holdings: PortfolioHolding[],
  allocation: PortfolioAllocation[],
  walletCount: number,
): PortfolioConcentration {
  if (allocation.length === 0) {
    return {
      largestAssetAllocation: null,
      largestAssetId: null,
      herfindahlIndex: null,
      assetCount: 0,
      walletCount,
    };
  }
  let largest = allocation[0]!;
  let herfindahl = 0;
  for (const entry of allocation) {
    if (entry.percentage > largest.percentage) largest = entry;
    herfindahl += Math.pow(entry.percentage / 100, 2);
  }
  return {
    largestAssetAllocation: largest.percentage,
    largestAssetId: largest.assetId,
    herfindahlIndex: round(herfindahl, 6),
    assetCount: holdings.length,
    walletCount,
  };
}

function buildAccountBreakdown(
  accounts: string[],
  balancesByAccount: Record<string, AssetBalance[]>,
): { accountId: string; holdings: PortfolioHolding[] }[] {
  return accounts.map(accountId => {
    const balances = balancesByAccount[accountId] ?? [];
    const holdings: PortfolioHolding[] = [];
    for (const balance of balances) {
      if (!balance) continue;
      const id = assetId(balance);
      const amount = balance.balanceFloat;
      if (!Number.isFinite(amount) || amount === 0) continue;
      holdings.push({ assetId: id, amount, attribution: [{ accountId, amount }] });
    }
    return { accountId, holdings };
  });
}

async function resolveBalances(
  accounts: string[],
  options: PortfolioOptions,
  provider?: BalanceProvider,
): Promise<Record<string, AssetBalance[]>> {
  if (options.balances) return options.balances;
  if (!provider) return {};
  const entries = await Promise.all(
    accounts.map(async accountId => {
      try {
        const balances = await provider(accountId);
        return [accountId, Array.isArray(balances) ? balances : []] as const;
      } catch {
        return [accountId, []] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Compute a portfolio snapshot from a set of accounts and their balances.
 *
 * @param accounts - Account public keys to include in the portfolio.
 * @param options - Prices, currency label, and/or pre-fetched balances.
 * @param provider - Optional balance provider used when balances are not supplied.
 * @returns a `SorokitResult<PortfolioData>`.
 */
export async function getPortfolioFromAccounts(
  accounts: string[],
  options: PortfolioOptions = {},
  provider?: BalanceProvider,
): Promise<SorokitResult<PortfolioData>> {
  try {
    const uniqueAccounts = Array.from(new Set(accounts.filter(a => typeof a === "string" && a.length > 0)));
    const balancesByAccount = await resolveBalances(uniqueAccounts, options, provider);
    const currency = options.currency ?? DEFAULT_CURRENCY;
    const prices = normalisePrices(options.prices);
    const rawHoldings = aggregateHoldings(uniqueAccounts, balancesByAccount);
    const { holdings, totalValue, coverage } = applyPrices(rawHoldings, prices);
    const allocation = computeAllocation(holdings);
    const concentration = computeConcentration(holdings, allocation, uniqueAccounts.length);
    const accountBreakdown = buildAccountBreakdown(uniqueAccounts, balancesByAccount);
    const data: PortfolioData = {
      assets: holdings,
      totalValue: formatTotalValue(totalValue, currency),
      totalValueNumeric: totalValue,
      allocation,
      accountBreakdown,
      coverage,
      concentration,
      timestamp: Date.now(),
    };
    return { status: "ok", data, error: null };
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Unable to compute portfolio snapshot.",
      cause,
    );
  }
}

/**
 * Get a unified portfolio dashboard from one or more accounts.
 *
 * Aggregates total balances by asset, calculates portfolio composition
 * percentages, and provides an account-level breakdown.
 *
 * @param publicKey - Account public key (or array of keys) to include.
 * @param options - Prices, currency label, and/or pre-fetched balances.
 * @param provider - Optional balance provider used when balances are not supplied.
 * @returns `SorokitResult<PortfolioData>` on success, or an error on failure.
 *
 * @example
 * ```ts
 * const portfolio = await client.account.getPortfolio(publicKey);
 * // { assets: [...], totalValue: "50000 USD", allocation: {...} }
 * ```
 */
export async function getPortfolio(
  publicKey: string | string[],
  options: PortfolioOptions = {},
  provider?: BalanceProvider,
): Promise<SorokitResult<PortfolioData>> {
  const accounts = Array.isArray(publicKey) ? publicKey : [publicKey];
  return getPortfolioFromAccounts(accounts, options, provider);
}

/**
 * Get the asset allocation (percentages) for an account or group of accounts.
 *
 * @param publicKey - Account public key (or array of keys) to include.
 * @param options - Prices, currency label, and/or pre-fetched balances.
 * @param provider - Optional balance provider used when balances are not supplied.
 * @returns `SorokitResult<PortfolioAllocation[]>`.
 */
export async function getAssetAllocation(
  publicKey: string | string[],
  options: PortfolioOptions = {},
  provider?: BalanceProvider,
): Promise<SorokitResult<PortfolioAllocation[]>> {
  const result = await getPortfolio(publicKey, options, provider);
  if (result.status === "error") {
    return { status: "error", data: null, error: result.error };
  }
  return { status: "ok", data: result.data.allocation, error: null };
}

/**
 * Get historical portfolio data for a window of time.
 *
 * The history is derived from a sequence of snapshots supplied by the caller
 * (typically fetched from an indexer or a cache of previous portfolio views).
 * The `days` parameter filters the snapshots to the requested window.
 *
 * @param publicKey - Account public key (or array of keys) to include.
 * @param days - Number of days of history to return.
 * @param options - Prices, currency label, and/or pre-fetched balances.
 * @param snapshots - Historical snapshots to analyse.
 * @returns `SorokitResult<PortfolioHistory>`.
 */
export async function getPortfolioHistory(
  publicKey: string | string[],
  days: number,
  options: PortfolioOptions = {},
  snapshots: PortfolioHistoricalPoint[] = [],
): Promise<SorokitResult<PortfolioHistory>> {
  try {
    if (!Number.isFinite(days) || days < 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "`days` must be a non-negative number.",
      );
    }
    const windowStart = Date.now() - days * 24 * 60 * 60 * 1000;
    const inRange = snapshots
      .filter(s => s && typeof s.timestamp === "number" && s.timestamp >= windowStart)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (inRange.length === 0) {
      // No historical snapshots: fall back to a single current point.
      const current = await getPortfolio(publicKey, options);
      if (current.status === "error") {
        return current;
      }
      const point: PortfolioHistoricalPoint = {
        timestamp: current.data.timestamp,
        totalValue: current.data.totalValueNumeric,
        allocation: current.data.allocation,
        holdings: current.data.assets,
      };
      return {
        status: "ok",
        data: {
          points: [point],
          valueChange: null,
          valueChangePercent: null,
          allocationShifts: [],
        },
        error: null,
      };
    }

    const first = inRange[0]!;
    const last = inRange[inRange.length - 1]!;
    const firstValue = first.totalValue;
    const lastValue = last.totalValue;
    const valueChange =
      typeof firstValue === "number" && typeof lastValue === "number"
        ? round(lastValue - firstValue)
        : null;
    const valueChangePercent =
      typeof firstValue === "number" && firstValue !== 0 && typeof lastValue === "number"
        ? round(((lastValue - firstValue) / firstValue) * 100, 4)
        : null;

    const allocationMap = new Map<string, number>();
    for (const entry of first.allocation) {
      allocationMap.set(entry.assetId, entry.percentage);
    }
    const lastMap = new Map<string, number>();
    for (const entry of last.allocation) {
      lastMap.set(entry.assetId, entry.percentage);
    }
    const allAssetIds = new Set<string>([
      ...allocationMap.keys(),
      ...lastMap.keys(),
    ]);
    const allocationShifts = Array.from(allAssetIds).map(assetId => {
      const before = allocationMap.get(assetId) ?? 0;
      const after = lastMap.get(assetId) ?? 0;
      return { assetId, deltaPercentage: round(after - before, 4) };
    });

    return {
      status: "ok",
      data: {
        points: inRange,
        valueChange,
        valueChangePercent,
        allocationShifts,
      },
      error: null,
    };
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Unable to read portfolio history.",
      cause,
    );
  }
}

/**
 * Watch a portfolio for real-time updates.
 *
 * Polls the balance provider on a fixed interval and invokes the handler with
 * the latest portfolio snapshot whenever it changes. Returns a handle with
 * `unsubscribe` and `refresh` methods.
 *
 * @param publicKey - Account public key (or array of keys) to watch.
 * @param handler - Callback invoked on every update.
 * @param options - Prices, currency label, and/or pre-fetched balances.
 * @param provider - Balance provider used to fetch the latest balances.
 * @returns a `PortfolioWatch` handle.
 */
export function watchPortfolio(
  publicKey: string | string[],
  handler: PortfolioUpdateHandler,
  options: PortfolioWatchOptions = {},
  provider?: BalanceProvider,
): PortfolioWatch {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let lastSerialised: string | null = null;

  const refresh = async (): Promise<SorokitResult<PortfolioData>> => {
    const result = await getPortfolio(publicKey, options, provider);
    if (result.status === "ok") {
      const serialised = JSON.stringify({
        assets: result.data.assets,
        allocation: result.data.allocation,
        totalValueNumeric: result.data.totalValueNumeric,
      });
      if (serialised !== lastSerialised) {
        lastSerialised = serialised;
        if (!stopped) handler(result.data);
      }
    }
    return result;
  };

  // Fire an initial snapshot as soon as the watch is established.
  void refresh();

  timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return {
    unsubscribe: () => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    refresh,
  };
}

export type PortfolioDashboard = PortfolioData;
export type PortfolioAsset = PortfolioHolding;
export type PortfolioAllocationEntry = PortfolioAllocation;
export type PortfolioHistoryPoint = PortfolioHistoricalPoint;
export type PortfolioUpdate = PortfolioData;
export type PortfolioUpdateCallback = PortfolioUpdateHandler;

export async function getPortfolioDashboard(
  publicKey: string | string[],
  options: PortfolioOptions = {},
  provider?: BalanceProvider,
): Promise<SorokitResult<PortfolioDashboard>> {
  return getPortfolio(publicKey, options, provider);
}
