/**
 * Shared primitive types used across modules.
 *
 * Modules that need NetworkConfig import it from here — not from network/config.
 * This keeps the network module from being a dependency of transaction/soroban.
 *
 * The actual defaults and setNetwork() logic live in network/ only.
 * Modules only need the shape.
 */

export type { SorokitResult, SorokitError, SorokitErrorCode } from "./response";
export type { SorokitLogger, LogLevel } from "./logger";
export type { SorokitCache } from "./cache";

/**
 * The resolved network configuration shape.
 * Defined here so transaction/ and soroban/ can type their parameters
 * without importing from the network/ module.
 */
export interface ResolvedNetworkConfig {
  network: "mainnet" | "testnet" | "futurenet";
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
}
