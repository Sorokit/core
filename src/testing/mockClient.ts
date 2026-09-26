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
  "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";

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
  fee: "1000000",
};

export const MOCK_FEE_ESTIMATE = {
  fee: "1000000",
  feeFloat: 1000000,
  feeXlm: "0.1000000",
  baseFee: "100",
  simulated: true,
} as const;

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
    version: "0.1.0",
    networkConfig,
    trustedIssuers: null,
    traceId: "mock-trace-id",
    traceContext: { traceId: "mock-trace-id", parentSpanId: null, spanId: "mock-span-id" } as any,
    getTraceContext: vi.fn().mockReturnValue(null),

    wallet: {
      connect: vi.fn().mockResolvedValue(ok(MOCK_CONNECTED_WALLET_STATE)),
      disconnect: vi.fn().mockResolvedValue(ok(walletState)),
      signTransaction: vi.fn().mockResolvedValue(ok("SIGNED_XDR_MOCK==")),
      emptyState: vi.fn().mockReturnValue(ok(walletState)),
      listConnectedAccounts: vi.fn().mockResolvedValue(
        ok({
          accounts: [MOCK_PUBLIC_KEY],
          activeAccount: MOCK_PUBLIC_KEY,
        }),
      ),
      switchAccount: vi.fn().mockResolvedValue(
        ok({
          publicKey: MOCK_PUBLIC_KEY,
          walletState: MOCK_CONNECTED_WALLET_STATE,
        }),
      ),
    },

    account: {
      get: vi.fn().mockResolvedValue(ok(accountInfo)),
      getBalances: vi.fn().mockResolvedValue(ok(accountInfo.balances)),
      getAssetBalances: vi.fn().mockResolvedValue(ok(accountInfo.balances)),
      formatAddress: vi.fn().mockReturnValue(accountInfo.displayAddress),
      isValidPublicKey: vi.fn().mockReturnValue(true),
      isValidContractId: vi.fn().mockReturnValue(true),
      stream: vi.fn().mockImplementation(async function* () {
        yield ok(accountInfo);
      }),
      getAccountsBatch: vi.fn().mockResolvedValue(ok([ok(accountInfo)])),
      setSponsor: vi.fn().mockReturnValue(ok({ operations: [] })),
      removeSponsor: vi.fn().mockReturnValue(ok({ operations: [] })),
      getOffers: vi.fn().mockResolvedValue(ok({ records: [], nextCursor: null, hasMore: false })),
      getTrades: vi.fn().mockResolvedValue(ok({ records: [], nextCursor: null, hasMore: false })),
    },

    transaction: {
      buildPayment: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      buildCreateAccount: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      buildTrustline: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      buildAccountMerge: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      submit: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT)),
      submitTransaction: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT)),
      getStatus: vi.fn().mockResolvedValue(ok(MOCK_TX_RESULT)),
      estimateFee: vi.fn().mockResolvedValue(ok(MOCK_FEE_ESTIMATE)),
      stream: vi.fn().mockImplementation(async function* () {
        yield ok({ transactions: [MOCK_TX_RESULT], nextCursor: null });
      }),
      validateDestination: vi.fn().mockResolvedValue(ok({ valid: true, exists: true, isFunded: true })),
      queryHistory: vi.fn().mockResolvedValue(ok({ transactions: [], total: 0, page: 1, pageSize: 10 })),
      buildSetOptions: vi.fn().mockResolvedValue(ok("UNSIGNED_XDR_MOCK==")),
      exportHistory: vi.fn().mockResolvedValue(ok("")),
      exportTransactionHistory: vi.fn().mockResolvedValue(ok("")),
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
      getId: vi.fn().mockReturnValue(networkConfig.network),
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
    getAccounts: vi.fn().mockResolvedValue(ok([MOCK_PUBLIC_KEY])),
    setActiveAccount: vi.fn().mockResolvedValue(ok(MOCK_PUBLIC_KEY)),
  };
}
