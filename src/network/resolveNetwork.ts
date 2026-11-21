import { NETWORK_DEFAULTS } from "./config";
import type { NetworkConfig, NetworkType } from "./config";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface NetworkOverrides {
  /** Override the default Horizon URL */
  horizonUrl?: string | undefined;
  /** Override the default Soroban RPC URL */
  rpcUrl?: string | undefined;
}

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const URL_RULE_DESCRIPTION =
  "Must be a valid HTTPS URL, or an HTTP URL on localhost/127.0.0.1.";

/**
 * Validate that a value is a well-formed HTTPS URL, or an HTTP URL pointing
 * at localhost (common for local Horizon/RPC nodes during development).
 * Purely structural — never performs a DNS lookup or reachability check.
 */
function isValidUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
    return true;
  }
  return false;
}

/**
 * Resolve a NetworkConfig from a network type and optional overrides.
 *
 * This is the single config-driven entry point for the network layer.
 * It replaces the previous getNetwork() + setNetwork() split.
 *
 * - With no overrides: returns the canonical defaults for the network
 * - With overrides: merges them on top of the defaults
 *
 * @example
 * resolveNetwork('testnet')
 * resolveNetwork('testnet', { horizonUrl: 'https://my-horizon.example.com' })
 */
export function resolveNetwork(
  network: NetworkType,
  overrides?: NetworkOverrides,
): SorokitResult<NetworkConfig> {
  const base = NETWORK_DEFAULTS[network];
  if (!base) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Unknown network: "${network}". Valid options are mainnet, testnet, futurenet.`,
    );
  }
  if (!overrides) return ok(base);

  if (
    overrides.horizonUrl !== undefined &&
    !isValidUrl(overrides.horizonUrl)
  ) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Invalid horizonUrl: "${overrides.horizonUrl}". ${URL_RULE_DESCRIPTION}`,
    );
  }

  if (overrides.rpcUrl !== undefined && !isValidUrl(overrides.rpcUrl)) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Invalid rpcUrl: "${overrides.rpcUrl}". ${URL_RULE_DESCRIPTION}`,
    );
  }

  return ok({
    ...base,
    ...(overrides.horizonUrl !== undefined && {
      horizonUrl: overrides.horizonUrl,
    }),
    ...(overrides.rpcUrl !== undefined && { rpcUrl: overrides.rpcUrl }),
  });
}
