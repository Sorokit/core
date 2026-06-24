/**
 * Mock client factory for testing sorokit-core consumers.
 *
 * Returns a fully-typed SorokitClient where every method is a vi.fn() stub.
 * Default return values match the real client's happy-path shapes so tests
 * work out of the box without extra setup.
 *
 * Usage:
 * @example
 * import { createMockClient } from "@sorokit/core/testing";
 *
 * const client = createMockClient();
 * client.account.get.mockResolvedValueOnce(ok({ publicKey: "G...", ... }));
 *
 * @example
 * // Override specific defaults
 * const client = createMockClient({
 *   walletState: { connected: true, publicKey: "GABC...", walletType: WalletType.FREIGHTER },
 * });
 */

import { vi } from "vitest";
import { ok } from "../shared/response";
import { WalletType } from "../wallet/types";
import type { SorokitClient } from "../client/createSorokitClient";
import type { WalletState } from "../wallet/types";
import type { AccountInfo, AssetBalance } from "../account/types";
import type { TransactionResult } from "../transaction/types";
import type {
  ContractMethod,
  ContractCallResult,
  PreparedContractCall,
  SimulateTransactionResult,
} from "../soroban/types";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Default fixtures ─────────────────────────────────────────────────────────

export const MOCK_PUBLIC_KEY =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

export const MOCK_NETWORK_CONFIG: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

export const MOCK_WALLET_STATE: WalletState = {
  connected: false,
  publicKey: null,
  walletType: null,
};

export const MOCK_CONNECTED_WALLET_STATE: WalletState = {
  connected: true,
  publicKey: MOCK_PUBLIC_KEY,
  walletType: WalletType.FREIGHTER,
};

export const MOCK_ASSET_BALANCE: AssetBalance = {
  assetType: "native",
  assetCode: "XLM",
  assetIssuer: null,
  balance: "100.0000000",
  balanceFloat: 100,
};

export const MOCK_ACCOUNT_INFO: AccountInfo = {
  publicKey: MOCK_PUBLIC_KEY,
  displayAddress: `${MOCK_PUBLIC_KEY.slice(0, 5)}...${MOCK_PUBLIC_KEY.slice(-4)}`,
  sequence: "1234567890",
  subentryCount: 0,
  balances: [MOCK_ASSET_BALANCE],
};

export const MOCK_TX_RESULT: TransactionResult = {
  hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  status: "success",
  ledger: 1000,
  createdAt: "2024-01-01T00:00:00Z",
  fee: "100",
};

export const MOCK_PREPARED_CALL: PreparedContractCall = {
  transactionXdr: "AAAAAQAAAA==",
  fee: "100",
};

export const MOCK_SIMULATE_RESULT: SimulateTransactionResult = {
  fee: "100",
  success: true,
};

export const MOCK_CONTRACT_CALL_RESULT: ContractCallResult = {
  result: {} as ContractCallResult["result"],
  value: null,
};

export const MOCK_CONTRACT_METHODS: ContractMethod[] = [
  {
    name: "hello",
    inputs: [{ name: "to", type: "symbol" }],
    returnType: "symbol",
  },
];

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MockClientConfig {
  /** Override the default wallet state returned by wallet.emptyState() */
  walletState?: WalletState;
  /** Override the default network config */
  networkConfig?: ResolvedNetworkConfig;
  /** Override the default account info */
  accountInfo?: AccountInfo;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a mock SorokitClient with vi.fn() stubs for every method.
 *
 * All stubs return happy-path SorokitResult values by default.
 * Override individual methods using `.mockResolvedValueOnce()` etc.
 */
export function createMockClient(config?: MockClientConfig): SorokitClient {
  const networkConfig = config?.networkConfig ?? MOCK_NETWORK_CONFIG;
  const walletState = config?.walletState ?? MOCK_WALLET_STATE;
  const accountInfo = config?.accountInfo ?? MOCK_ACCOUNT_INFO;

  return {
    networkConfig,

    wallet: {
      connect: vi.fn().mockResolvedValue(ok(MOCK_CONNECTED_WALLET_STATE)),
      disconnect: vi.fn().mockResolvedValue(ok(walletState)),
      signTransaction: vi.fn().mockResolvedValue(ok("SIGNED_XDR_MOCK==")),
      emptyState: vi.fn().mockReturnValue(ok(walletState)),
    },

    account: {
      get: vi.fn().mockResolvedValue(ok(accountInfo)),
      getBalances: vi.fn().mockResolvedValue(ok(accountInfo.balances)),
      getAssetBalances: vi.fn().mockResolvedValue(ok(accountInfo.balances)),
      formatAddress: vi.fn().mockReturnValue(accountInfo.displayAddress),
    },

    transaction: {
      buildPayment: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      buildCreateAccount: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      buildTrustline: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      submit: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT)),
      getStatus: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT)),
      estimateFee: vi.fn().mockResolvedValue(
        ok({
          fee: "100",
          feeFloat: 100,
          feeXlm: "0.0000100",
          baseFee: "100",
          simulated: true,
        }),
      ),
    },

    soroban: {
      getContractMethods: vi.fn().mockResolvedValue(ok(MOCK_CONTRACT_METHODS)),
      simulate: vi.fn().mockResolvedValue(ok(MOCK_SIMULATE_RESULT)),
      prepare: vi.fn().mockResolvedValue(ok(MOCK_PREPARED_CALL)),
      execute: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT.hash)),
      invoke: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT.hash)),
      read: vi.fn().mockResolvedValue(ok(MOCK_CONTRACT_CALL_RESULT)),
    },

    network: {
      getConfig: vi.fn().mockReturnValue(networkConfig),
    },
  } as unknown as SorokitClient;
}

/**
 * Create a mock WalletAdapter for testing wallet integration code.
 *
 * @example
 * const adapter = createMockWalletAdapter();
 * adapter.connect.mockResolvedValueOnce(err(SorokitErrorCode.WALLET_CONNECT_FAILED, "..."));
 */
export function createMockWalletAdapter() {
  return {
    walletType: WalletType.FREIGHTER,
    isAvailable: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(ok(MOCK_PUBLIC_KEY)),
    disconnect: vi.fn().mockResolvedValue(ok(undefined)),
    signTransaction: vi.fn().mockResolvedValue(ok("SIGNED_XDR_MOCK==")),
  };
}
