import { resolveNetwork } from "./resolveNetwork";
import type { NetworkConfig, NetworkType } from "./config";
import type { SorokitResult } from "../shared/response";

/**
 * Build a NetworkConfig with optional URL overrides.
 * Delegates to resolveNetwork().
 */
export function setNetwork(
  network: NetworkType,
  overrides?: Partial<Pick<NetworkConfig, "horizonUrl" | "rpcUrl">>,
): SorokitResult<NetworkConfig> {
  return resolveNetwork(network, overrides);
}
