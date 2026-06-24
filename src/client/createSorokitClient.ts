/**
 * createSorokitClient — the single public entry point for sorokit-core.
 *
 * Boundary rules enforced here:
 * - Only this file imports from multiple modules.
 * - All other modules import only from shared/ or their own files.
 * - NetworkConfig is typed from shared/types — transaction/ and soroban/
 *   never import from network/.
 */

import { resolveNetwork } from "../network/resolveNetwork";
import { connectWallet } from "../wallet/connect";
import { disconnectWallet } from "../wallet/disconnect";
import { signTransaction } from "../wallet/signTransaction";
import { emptyWalletState } from "../wallet/index";
import { getAccount } from "../account/getAccount";
import { getBalances } from "../account/getBalances";
import { getAssetBalances } from "../account/getAssetBalances";
import { streamAccount } from "../account/streamAccount";
import {
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
} from "../transaction/buildTransaction";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";
import { estimateFee } from "../transaction/estimateFee";
import { streamTransactions } from "../transaction/streamTransactions";
import { readContract } from "../soroban/readContract";
import { prepareContractCall } from "../soroban/prepareCall";
import { simulateTransaction } from "../soroban/simulateTransaction";
import { executeContract } from "../soroban/executeContract";
import { invokeContract } from "../soroban/invokeContract";
import { createLogger } from "../shared/logger";
import { formatAddress } from "../shared/utils";
import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitLogger } from "../shared/logger";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { NetworkType } from "../network/config";
import type {
  WalletAdapter,
  WalletState,
  SignTransactionInput,
} from "../wallet/types";
import type { AccountInfo, AssetBalance } from "../account/types";
import type { AssetBalanceFilter } from "../account/getAssetBalances";
import type { AccountStreamConfig } from "../account/streamAccount";
import type {
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  TransactionResult,
} from "../transaction/types";
import type { FeeEstimate, FeeEstimateInput, FeeEstimateOptions } from "../transaction/estimateFee";
import type {
  TransactionStreamConfig,
  TransactionPage,
} from "../transaction/streamTransactions";
import type {
  ContractInvokeParams,
  ContractReadParams,
  ContractCallResult,
  PreparedContractCall,
  SorobanPollConfig,
  SimulateTransactionResult,
} from "../soroban/types";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SorokitClientConfig {
  /** Target network */
  network: NetworkType;
  /** Override the default Horizon URL */
  horizonUrl?: string;
  /** Override the default Soroban RPC URL */
  rpcUrl?: string;
  /** Optional cache implementation — core is stateless by default */
  cache?: SorokitCache;
  /** Enable debug logging to console. Default: false */
  debug?: boolean;
  /** Custom logger — overrides the built-in console logger */
  logger?: SorokitLogger;
  /** Default Soroban polling config — can be overridden per-call */
  sorobanPoll?: SorobanPollConfig;
  /** Invoked when estimateFee detects a fee surge (>2x recent median) */
  onFeeSurge?: FeeEstimateOptions["onFeeSurge"];
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface SorokitClient {
  /** Resolved network configuration for this client instance */
  readonly networkConfig: ResolvedNetworkConfig;

  readonly wallet: {
    /** Connect and return WalletState */
    connect(adapter: WalletAdapter): Promise<SorokitResult<WalletState>>;
    /** Disconnect and return clean WalletState */
    disconnect(adapter: WalletAdapter): Promise<SorokitResult<WalletState>>;
    /** Sign a transaction XDR */
    signTransaction(
      adapter: WalletAdapter,
      input: SignTransactionInput,
    ): Promise<SorokitResult<string>>;
    /**
     * Return a canonical disconnected WalletState.
     * Pure utility — returns SorokitResult<WalletState>, cannot fail.
     */
    emptyState(): SorokitResult<WalletState>;
  };

  readonly account: {
    /** Fetch full account info including all balances */
    get(publicKey: string): Promise<SorokitResult<AccountInfo>>;
    /** Fetch balances only */
    getBalances(publicKey: string): Promise<SorokitResult<AssetBalance[]>>;
    /**
     * Fetch balances with optional filtering by asset code, issuer, type,
     * or zero-balance exclusion.
     */
    getAssetBalances(
      publicKey: string,
      filter?: AssetBalanceFilter,
    ): Promise<SorokitResult<AssetBalance[]>>;
    /**
     * Stream account state by polling Horizon.
     * Yields SorokitResult<AccountInfo> on every poll.
     */
    stream(
      publicKey: string,
      config?: AccountStreamConfig,
      signal?: AbortSignal,
    ): AsyncGenerator<SorokitResult<AccountInfo>>;
    /**
     * Shorten a public key for display: GABCD...WXYZ
     * Pure utility — returns string directly, cannot fail.
     */
    formatAddress(publicKey: string, chars?: number): string;
  };

  readonly transaction: {
    /** Build a payment transaction XDR (unsigned) */
    buildPayment(
      sourcePublicKey: string,
      params: PaymentParams,
    ): Promise<SorokitResult<string>>;
    /** Build a create account transaction XDR (unsigned) */
    buildCreateAccount(
      sourcePublicKey: string,
      params: AccountCreateParams,
    ): Promise<SorokitResult<string>>;
    /** Build a trustline transaction XDR (unsigned) */
    buildTrustline(
      sourcePublicKey: string,
      params: TrustlineParams,
    ): Promise<SorokitResult<string>>;
    /** Submit a signed transaction XDR */
    submit(signedXdr: string): Promise<SorokitResult<TransactionResult>>;
    /** Fetch the status of a transaction by hash */
    getStatus(hash: string): Promise<SorokitResult<TransactionResult>>;
    /**
     * Estimate the fee for a transaction.
     * Pass a pre-built XDR or payment params to build a sample transaction.
     */
    estimateFee(input: FeeEstimateInput): Promise<SorokitResult<FeeEstimate>>;
    /**
     * Stream transactions for an account by polling Horizon.
     * Yields SorokitResult<TransactionPage> on every poll.
     */
    stream(
      publicKey: string,
      config?: TransactionStreamConfig,
      signal?: AbortSignal,
    ): AsyncGenerator<SorokitResult<TransactionPage>>;
  };

  readonly soroban: {
    /**
     * Simulate any transaction XDR for fee estimation and pre-flight checks.
     * Uses the Soroban RPC.
     */
    simulate(
      transactionXdr: string,
    ): Promise<SorokitResult<SimulateTransactionResult>>;
    /**
     * Step 1 of the invoke pipeline.
     * Build + simulate + assemble a contract call. Returns assembled XDR.
     */
    prepare(
      params: ContractInvokeParams,
    ): Promise<SorokitResult<PreparedContractCall>>;
    /**
     * Step 3 of the invoke pipeline.
     * Submit a signed XDR and poll until confirmed. Returns tx hash.
     */
    execute(
      signedXdr: string,
      pollConfig?: SorobanPollConfig,
    ): Promise<SorokitResult<string>>;
    /**
     * Full invoke pipeline: prepare → sign → execute.
     * Use this for the common case. Use prepare/execute directly for
     * fine-grained control.
     */
    invoke(
      params: ContractInvokeParams,
      signFn: (xdr: string) => Promise<string>,
      pollConfig?: SorobanPollConfig,
    ): Promise<SorokitResult<string>>;
    /** Read contract data — no signing required */
    read(
      params: ContractReadParams,
    ): Promise<SorokitResult<ContractCallResult>>;
  };

  readonly network: {
    /** Return the resolved network config for this client instance */
    getConfig(): ResolvedNetworkConfig;
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a sorokit-core client instance.
 *
 * @example
 * ```ts
 * import { createSorokitClient, FreighterAdapter } from '@sorokit/core'
 *
 * const result = createSorokitClient({ network: 'testnet' })
 * if (result.status === 'error') throw new Error(result.error.message)
 *
 * const client = result.data
 * const adapter = new FreighterAdapter(swkInstance)
 *
 * const conn = await client.wallet.connect(adapter)
 * if (conn.status === 'error') throw new Error(conn.error.message)
 *
 * const account = await client.account.get(conn.data.publicKey!)
 * ```
 */
export function createSorokitClient(
  config: SorokitClientConfig,
): SorokitResult<SorokitClient> {
  const networkResult = resolveNetwork(config.network, {
    horizonUrl: config.horizonUrl,
    rpcUrl: config.rpcUrl,
  });

  if (networkResult.status === "error") return networkResult;

  const networkConfig = networkResult.data;
  const { horizonUrl, rpcUrl, networkPassphrase } = networkConfig;
  const logger = createLogger(config.debug ?? false, config.logger);
  const defaultPollConfig = config.sorobanPoll;
  const feeEstimateOptions: FeeEstimateOptions = {
    ...(config.cache !== undefined ? { cache: config.cache } : {}),
    ...(config.onFeeSurge !== undefined
      ? { onFeeSurge: config.onFeeSurge }
      : {}),
  };

  logger.debug("Client created", {
    network: config.network,
    horizonUrl,
    rpcUrl,
  });

  const client: SorokitClient = {
    networkConfig,

    wallet: {
      connect: (adapter) => {
        logger.debug("wallet.connect", { walletType: adapter.walletType });
        return connectWallet(adapter);
      },
      disconnect: (adapter) => {
        logger.debug("wallet.disconnect", { walletType: adapter.walletType });
        return disconnectWallet(adapter);
      },
      signTransaction: (adapter, input) => {
        logger.debug("wallet.signTransaction", {
          walletType: adapter.walletType,
        });
        return signTransaction(adapter, input);
      },
      emptyState: () => emptyWalletState(),
    },

    account: {
      get: (publicKey) => {
        logger.debug("account.get", { publicKey });
        return getAccount(horizonUrl, publicKey);
      },
      getBalances: (publicKey) => {
        logger.debug("account.getBalances", { publicKey });
        return getBalances(horizonUrl, publicKey);
      },
      getAssetBalances: (publicKey, filter) => {
        logger.debug("account.getAssetBalances", { publicKey, filter });
        return getAssetBalances(horizonUrl, publicKey, filter);
      },
      stream: (publicKey, config, signal) => {
        logger.debug("account.stream", { publicKey });
        return streamAccount(horizonUrl, publicKey, config, signal);
      },
      formatAddress: (publicKey, chars) => formatAddress(publicKey, chars),
    },

    transaction: {
      buildPayment: (sourcePublicKey, params) => {
        logger.debug("transaction.buildPayment", { sourcePublicKey });
        return buildPaymentTransaction(
          horizonUrl,
          networkConfig,
          sourcePublicKey,
          params,
        );
      },
      buildCreateAccount: (sourcePublicKey, params) => {
        logger.debug("transaction.buildCreateAccount", { sourcePublicKey });
        return buildCreateAccountTransaction(
          horizonUrl,
          networkConfig,
          sourcePublicKey,
          params,
        );
      },
      buildTrustline: (sourcePublicKey, params) => {
        logger.debug("transaction.buildTrustline", { sourcePublicKey });
        return buildTrustlineTransaction(
          horizonUrl,
          networkConfig,
          sourcePublicKey,
          params,
        );
      },
      submit: (signedXdr) => {
        logger.debug("transaction.submit");
        return submitTransaction(horizonUrl, networkPassphrase, signedXdr);
      },
      getStatus: (hash) => {
        logger.debug("transaction.getStatus", { hash });
        return getTransactionStatus(horizonUrl, hash);
      },
      estimateFee: (input) => {
        logger.debug("transaction.estimateFee");
        return estimateFee(
          rpcUrl,
          horizonUrl,
          networkConfig,
          input,
          feeEstimateOptions,
        );
      },
      stream: (publicKey, config, signal) => {
        logger.debug("transaction.stream", { publicKey });
        return streamTransactions(horizonUrl, publicKey, config, signal);
      },
    },

    soroban: {
      simulate: (transactionXdr) => {
        logger.debug("soroban.simulate");
        return simulateTransaction(rpcUrl, networkPassphrase, transactionXdr);
      },
      prepare: (params) => {
        logger.debug("soroban.prepare", {
          contractId: params.contractId,
          method: params.method,
        });
        return prepareContractCall(rpcUrl, networkConfig, horizonUrl, params);
      },
      execute: (signedXdr, pollConfig) => {
        logger.debug("soroban.execute");
        return executeContract(
          rpcUrl,
          networkConfig,
          signedXdr,
          pollConfig ?? defaultPollConfig,
        );
      },
      invoke: (params, signFn, pollConfig) => {
        logger.debug("soroban.invoke", {
          contractId: params.contractId,
          method: params.method,
        });
        return invokeContract(
          rpcUrl,
          networkConfig,
          horizonUrl,
          params,
          signFn,
          pollConfig ?? defaultPollConfig,
        );
      },
      read: (params) => {
        logger.debug("soroban.read", {
          contractId: params.contractId,
          method: params.method,
        });
        return readContract(rpcUrl, horizonUrl, networkConfig, params);
      },
    },

    network: {
      getConfig: () => networkConfig,
    },
  };

  return ok(client);
}
