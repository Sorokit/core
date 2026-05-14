/**
 * Network configuration — defaults and the canonical NetworkConfig type.
 *
 * NetworkConfig extends ResolvedNetworkConfig from shared/types so that
 * transaction/ and soroban/ modules can type their parameters against
 * ResolvedNetworkConfig without importing from this file.
 *
 * Rule: only network/ and client/ import from this file.
 */

import type { ResolvedNetworkConfig } from "../shared/types";

export type NetworkType = "mainnet" | "testnet" | "futurenet";

/** Full network config — extends the shared shape with no additions. */
export type NetworkConfig = ResolvedNetworkConfig;

export const NETWORK_DEFAULTS: Record<NetworkType, NetworkConfig> = {
  mainnet: {
    network: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://mainnet.stellar.validationcloud.io/v1/soroban/rpc",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
  testnet: {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  futurenet: {
    network: "futurenet",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
};
