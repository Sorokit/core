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
export type {
  LogLevel,
  LoggerOptions,
  LogTransport,
  SorokitLogger,
  StructuredLogRecord,
} from "./logger";
export type { SorokitCache } from "./cache";

export type PriceFeedStatus = "fresh" | "stale" | "unavailable" | "invalid";

export interface AssetPrice {
  asset: string;
  price: number;
  currency: string;
  provider: string;
  timestamp: string;
  status: PriceFeedStatus;
}

export interface PriceFeed {
  readonly name: string;
  getPrice(asset: string, currency?: string): Promise<AssetPrice | null>;
}

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
  /**
   * Optional network-specific multiplier applied to the protocol base fee
   * (see `transaction/feePolicy`). When omitted, the built-in per-network
   * policy is used. Custom networks can set this to match their real base fee.
   */
  baseFeeMultiplier?: number;
}
