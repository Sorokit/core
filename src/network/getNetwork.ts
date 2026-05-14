import { resolveNetwork } from "./resolveNetwork";
import type { NetworkConfig, NetworkType } from "./config";
import type { SorokitResult } from "../shared/response";

/**
 * Get the default NetworkConfig for a network type.
 * Delegates to resolveNetwork() with no overrides.
 */
export function getNetwork(network: NetworkType): SorokitResult<NetworkConfig> {
  return resolveNetwork(network);
}
