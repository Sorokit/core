/**
 * Path payment and swap path discovery.
 * 
 * This module provides functionality for finding optimal swap paths
 * between assets on the Stellar DEX.
 */

import { Asset, StrKey } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isSameAsset } from "../shared/validateToken";
import { toMessage } from "../shared";
import { createHorizonServer } from "../shared/serverFactory";

/**
 * Asset in a swap path.
 */
export interface SwapRouteAsset {
  /** Asset code (e.g., "USDC") */
  code: string;
  /** Asset issuer (null for native XLM) */
  issuer: string | null;
}

/**
 * A swap route between two assets.
 */
export interface SwapRoute {
  /** Source asset */
  source: SwapRouteAsset;
  /** Destination asset */
  destination: SwapRouteAsset;
  /** Intermediate assets in the path (empty for direct pair) */
  path: SwapRouteAsset[];
  /** Estimated price (destination amount per source amount) */
  price: string;
}

/**
 * Options for finding swap paths.
 */
export interface FindSwapPathOptions {
  /** Maximum number of hops in the path (default: 3) */
  maxHops?: number;
  /** Minimum liquidity threshold (default: 0) */
  minLiquidity?: string;
}

/**
 * Parameters for building a path payment transaction.
 */
export interface BuildPathPaymentParams {
  /** Source public key */
  sourcePublicKey: string;
  /** Destination public key */
  destination: string;
  /** Send asset code */
  sendAssetCode: string;
  /** Send asset issuer (null for native) */
  sendAssetIssuer: string | null;
  /** Destination asset code */
  destAssetCode: string;
  /** Destination asset issuer (null for native) */
  destAssetIssuer: string | null;
  /** Amount to send (strict-send) or receive (strict-receive) */
  amount: string;
  /** Mode: strict-send or strict-receive */
  mode: "strict-send" | "strict-receive";
  /** Optional pre-computed path */
  path?: SwapRouteAsset[];
}

/**
 * Convert a router failure into a stable, descriptive Sorokit error code.
 *
 * Existing callers still receive the standard `SorokitResult` envelope while
 * new integrations can branch on a contract-specific code.
 */
export function describeRouterSwapFailure(cause: unknown): {
  code: SorokitErrorCode;
  message: string;
} {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();

  if (normalized.includes("path") || normalized.includes("route")) {
    return {
      code: SorokitErrorCode.ROUTER_INVALID_PATH,
      message: `Router could not execute the requested swap path: ${message}`,
    };
  }
  if (normalized.includes("liquidity") || normalized.includes("underfunded")) {
    return {
      code: SorokitErrorCode.ROUTER_INSUFFICIENT_LIQUIDITY,
      message: `Router has insufficient liquidity for this swap: ${message}`,
    };
  }
  if (normalized.includes("slippage") || normalized.includes("minimum amount")) {
    return {
      code: SorokitErrorCode.ROUTER_SLIPPAGE_EXCEEDED,
      message: `Router swap exceeded the configured slippage limit: ${message}`,
    };
  }
  return {
    code: SorokitErrorCode.ROUTER_SWAP_FAILED,
    message: `Router swap execution failed: ${message}`,
  };
}

/**
 * Find the best swap path between two assets.
 * 
 * This is a placeholder implementation. In production, this would query
 * Stellar DEX liquidity pools to find optimal paths.
 * 
 * @param sourceAsset - Source asset
 * @param destAsset - Destination asset
 * @param options - Path finding options
 * @returns Swap route or error if no path found
 */
export async function findSwapPath(
  sourceAsset: SwapRouteAsset,
  destAsset: SwapRouteAsset,
  options?: FindSwapPathOptions,
): Promise<SorokitResult<SwapRoute>> {
  // Placeholder: return direct path with estimated price
  // In production, this would query Horizon for liquidity pools
  
  if (isSameAsset(sourceAsset, destAsset)) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      "Router path is invalid: source and destination assets cannot be the same",
    );
  }

  // For now, return a simple direct path
  const route: SwapRoute = {
    source: sourceAsset,
    destination: destAsset,
    path: [],
    price: "1.0", // Placeholder price
  };

  return ok(route);
}

/**
 * Build a path payment transaction XDR.
 * 
 * @param params - Path payment parameters
 * @returns Transaction XDR or error
 */
export async function buildPathPaymentTransaction(
  params: BuildPathPaymentParams,
): Promise<SorokitResult<string>> {
  // Placeholder implementation
  // In production, this would use Stellar SDK to build the transaction

  return err(
    SorokitErrorCode.TX_BUILD_FAILED,
    "buildPathPaymentTransaction is not yet implemented",
  );
}

// ─── Multi-hop payment path discovery (#400) ──────────────────────────────────

/** Default TTL for cached payment-path discovery results: 5 minutes. */
export const DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum number of ranked paths returned by {@link discoverPaymentPaths}. */
const MAX_PREFERRED_PATHS = 3;

/**
 * A single discovered payment path, ranked by the amount of source asset it
 * requires to satisfy the requested destination amount.
 */
export interface DiscoveredPaymentPath {
  /** Amount of the source asset required to satisfy destAmount along this path */
  sourceAmount: string;
  /** Source asset for this path */
  sourceAsset: SwapRouteAsset;
  /** Amount of the destination asset this path delivers (equals destAmount) */
  destinationAmount: string;
  /** Intermediate hops between source and destination (empty for a direct path) */
  path: SwapRouteAsset[];
  /** Number of intermediate hops (0 for a direct path) */
  hops: number;
}

/**
 * Result of a {@link discoverPaymentPaths} call.
 */
export interface PaymentPathDiscoveryResult {
  /** Up to three preferred paths, ranked ascending by required source amount (cheapest first) */
  paths: DiscoveredPaymentPath[];
  /** Whether this result was served from cache rather than a fresh Horizon query */
  fromCache: boolean;
}

/** Options for {@link discoverPaymentPaths}. */
export interface DiscoverPaymentPathsOptions {
  /**
   * Cache TTL in milliseconds for this lookup's cache entry.
   * Defaults to {@link DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS} (5 minutes).
   */
  cacheTtlMs?: number;
  /** Bypass the cache and force a fresh Horizon query. */
  skipCache?: boolean;
}

interface PathDiscoveryCacheEntry {
  result: PaymentPathDiscoveryResult;
  expiresAt: number;
}

/**
 * Module-level cache of recent path discovery results, keyed by
 * horizonUrl + source + destination + destAsset + destAmount.
 *
 * NOTE: cached paths reflect liquidity at query time. They are not a
 * guarantee that the path remains fillable — callers building an actual
 * path payment transaction should treat a cached path as a starting point
 * and let `buildPathPayment` re-verify or re-discover if the transaction
 * fails due to insufficient liquidity (e.g. `op_too_few_offers`).
 */
const pathDiscoveryCache = new Map<string, PathDiscoveryCacheEntry>();

function pathDiscoveryCacheKey(
  horizonUrl: string,
  source: string,
  destination: string,
  destinationAsset: SwapRouteAsset,
  destAmount: string,
): string {
  const assetKey = `${destinationAsset.code}:${destinationAsset.issuer ?? "native"}`;
  return `${horizonUrl}|${source}|${destination}|${assetKey}|${destAmount}`;
}

/** Clear the module-level path discovery cache. Intended for tests. */
export function clearPathDiscoveryCache(): void {
  pathDiscoveryCache.clear();
}

function toSwapRouteAsset(hop: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): SwapRouteAsset {
  if (hop.asset_type === "native") {
    return { code: "XLM", issuer: null };
  }
  return { code: hop.asset_code ?? "", issuer: hop.asset_issuer ?? null };
}

/**
 * Discover viable multi-hop payment paths from a source account to a
 * destination asset/amount, using Horizon's strict-receive path-finding
 * (which considers the source account's actual balances and available
 * order-book / liquidity-pool liquidity).
 *
 * Results are ranked ascending by required source amount (cheapest path
 * first) and limited to the top three. Recent results are cached in-memory
 * for a short, configurable TTL (default 5 minutes) to avoid repeated
 * Horizon round trips for the same query.
 *
 * @param horizonUrl        Base URL of the Horizon server.
 * @param source            G-address of the paying account. Horizon uses this
 *                           account's held assets as the candidate source assets.
 * @param destination       G-address of the receiving account (informational —
 *                           not used in path discovery, but validated so the
 *                           returned paths can be handed directly to a payment
 *                           builder alongside the destination).
 * @param destinationAsset  Asset the destination account should receive.
 * @param destAmount        Amount of `destinationAsset` the destination should receive.
 * @param options           Cache TTL / bypass options.
 * @returns `ok(result)` with up to three ranked paths (`result.paths` is empty,
 *          not an error, when no path currently exists), or an error for
 *          invalid input / Horizon failures.
 *
 * @example
 * const result = await discoverPaymentPaths(
 *   horizonUrl,
 *   sourcePublicKey,
 *   destinationPublicKey,
 *   { code: "USDC", issuer: "GA5ZS..." },
 *   "100",
 * );
 * if (result.status === "ok" && result.data.paths.length > 0) {
 *   const best = result.data.paths[0];
 * }
 */
export async function discoverPaymentPaths(
  horizonUrl: string,
  source: string,
  destination: string,
  destinationAsset: SwapRouteAsset,
  destAmount: string,
  options?: DiscoverPaymentPathsOptions,
): Promise<SorokitResult<PaymentPathDiscoveryResult>> {
  if (!StrKey.isValidEd25519PublicKey(source)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid source account address: ${source}`);
  }
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid destination account address: ${destination}`);
  }

  const destAmountNum = Number(destAmount);
  if (!Number.isFinite(destAmountNum) || destAmountNum <= 0) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      `destAmount must be a positive numeric string, got: ${destAmount}`,
    );
  }

  if (
    !destinationAsset ||
    typeof destinationAsset.code !== "string" ||
    destinationAsset.code.trim().length === 0
  ) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      "destinationAsset must have a non-empty asset code",
    );
  }
  if (destinationAsset.code.toUpperCase() !== "XLM" && !destinationAsset.issuer) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      `destinationAsset issuer is required for non-native asset: ${destinationAsset.code}`,
    );
  }

  const cacheKey = pathDiscoveryCacheKey(
    horizonUrl,
    source,
    destination,
    destinationAsset,
    destAmount,
  );

  if (!options?.skipCache) {
    const cached = pathDiscoveryCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return ok({ ...cached.result, fromCache: true });
    }
    if (cached) {
      pathDiscoveryCache.delete(cacheKey);
    }
  }

  try {
    const server = createHorizonServer(horizonUrl);
    const destAsset =
      destinationAsset.code.toUpperCase() === "XLM"
        ? Asset.native()
        : new Asset(destinationAsset.code, destinationAsset.issuer!);

    const response = await server
      .strictReceivePaths(source, destAsset, destAmount)
      .call();

    const ranked: DiscoveredPaymentPath[] = response.records
      .map((record) => ({
        sourceAmount: record.source_amount,
        sourceAsset: toSwapRouteAsset({
          asset_type: record.source_asset_type,
          asset_code: record.source_asset_code,
          asset_issuer: record.source_asset_issuer,
        }),
        destinationAmount: record.destination_amount,
        path: record.path.map(toSwapRouteAsset),
        hops: record.path.length,
      }))
      .sort((a, b) => Number(a.sourceAmount) - Number(b.sourceAmount))
      .slice(0, MAX_PREFERRED_PATHS);

    const result: PaymentPathDiscoveryResult = { paths: ranked, fromCache: false };

    const ttlMs = options?.cacheTtlMs ?? DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS;
    pathDiscoveryCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });

    return ok(result);
  } catch (cause) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      `Failed to discover payment paths: ${toMessage(cause)}`,
      cause,
    );
  }
}


/** A route quote with a maximum fillable destination amount. */
export interface PaymentRouteQuote {
  route: SwapRoute;
  /** Maximum destination amount this route can currently deliver. */
  maxDestinationAmount: string;
  /** Source amount required to fill maxDestinationAmount. */
  sourceAmount: string;
}

export interface SplitPaymentLeg {
  route: SwapRoute;
  destinationAmount: string;
  sourceAmount: string;
}

export interface SplitPaymentPlan {
  legs: readonly SplitPaymentLeg[];
  totalDestinationAmount: string;
  totalSourceAmount: string;
}

export interface SplitPaymentOptions {
  /** Do not use more than this many routes. Defaults to all supplied quotes. */
  maxPaths?: number;
  /** Reject plans containing a leg smaller than this destination amount. */
  minLegDestinationAmount?: string;
}

const AMOUNT_SCALE = 7n;
const AMOUNT_FACTOR = 10n ** AMOUNT_SCALE;

function parseStellarAmount(value: string, field: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(normalized)) {
    throw new Error(`${field} must be a non-negative Stellar amount with at most 7 decimals`);
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * AMOUNT_FACTOR + BigInt(fraction.padEnd(7, "0"));
}

function formatStellarAmount(value: bigint): string {
  const whole = value / AMOUNT_FACTOR;
  const fraction = (value % AMOUNT_FACTOR).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Build an optimized split plan for a strict-receive payment.
 *
 * Quotes are ranked by effective source cost and filled greedily. Every leg
 * remains a normal path payment, so callers can build and submit the legs as
 * one atomic transaction where the network or application supports batching.
 * The planner is deterministic and never over-allocates a route’s quoted
 * capacity.
 */
export function buildOptimizedSplitPaymentPlan(
  quotes: readonly PaymentRouteQuote[],
  destinationAmount: string,
  options?: SplitPaymentOptions,
): SorokitResult<SplitPaymentPlan> {
  let target: bigint;
  try {
    target = parseStellarAmount(destinationAmount, "destinationAmount");
  } catch (cause) {
    return err(SorokitErrorCode.ROUTER_INVALID_PATH, toMessage(cause), cause);
  }
  if (target <= 0n) {
    return err(SorokitErrorCode.ROUTER_INVALID_PATH, "destinationAmount must be positive");
  }
  if (quotes.length === 0) {
    return err(SorokitErrorCode.ROUTER_INVALID_PATH, "at least one route quote is required");
  }

  let normalized: Array<{
    quote: PaymentRouteQuote;
    capacity: bigint;
    source: bigint;
    rate: number;
  }>;
  try {
    normalized = quotes.map((quote) => {
      const capacity = parseStellarAmount(quote.maxDestinationAmount, "maxDestinationAmount");
      const source = parseStellarAmount(quote.sourceAmount, "sourceAmount");
      if (capacity <= 0n || source <= 0n) throw new Error("route quote amounts must be positive");
      return { quote, capacity, source, rate: Number(source) / Number(capacity) };
    });
  } catch (cause) {
    return err(SorokitErrorCode.ROUTER_INVALID_PATH, toMessage(cause), cause);
  }
  const maxPaths = options?.maxPaths ?? normalized.length;
  if (!Number.isInteger(maxPaths) || maxPaths <= 0) {
    return err(SorokitErrorCode.ROUTER_INVALID_PATH, "maxPaths must be a positive integer");
  }
  const minLeg = options?.minLegDestinationAmount
    ? parseStellarAmount(options.minLegDestinationAmount, "minLegDestinationAmount")
    : 0n;
  normalized.sort((a, b) => a.rate - b.rate);

  let remaining = target;
  let totalSource = 0n;
  const legs: SplitPaymentLeg[] = [];
  for (const candidate of normalized.slice(0, maxPaths)) {
    if (remaining === 0n) break;
    const destination = remaining < candidate.capacity ? remaining : candidate.capacity;
    if (destination < minLeg && remaining !== target) continue;
    const source = (candidate.source * destination + candidate.capacity - 1n) / candidate.capacity;
    legs.push({
      route: candidate.quote.route,
      destinationAmount: formatStellarAmount(destination),
      sourceAmount: formatStellarAmount(source),
    });
    remaining -= destination;
    totalSource += source;
  }
  if (remaining > 0n) {
    return err(
      SorokitErrorCode.ROUTER_INSUFFICIENT_LIQUIDITY,
      `route quotes cannot deliver the requested destination amount; short by ${formatStellarAmount(remaining)}`,
    );
  }
  return ok({
    legs,
    totalDestinationAmount: formatStellarAmount(target),
    totalSourceAmount: formatStellarAmount(totalSource),
  });
}
