/**
 * Network-specific fee policy (issue #705).
 *
 * Stellar defines a protocol minimum base fee (`BASE_FEE`, 100 stroops) that
 * every transaction must pay per operation. That constant is a *protocol*
 * floor — individual networks can (and, on experimental networks, do) vote to
 * raise their own base fee above it.
 *
 * Historically `estimateFee` used the same global `BASE_FEE` for every network,
 * which under-estimates fees on networks whose effective base fee is higher
 * (notably Futurenet) and ignores network-specific behaviour entirely. This
 * module centralises the per-network policy so every fee helper derives its
 * floor from the same source.
 *
 * Policy:
 * - `mainnet`  — 1× the protocol floor (100 stroops).
 * - `testnet`  — 1× the protocol floor (100 stroops); mirrors mainnet.
 * - `futurenet`— 2× the protocol floor (200 stroops). Futurenet runs ahead of
 *   mainnet and is frequently configured with elevated fee parameters, so we
 *   conservatively scale the floor to avoid under-estimating.
 * - unknown / custom networks — 1× by default, so they are never overcharged.
 *
 * A caller that knows its network's actual base fee can override the multiplier
 * either per call (see `getNetworkBaseFee`) or via
 * `ResolvedNetworkConfig.baseFeeMultiplier`.
 */

import { BASE_FEE } from "@stellar/stellar-sdk";
import type { ResolvedNetworkConfig } from "../shared/types";

/** Network identifiers understood by the fee policy. */
export type FeeNetwork = ResolvedNetworkConfig["network"];

/** Protocol minimum base fee in stroops (the stellar-sdk `BASE_FEE` constant). */
export const PROTOCOL_BASE_FEE = parseInt(BASE_FEE, 10);

/**
 * Multipliers applied to the protocol base fee for each supported network.
 * Kept intentionally small and explicit so fee behaviour is auditable.
 */
export const NETWORK_BASE_FEE_MULTIPLIERS: Record<FeeNetwork, number> = {
  mainnet: 1,
  testnet: 1,
  futurenet: 2,
};

/** Multiplier used for networks that are not explicitly configured. */
export const DEFAULT_BASE_FEE_MULTIPLIER = 1;

function isValidMultiplier(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the base-fee multiplier for a network.
 *
 * @param network  Network identifier (case-insensitive). Unknown names fall
 *                 back to {@link DEFAULT_BASE_FEE_MULTIPLIER}.
 * @param override Explicit multiplier that takes precedence when valid.
 */
export function getNetworkBaseFeeMultiplier(
  network?: string | null,
  override?: number,
): number {
  if (isValidMultiplier(override)) return override;
  if (!network) return DEFAULT_BASE_FEE_MULTIPLIER;
  const key = network.toLowerCase() as FeeNetwork;
  const multiplier = NETWORK_BASE_FEE_MULTIPLIERS[key];
  return isValidMultiplier(multiplier) ? multiplier : DEFAULT_BASE_FEE_MULTIPLIER;
}

/**
 * Derive a network's effective base fee (in stroops) from the protocol floor
 * and the network's multiplier.
 *
 * @param network  Network identifier.
 * @param options  `protocolBaseFee` overrides the `BASE_FEE` constant (useful
 *                 for tests or networks that expose their real base fee);
 *                 `multiplier` overrides the policy lookup.
 */
export function getNetworkBaseFee(
  network?: string | null,
  options?: { protocolBaseFee?: number; multiplier?: number },
): number {
  const protocolBaseFee = isValidMultiplier(options?.protocolBaseFee)
    ? options.protocolBaseFee
    : PROTOCOL_BASE_FEE;
  const multiplier = getNetworkBaseFeeMultiplier(network, options?.multiplier);
  return Math.max(1, Math.round(protocolBaseFee * multiplier));
}

/**
 * Convenience helper: derive the effective base fee directly from a resolved
 * network config. Honours `baseFeeMultiplier` when a custom config provides it.
 */
export function resolveNetworkBaseFee(
  config?: (Pick<ResolvedNetworkConfig, "network"> & {
    baseFeeMultiplier?: number;
  }) | null,
): number {
  const feeOptions: { protocolBaseFee?: number; multiplier?: number } = {};
  if (config?.baseFeeMultiplier !== undefined) {
    feeOptions.multiplier = config.baseFeeMultiplier;
  }
  return getNetworkBaseFee(config?.network, feeOptions);
}
