import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  toMessage,
} from "../shared";
import {
  DEFAULT_TX_TIMEOUT_SECONDS,
  DEFAULT_FEE_CACHE_TTL_MS,
} from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorokitCache } from "../shared/cache";
import { fetchRecentMedianFee, isFeeSurge } from "./feeSurge";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";

/** Minimum adaptive cache TTL: 2 minutes (used during high fee volatility >10% change). */
export const ADAPTIVE_FEE_TTL_MIN_MS = 2 * 60 * 1000;

/** Intermediate adaptive cache TTL: 5 minutes (used when fee volatility is between 5% and 10%). */
export const ADAPTIVE_FEE_TTL_INTERMEDIATE_MS = 5 * 60 * 1000;

/** Maximum adaptive cache TTL: 10 minutes (used during low fee volatility <5% change). */
export const ADAPTIVE_FEE_TTL_MAX_MS = 10 * 60 * 1000;

/** Maximum number of recent fee estimates retained per network for volatility tracking. */
export const FEE_HISTORY_MAX_ENTRIES = 20;

/** In-memory store of recent fee estimates keyed by network passphrase. */
const feeHistoryByNetwork = new Map<string, number[]>();

/**
 * Record a fee estimate into the bounded history for the given network.
 */
export function recordFeeEstimate(
  feeStroops: number,
  networkPassphrase = "default",
): void {
  if (!Number.isFinite(feeStroops) || feeStroops <= 0) return;
  const history = feeHistoryByNetwork.get(networkPassphrase) ?? [];
  history.push(feeStroops);
  if (history.length > FEE_HISTORY_MAX_ENTRIES) {
    history.shift();
  }
  feeHistoryByNetwork.set(networkPassphrase, history);
}

/**
 * Get a copy of the current bounded fee history for a network.
 */
export function getFeeHistory(networkPassphrase = "default"): number[] {
  return [...(feeHistoryByNetwork.get(networkPassphrase) ?? [])];
}

/**
 * Clear the fee history for a given network or all networks.
 */
export function clearFeeHistory(networkPassphrase?: string): void {
  if (networkPassphrase) {
    feeHistoryByNetwork.delete(networkPassphrase);
  } else {
    feeHistoryByNetwork.clear();
  }
}

/**
 * Calculate the adaptive cache TTL based on relative change from recent fee history.
 *
 * Volatility thresholds:
 * - >10% change (>0.10)  -> 2-minute TTL (120,000 ms)
 * - <5% change (<0.05)   -> up to 10-minute TTL (600,000 ms)
 * - 5%–10% change        -> intermediate 5-minute TTL (300,000 ms)
 *
 * When insufficient history is available (<1 previous estimate) or inputs are invalid,
 * safely falls back to the default 5-minute TTL.
 */
export function calculateAdaptiveFeeTtl(
  currentFeeStroops: number,
  history?: number[],
): number {
  if (!Number.isFinite(currentFeeStroops) || currentFeeStroops <= 0) {
    return DEFAULT_FEE_CACHE_TTL_MS;
  }

  if (!history || history.length === 0) {
    return DEFAULT_FEE_CACHE_TTL_MS;
  }

  const validEntries = history.filter((f) => Number.isFinite(f) && f > 0);
  if (validEntries.length === 0) {
    return DEFAULT_FEE_CACHE_TTL_MS;
  }

  // Compare against the most recent recorded fee estimate
  const previousFee = validEntries[validEntries.length - 1];
  if (!previousFee || previousFee <= 0) {
    return DEFAULT_FEE_CACHE_TTL_MS;
  }

  const relativeChange = Math.abs(currentFeeStroops - previousFee) / previousFee;

  if (relativeChange > 0.10) {
    return ADAPTIVE_FEE_TTL_MIN_MS;
  }
  if (relativeChange < 0.05) {
    return ADAPTIVE_FEE_TTL_MAX_MS;
  }
  return ADAPTIVE_FEE_TTL_INTERMEDIATE_MS;
}

/**
 * Fee tiers derived from the 10th, 50th, and 90th percentile of recent
 * network transaction fees. All values are in stroops (as strings).
 */
export interface FeeTiers {
  /** 10th percentile — suitable for non-urgent transactions */
  economy: string;
  /** 50th percentile — typical network fee */
  standard: string;
  /** 90th percentile — prioritized inclusion during congestion */
  fast: string;
}

/**
 * The result of a fee estimation.
 */
export interface FeeEstimate {
  /** Estimated fee in stroops (string to preserve precision) */
  fee: string;
  /** Estimated fee as a float for display convenience */
  feeFloat: number;
  /** Estimated fee in XLM (stroops / 10_000_000) */
  feeXlm: string;
  /** Base fee used as the floor (in stroops) */
  baseFee: string;
  /** Whether the estimate came from a simulation (true) or is just the base fee (false) */
  simulated: boolean;
  /** True when the estimated fee exceeds 2x the recent network median fee */
  surge?: boolean;
  /** Fee tiers based on recent network congestion. Present only when includeTiers is true. */
  tiers?: FeeTiers;
  /**
   * Congestion-aware fee recommendations derived from the last 100 network
   * transactions. Present only when `includeCongestionEstimate` is true.
   */
  congestion?: CongestionFeeEstimate;
  /** The priority level applied to this estimate. Undefined when no priority was requested. */
  priority?: TransactionPriority;
}

/**
 * Congestion-aware fee estimate derived from the median fees of the last 100
 * network transactions (issue #193).
 *
 * - `minFee`         — 10th-percentile of recent fees; acceptable during low load.
 * - `recommendedFee` — 50th-percentile (median); reliable under typical load.
 * - `maxFee`         — 90th-percentile; prioritised inclusion during congestion.
 * - `congestionLevel`— qualitative label derived from the ratio of the current
 *                      fee estimate to the recent median.
 */
export interface CongestionFeeEstimate {
  minFee: string;
  recommendedFee: string;
  maxFee: string;
  /** "low" | "medium" | "high" based on estimated fee vs. recent median */
  congestionLevel: "low" | "medium" | "high";
}

/** Transaction urgency level for priority-adjusted fee estimation. */
export type TransactionPriority = "low" | "normal" | "high" | "urgent";

/** Fee multipliers applied per priority level. */
export interface PriorityMultipliers {
  low: number;
  normal: number;
  high: number;
  urgent: number;
}

/** Default multipliers: 0.5× low, 1× normal, 2× high, 5× urgent. */
export const DEFAULT_PRIORITY_MULTIPLIERS: PriorityMultipliers = {
  low: 0.5,
  normal: 1,
  high: 2,
  urgent: 5,
};

/** Optional hooks and cache for fee estimation. */
export interface AdaptiveFeeOptions {
  urgency?: TransactionPriority;
  feeHistory?: number[];
  minMultiplier?: number;
  maxMultiplier?: number;
}

/** Calculate a bounded fee recommendation from urgency and recent observations. */
export function calculateAdaptiveFee(
  baseFee: number,
  options: AdaptiveFeeOptions = {},
): number {
  if (!Number.isFinite(baseFee) || baseFee <= 0) return parseInt(BASE_FEE, 10);
  const urgency = options.urgency ?? "normal";
  const urgencyMultiplier = DEFAULT_PRIORITY_MULTIPLIERS[urgency];
  const history = (options.feeHistory ?? []).filter((fee) => Number.isFinite(fee) && fee > 0);
  let trendMultiplier = 1;
  if (history.length >= 2) {
    const first = history[0] ?? baseFee;
    const last = history[history.length - 1] ?? first;
    const trend = Math.max(-0.25, Math.min(0.5, (last - first) / first));
    trendMultiplier += trend;
  }
  const minMultiplier = Math.max(0.1, options.minMultiplier ?? 0.5);
  const maxMultiplier = Math.max(minMultiplier, options.maxMultiplier ?? 5);
  const multiplier = Math.max(minMultiplier, Math.min(maxMultiplier, urgencyMultiplier * trendMultiplier));
  return Math.max(parseInt(BASE_FEE, 10), Math.round(baseFee * multiplier));
}

export interface FeeEstimateOptions {
  /** Client-level cache for storing the recent median fee */
  cache?: SorokitCache;
  /** Invoked when a fee surge is detected — useful for logging or UI alerts */
  onFeeSurge?: (estimate: FeeEstimate) => void;
  /** When true, fetches recent transaction fees from Horizon and adds tier recommendations */
  includeTiers?: boolean;
  /**
   * When true, fetches the last 100 network transactions to compute
   * congestion-aware min/recommended/max fees (issue #193).
   */
  includeCongestionEstimate?: boolean;
  /**
   * Transaction urgency. Applies a multiplier to the base simulated fee.
   * Defaults to "normal" (1× multiplier). The result is clamped to BASE_FEE.
   */
  priority?: TransactionPriority;
  /** Alias for priority, using urgency terminology. */
  urgency?: TransactionPriority;
  /** Recent network fee observations used to adjust the recommendation. */
  feeHistory?: number[];
  /** Lower bound for adaptive urgency/trend multiplier. */
  minMultiplier?: number;
  /** Upper bound for adaptive urgency/trend multiplier. */
  maxMultiplier?: number;
  /**
   * Override the default priority multipliers. Omit to use DEFAULT_PRIORITY_MULTIPLIERS.
   */
  priorityMultipliers?: PriorityMultipliers;
}

/** Number of recent transactions fetched to compute congestion-aware percentiles. */
const CONGESTION_TX_LIMIT = 100;

/**
 * Input for fee estimation.
 * Provide either a pre-built XDR or a simple payment description.
 */
export type FeeEstimateInput =
  | {
      kind: "xdr";
      /** Pre-built unsigned transaction XDR to simulate */
      transactionXdr: string;
    }
  | {
      kind: "payment";
      /** Source account public key — used to build a sample transaction */
      publicKey: string;
      /** Destination account */
      destination: string;
      /** Amount in XLM or asset units */
      amount: string;
      /** Asset code — defaults to XLM */
      assetCode?: string;
      /** Asset issuer — required for non-native assets */
      assetIssuer?: string;
    };

/** Cache key for fee tiers derived from recent Horizon transactions. */
export const FEE_TIERS_CACHE_KEY = "sorokit:fee-tiers";

/** Cache key for congestion-aware fee estimate. */
export const CONGESTION_FEE_CACHE_KEY = "sorokit:congestion-fee-estimate";

/** Number of recent transactions fetched to compute fee tier percentiles. */
const FEE_TIERS_TX_LIMIT = 50;

/**
 * Compute 10th/50th/90th percentile fee tiers from an array of raw fee values.
 * Invalid and non-positive values are excluded. Falls back to BASE_FEE when
 * no valid fees remain.
 */
export function calculateFeeTiers(fees: number[]): FeeTiers {
  const base = parseInt(BASE_FEE, 10);
  const valid = fees.filter((f) => Number.isFinite(f) && f > 0).sort((a, b) => a - b);

  if (valid.length === 0) {
    return { economy: String(base), standard: String(base), fast: String(base) };
  }

  const percentile = (pct: number): number => {
    const idx = Math.min(Math.floor((pct / 100) * valid.length), valid.length - 1);
    return valid[idx] ?? base;
  };

  return {
    economy: String(percentile(10)),
    standard: String(percentile(50)),
    fast: String(percentile(90)),
  };
}

/**
 * Fetch recent transaction fees from Horizon and compute percentile-based
 * fee tiers. Falls back to BASE_FEE for all tiers if no data is available.
 * Results are cached for the default fee TTL when a cache is provided.
 */
export async function fetchFeeTiers(horizonUrl: string, cache?: SorokitCache): Promise<FeeTiers> {
  const base = parseInt(BASE_FEE, 10);
  const fallback: FeeTiers = { economy: String(base), standard: String(base), fast: String(base) };

  if (cache) {
    const cached = cache.get(FEE_TIERS_CACHE_KEY);
    if (cached != null) return cached as FeeTiers;
  }

  try {
    const server = createHorizonServer(horizonUrl);
    const page = await server.transactions().order("desc").limit(FEE_TIERS_TX_LIMIT).call();

    const fees = page.records.map(
      (tx) => parseInt((tx as { fee_charged?: string }).fee_charged ?? "", 10),
    );

    const tiers = calculateFeeTiers(fees);

    if (cache) {
      cache.set(FEE_TIERS_CACHE_KEY, tiers, DEFAULT_FEE_CACHE_TTL_MS);
    }

    return tiers;
  } catch {
    return fallback;
  }
}

/**
 * Fetch the last `CONGESTION_TX_LIMIT` transactions from Horizon to compute
 * a congestion-aware fee estimate (issue #193).
 *
 * Returns `minFee` (p10), `recommendedFee` (p50), and `maxFee` (p90) plus a
 * qualitative `congestionLevel` label based on the ratio of the current
 * simulated fee to the recent median.
 */
export async function fetchCongestionFeeEstimate(
  horizonUrl: string,
  currentFeeStroops: number,
  cache?: SorokitCache,
): Promise<CongestionFeeEstimate> {
  const base = parseInt(BASE_FEE, 10);
  const fallback: CongestionFeeEstimate = {
    minFee: String(base),
    recommendedFee: String(base),
    maxFee: String(base),
    congestionLevel: "low",
  };

  if (cache) {
    const cached = cache.get(CONGESTION_FEE_CACHE_KEY);
    if (cached != null) {
      // Re-compute the congestionLevel from the fresh simulated fee
      const c = cached as CongestionFeeEstimate;
      const median = parseInt(c.recommendedFee, 10);
      return { ...c, congestionLevel: deriveCongestionLevel(currentFeeStroops, median) };
    }
  }

  try {
    const server = createHorizonServer(horizonUrl);
    const page = await server
      .transactions()
      .order("desc")
      .limit(CONGESTION_TX_LIMIT)
      .call();

    const fees = page.records
      .map((tx) => parseInt((tx as { fee_charged?: string }).fee_charged ?? "", 10))
      .filter((f) => Number.isFinite(f) && f > 0);

    const tiers = calculateFeeTiers(fees);
    const median = parseInt(tiers.standard, 10);

    const estimate: CongestionFeeEstimate = {
      minFee: tiers.economy,
      recommendedFee: tiers.standard,
      maxFee: tiers.fast,
      congestionLevel: deriveCongestionLevel(currentFeeStroops, median),
    };

    if (cache) {
      // Cache without the dynamic congestionLevel so future callers recompute it
      const toCache: CongestionFeeEstimate = { ...estimate };
      cache.set(CONGESTION_FEE_CACHE_KEY, toCache, DEFAULT_FEE_CACHE_TTL_MS);
    }

    return estimate;
  } catch {
    return fallback;
  }
}

function deriveCongestionLevel(
  currentFeeStroops: number,
  medianFeeStroops: number,
): "low" | "medium" | "high" {
  if (medianFeeStroops <= 0) return "low";
  const ratio = currentFeeStroops / medianFeeStroops;
  if (ratio >= 2) return "high";
  if (ratio >= 1.2) return "medium";
  return "low";
}

function describeFeeEstimateFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Fee estimation failed because the transaction XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Fee estimation timed out while contacting RPC: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Fee estimation failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Fee estimation failed: ${toMessage(cause)}`;
}

/**
 * Estimate the fee for a transaction using Soroban RPC simulation.
 *
 * Supports two input modes:
 * 1. `{ kind: "xdr", transactionXdr }` — simulates a pre-built transaction XDR.
 * 2. `{ kind: "payment", publicKey, destination, amount }` — builds a sample
 *    payment transaction and simulates it.
 *
 * Falls back to `BASE_FEE` (100 stroops) when RPC simulation is unavailable.
 * When a `cache` is provided, the SHA-256 hash of the XDR is used as the cache
 * key — cache hits skip the RPC round trip entirely.
 *
 * Compares the estimated fee against the median of the last 10 network
 * transactions (via Horizon). When the fee exceeds 2× that median, `surge: true`
 * is set on the result and `onFeeSurge` is invoked if provided.
 *
 * @param rpcUrl        - Base URL of the Soroban RPC server.
 * @param horizonUrl    - Base URL of the Horizon server (used in payment mode).
 * @param networkConfig - Resolved network configuration.
 * @param input         - Fee estimation input (see `FeeEstimateInput`).
 * @param cache         - Optional cache for memoising simulation results.
 * @param cacheTtlMs    - Cache TTL in milliseconds (default: 5 minutes).
 * @returns `ok(FeeEstimate)` with fee details, or `error(TX_BUILD_FAILED)` on failure.
 *
 * @example
 * // From a pre-built XDR
 * const result = await estimateFee(rpcUrl, horizonUrl, networkConfig, {
 *   kind: "xdr",
 *   transactionXdr: xdr,
 * });
 *
 * @example
 * // From payment parameters
 * const result = await estimateFee(rpcUrl, horizonUrl, networkConfig, {
 *   kind: "payment",
 *   publicKey: "GSOURCE...",
 *   destination: "GDEST...",
 *   amount: "10",
 * });
 */
export async function estimateFee(
  rpcUrl: string,
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  input: FeeEstimateInput,
  cache?: SorokitCache,
  cacheTtlMs?: number,
  options?: FeeEstimateOptions,
): Promise<SorokitResult<FeeEstimate>> {
  try {
    let xdr: string;

    if (input.kind === "xdr") {
      if (isXdrInvalidError(input.transactionXdr)) {
        return err(
          SorokitErrorCode.TX_SIMULATE_FAILED,
          "Fee estimation failed because the transaction XDR is malformed.",
          input.transactionXdr,
        );
      }
      xdr = input.transactionXdr;
    } else {
      // Validate amount is positive before building the transaction
      const { publicKey, destination, amount, assetCode, assetIssuer } = input;
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          "Amount must be positive",
        );
      }
      const horizonServer = createHorizonServer(horizonUrl);
      const sourceAccount = await horizonServer.loadAccount(publicKey);

      let asset: Asset;
      if (!assetCode || assetCode.toUpperCase() === "XLM") {
        asset = Asset.native();
      } else {
        if (!assetIssuer) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Asset issuer is required for non-native asset: ${assetCode}`,
          );
        }
        asset = new Asset(assetCode, assetIssuer);
      }

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: networkConfig.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination,
            asset,
            amount,
          }),
        )
        .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
        .build();

      xdr = builtTx.toXDR();
    }

    // Check cache before making an RPC simulation call.
    // For "xdr" input this happens before any network call;
    // for "payment" input this happens after the Horizon account fetch but
    // before the more expensive Soroban simulation.
    const cacheKey = `sorokit:fee:${createHash("sha256").update(xdr).digest("hex")}`;
    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached != null) return ok(cached as FeeEstimate);
    }

    // Simulate via Soroban RPC
    const rpc = createSorobanServer(rpcUrl);
    const tx = TransactionBuilder.fromXDR(xdr, networkConfig.networkPassphrase);
    const simResult = await rpc.simulateTransaction(tx);

    let feeStroops: number;
    let simulated = true;

    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      // minResourceFee already includes inclusion fee; no extra BASE_FEE is added.
      feeStroops = parseInt(simResult.minResourceFee ?? BASE_FEE, 10);
    } else if (SorobanRpc.Api.isSimulationError(simResult)) {
      // Simulation failed. Fall back to BASE_FEE as the floor.
      feeStroops = parseInt(BASE_FEE, 10);
      simulated = false;
    } else {
      // Simulation unavailable. Fall back to BASE_FEE as the floor.
      feeStroops = parseInt(BASE_FEE, 10);
      simulated = false;
    }

    // Apply urgency and bounded network-trend adjustment only when requested;
    // callers that omit these options retain the historical estimate exactly.
    const priority = options?.priority ?? options?.urgency;
    if (priority || options?.feeHistory?.length) {
      const multipliers = options?.priorityMultipliers ?? DEFAULT_PRIORITY_MULTIPLIERS;
      const urgencyFee = calculateAdaptiveFee(feeStroops, {
        ...(priority ? { urgency: priority } : {}),
        feeHistory: options?.feeHistory ?? getFeeHistory(networkConfig.networkPassphrase),
        ...(options?.minMultiplier !== undefined ? { minMultiplier: options.minMultiplier } : {}),
        ...(options?.maxMultiplier !== undefined ? { maxMultiplier: options.maxMultiplier } : {}),
      });
      if (priority && options?.priorityMultipliers) {
        const customMultiplier = multipliers[priority];
        feeStroops = Math.max(parseInt(BASE_FEE, 10), Math.round(feeStroops * customMultiplier));
      } else {
        feeStroops = urgencyFee;
      }
    }

    const feeXlm = (feeStroops / 10_000_000).toFixed(7);
    const feeEstimate: FeeEstimate = {
      fee: String(feeStroops),
      feeFloat: feeStroops,
      feeXlm,
      baseFee: BASE_FEE,
      simulated,
      ...(priority ? { priority } : {}),
    };

    if (options?.includeTiers) {
      feeEstimate.tiers = await fetchFeeTiers(horizonUrl, options?.cache ?? cache);
    }

    if (options?.includeCongestionEstimate) {
      feeEstimate.congestion = await fetchCongestionFeeEstimate(
        horizonUrl,
        feeStroops,
        options?.cache ?? cache,
      );
    }

    const medianCache = options?.cache ?? cache;
    const medianFee = await fetchRecentMedianFee(horizonUrl, medianCache);
    if (medianFee != null) {
      feeEstimate.surge = isFeeSurge(feeStroops, medianFee);
      if (feeEstimate.surge && options?.onFeeSurge) {
        options.onFeeSurge(feeEstimate);
      }
    }

    const networkPassphrase = networkConfig.networkPassphrase || "default";
    const history = getFeeHistory(networkPassphrase);
    const ttl = cacheTtlMs ?? calculateAdaptiveFeeTtl(feeStroops, history);

    // Record fee into bounded history
    recordFeeEstimate(feeStroops, networkPassphrase);

    // Store in cache so subsequent calls with the same XDR are free
    if (cache) {
      cache.set(cacheKey, feeEstimate, ttl);
    }

    return ok(feeEstimate);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      describeFeeEstimateFailure(cause),
      cause,
    );
  }
}
