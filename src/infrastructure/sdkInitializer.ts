/**
 * Single-entry SDK initialization helper.
 *
 * This module translates convenient global configuration into the existing
 * createSorokitClient API; it does not replace or modify that API.
 */

import {
  createSorokitClient,
  type SorokitClient,
  type SorokitClientConfig,
} from "../client/createSorokitClient";
import type { NetworkType } from "../network/config";
import { createInMemoryCache, type SorokitCache } from "../shared/cache";
import type { LogLevel } from "../shared/logger";
import {
  err,
  SorokitErrorCode,
  type SorokitResult,
} from "../shared/response";

export type CacheStrategy = "none" | "memory" | SorokitCache;

export interface SDKInitializationConfig {
  network: NetworkType;
  logLevel?: LogLevel;
  cacheStrategy?: CacheStrategy;
  /** Global network operation timeout in milliseconds. */
  timeout?: number;
  /** Alias for timeout. */
  timeoutMs?: number;
  /** Optional custom Horizon URL. */
  horizonUrl?: string;
  /** Optional custom Soroban RPC URL. */
  rpcUrl?: string;
  /** Optional custom network passphrase. */
  networkPassphrase?: string;
}

/**
 * Initialize a Sorokit client from a small, global configuration object.
 */
export function initializeSDK(
  config: SDKInitializationConfig,
): SorokitResult<SorokitClient> {
  if (config === null || typeof config !== "object") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "SDK initialization config must be an object",
    );
  }
  if (
    config.network !== "mainnet" &&
    config.network !== "testnet" &&
    config.network !== "futurenet"
  ) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      "network must be mainnet, testnet, or futurenet",
    );
  }

  const timeout = config.timeoutMs ?? config.timeout;
  if (
    timeout !== undefined &&
    (!Number.isFinite(timeout) || timeout < 0)
  ) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "timeout must be a non-negative finite number",
    );
  }

  let cache: SorokitCache | undefined;
  if (typeof config.cacheStrategy === "object") {
    cache = config.cacheStrategy;
  } else if (config.cacheStrategy === "memory") {
    cache = createInMemoryCache();
  } else if (
    config.cacheStrategy !== undefined &&
    config.cacheStrategy !== "none"
  ) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "cacheStrategy must be 'none', 'memory', or a SorokitCache",
    );
  }

  const clientConfig: SorokitClientConfig = {
    network: config.network,
    ...(config.logLevel !== undefined ? { logLevel: config.logLevel } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(timeout !== undefined
      ? { timeoutMs: timeout, defaultTimeoutMs: timeout }
      : {}),
    ...(config.horizonUrl !== undefined
      ? { horizonUrl: config.horizonUrl }
      : {}),
    ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.networkPassphrase !== undefined
      ? { networkPassphrase: config.networkPassphrase }
      : {}),
  };

  return createSorokitClient(clientConfig);
}
