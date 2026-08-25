/**
 * Path payment and swap path discovery.
 *
 * This module provides functionality for finding optimal swap paths
 * between assets on the Stellar DEX.
 */

import { Asset } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isSameAsset } from "../shared/validateToken";
import type { SorokitCache } from "../shared/cache";
import { createHorizonServer } from "../shared/serverFactory";
import { toMessage } from "../shared/errors";

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

// ─── Multi-hop payment path discovery (issue #400) ────────────────────────────

/** One asset hop in a discovered path, exposed for comparison before construction. */
export interface DiscoveredPathHop {
  assetCode: string;
  assetIssuer: string | null;
}

/**
 * A single discovered payment path, ranked by how much source asset it
 * requires to deliver the requested destination amount — lower is better.
 */
export interface DiscoveredPaymentPath {
  /** Amount of the source asset this path requires. */
  sourceAmount: string;
  /** Requested destination amount this path delivers (mirrors the input). */
  destinationAmount: string;
  /** Intermediate hops between source and destination (empty for a direct path). */
  path: DiscoveredPathHop[];
  /** Number of intermediate hops — `path.length`, exposed for convenience. */
  hops: number;
}

/**
 * Result of a payment path discovery query.
 */
export interface DiscoverPaymentPathsResult {
  source: string;
  destinationAsset: SwapRouteAsset;
  destinationAmount: string;
  /** Up to three viable paths, ranked by required source-asset input (best first). */
  paths: DiscoveredPaymentPath[];
  /**
   * True when this result was served from cache rather than a fresh Horizon
   * query. Cached liquidity data can go stale quickly — see the warning on
   * {@link discoverPaymentPaths}.
   */
  fromCache: boolean;
}

/** Default cache TTL for discovered paths: 5 minutes (issue #400). */
export const DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
/** Maximum number of ranked paths returned. */
const MAX_RETURNED_PATHS = 3;

function buildCacheKey(
  source: string,
  destination: SwapRouteAsset,
  destAmount: string,
): string {
  return `sorokit:path-discovery:${source}:${destination.code}:${destination.issuer ?? "native"}:${destAmount}`;
}

function toAsset(hop: SwapRouteAsset): Asset {
  return hop.issuer ? new Asset(hop.code, hop.issuer) : Asset.native();
}

/**
 * Discover viable multi-hop payment paths from `source` to `destinationAsset`
 * for a requested `destAmount`, using live Stellar network liquidity data
 * (Horizon's strict-receive path-finding).
 *
 * Returns up to three paths, ranked by the amount of source-asset input
 * required — the cheapest (best rate) path first — so callers can compare
 * routes before constructing a payment transaction with
 * {@link buildPathPayment} in `transaction/buildTransaction.ts`. This
 * function only discovers and ranks paths; it never builds or submits a
 * transaction.
 *
 * **Stale-liquidity warning:** a cached result reflects order-book/liquidity
 * state at query time and is NOT a guaranteed rate. DEX liquidity can move
 * between the time a path is discovered (or read from cache) and when a
 * payment is actually submitted. Always pass an appropriate `sendMax`/
 * `destMin` slippage bound when building the transaction, and treat a
 * discovered path as an estimate, never as guaranteed liquidity — this
 * applies equally to fresh and cached results.
 *
 * @param horizonUrl Base URL of the Horizon server.
 * @param source Either a source account (G-address) whose balances are used
 *   as candidate source assets, or an explicit list of source assets to
 *   consider.
 * @param destinationAsset The asset the destination should receive.
 * @param destAmount The exact amount of `destinationAsset` to deliver.
 * @param options Optional cache and TTL (default: 5 minutes, per issue #400).
 * @returns `ok(DiscoverPaymentPathsResult)` with up to three ranked paths
 *   (`paths: []` when no viable path exists — this is not an error), or an
 *   error result if the discovery query itself fails.
 *
 * @example
 * const result = await discoverPaymentPaths(
 *   horizonUrl,
 *   sourcePublicKey,
 *   { code: "EURC", issuer: eurcIssuer },
 *   "100",
 * );
 * if (result.status === "ok" && result.data.paths.length > 0) {
 *   const best = result.data.paths[0];
 *   // Compare best.sourceAmount across paths, then build with buildPathPayment.
 * }
 */
export async function discoverPaymentPaths(
  horizonUrl: string,
  source: string | SwapRouteAsset[],
  destinationAsset: SwapRouteAsset,
  destAmount: string,
  options?: { cache?: SorokitCache; cacheTtlMs?: number },
): Promise<SorokitResult<DiscoverPaymentPathsResult>> {
  if (!destAmount || isNaN(Number(destAmount)) || Number(destAmount) <= 0) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      `discoverPaymentPaths: destAmount must be a positive numeric string (got ${destAmount}).`,
    );
  }

  const cacheKey = buildCacheKey(
    typeof source === "string" ? source : JSON.stringify(source),
    destinationAsset,
    destAmount,
  );

  if (options?.cache) {
    const cached = options.cache.get(cacheKey);
    if (cached != null) {
      return ok({ ...(cached as DiscoverPaymentPathsResult), fromCache: true });
    }
  }

  try {
    const server = createHorizonServer(horizonUrl);
    const destAsset = toAsset(destinationAsset);
    const sourceParam =
      typeof source === "string" ? source : source.map(toAsset);

    const response = await server
      .strictReceivePaths(sourceParam, destAsset, destAmount)
      .call();

    const paths: DiscoveredPaymentPath[] = response.records
      .map((record) => ({
        sourceAmount: record.source_amount,
        destinationAmount: record.destination_amount,
        path: record.path.map((hop) => ({
          assetCode: hop.asset_type === "native" ? "XLM" : hop.asset_code,
          assetIssuer: hop.asset_type === "native" ? null : hop.asset_issuer,
        })),
        hops: record.path.length,
      }))
      // Rank by required source input, ascending — the cheapest route first.
      .sort((a, b) => Number(a.sourceAmount) - Number(b.sourceAmount))
      .slice(0, MAX_RETURNED_PATHS);

    const result: DiscoverPaymentPathsResult = {
      source: typeof source === "string" ? source : JSON.stringify(source),
      destinationAsset,
      destinationAmount: destAmount,
      paths,
      fromCache: false,
    };

    if (options?.cache) {
      options.cache.set(
        cacheKey,
        result,
        options.cacheTtlMs ?? DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
      );
    }

    return ok(result);
  } catch (cause) {
    return err(
      SorokitErrorCode.ROUTER_INVALID_PATH,
      `discoverPaymentPaths: path discovery failed: ${toMessage(cause)}`,
      cause,
    );
  }
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
 * Stellar DEX liquidity pools to find optimal paths. For live multi-hop
 * discovery ranked by required input, use {@link discoverPaymentPaths}.
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
