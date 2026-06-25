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
import { getContractMethods } from "../soroban/contractMetadata";
import { createLogger, createTracedLogger, withLogging } from "../shared/logger";
import { formatAddress, generateTraceId } from "../shared/utils";
import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { LogLevel, SorokitLogger } from "../shared/logger";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ErrorHandler, ErrorContext } from "../shared/errors";
import { applyErrorHandler, withErrorHandling, applyCodeTransformer } from "../shared/errors";
import type { ErrorCodeTransformer } from "../shared/errors";
import { TokenBucketRateLimiter } from "../shared/utils";
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
  ContractMethod,
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
  /**
   * Minimum log level to emit. Default: "off"
   * Set to "debug" for verbose tracing of all SDK operations.
   */
  logLevel?: LogLevel;
  /**
   * Enable debug logging to console. Equivalent to `logLevel: "debug"`.
   * @deprecated Prefer `logLevel: "debug"`
   */
  debug?: boolean;
  /** Custom logger — overrides the built-in console logger */
  logger?: SorokitLogger;
  /** Default Soroban polling config — can be overridden per-call */
  sorobanPoll?: SorobanPollConfig;
  /** Invoked when estimateFee detects a fee surge (>2x recent median) */
  onFeeSurge?: FeeEstimateOptions["onFeeSurge"];
  /** Optional error handler for centralized error processing and recovery */
  errorHandler?: ErrorHandler;
  /** Trusted asset issuers whitelist — null means no whitelist (all issuers allowed) */
  trustedIssuers?: string[];
  /** Optional error code transformer — maps SDK error codes to consumer-specific strings before returning any error result */
  errorCodeTransformer?: ErrorCodeTransformer;
  /** Max transaction submissions per second — activates token bucket rate limiting on transaction.submit() */
  maxTxPerSecond?: number;
  /**
   * Correlation ID for this client. Included in every log entry and stamped onto
   * every error returned by client methods. Generated automatically when omitted.
   */
  traceId?: string;
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface SorokitClient {
  /** Resolved network configuration for this client instance */
  readonly networkConfig: ResolvedNetworkConfig;
  /** Trusted asset issuers whitelist — null means no whitelist (all issuers allowed) */
  readonly trustedIssuers: string[] | null;
  /** Correlation ID stamped onto every error and log entry from this client. */
  readonly traceId: string;

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
    /** Discover available contract methods and cache metadata by contract ID */
    getContractMethods(
      contractId: string,
      ttlMs?: number,
    ): Promise<SorokitResult<ContractMethod[]>>;
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
  const traceId = config.traceId ?? generateTraceId();
  const baseLogger =
    config.logger ??
    createLogger({
      logLevel: config.logLevel ?? (config.debug ? "debug" : "off"),
    });
  const logger = createTracedLogger(baseLogger, traceId);
  const defaultPollConfig = config.sorobanPoll;
  const errorHandler = config.errorHandler;
  const feeEstimateOptions: FeeEstimateOptions = {
    ...(config.cache !== undefined ? { cache: config.cache } : {}),
    ...(config.onFeeSurge !== undefined
      ? { onFeeSurge: config.onFeeSurge }
      : {}),
  };

  const applyTx = <T>(r: SorokitResult<T>): SorokitResult<T> =>
    applyCodeTransformer(r, config.errorCodeTransformer);

  const rateLimiter =
    config.maxTxPerSecond !== undefined
      ? new TokenBucketRateLimiter(config.maxTxPerSecond)
      : null;

  logger.info("client.create", {
    operation: "client.create",
    status: "ok",
    network: config.network,
    horizonUrl,
    rpcUrl,
  });

  const client: SorokitClient = {
    networkConfig,
    trustedIssuers: config.trustedIssuers ?? null,
    traceId,

    wallet: {
      connect: (adapter) =>
        withLogging(logger, "wallet.connect", { walletType: adapter.walletType }, () =>
          connectWallet(adapter),
        ).then(applyTx),
      disconnect: (adapter) =>
        withLogging(logger, "wallet.disconnect", { walletType: adapter.walletType }, () =>
          disconnectWallet(adapter),
        ).then(applyTx),
      signTransaction: (adapter, input) =>
        withLogging(
          logger,
          "wallet.signTransaction",
          { walletType: adapter.walletType },
          () => signTransaction(adapter, input),
        ).then(applyTx),
      emptyState: () => emptyWalletState(),
    },

    account: {
      get: (publicKey) =>
        withErrorHandling(
          errorHandler,
          { functionName: "account.get", params: { publicKey } },
          () =>
            withLogging(logger, "account.get", { publicKey }, () =>
              getAccount(horizonUrl, publicKey),
            ),
        ).then(applyTx),
      getBalances: (publicKey) =>
        withErrorHandling(
          errorHandler,
          { functionName: "account.getBalances", params: { publicKey } },
          () =>
            withLogging(logger, "account.getBalances", { publicKey }, () =>
              getBalances(horizonUrl, publicKey),
            ),
        ).then(applyTx),
      getAssetBalances: (publicKey, filter) =>
        withErrorHandling(
          errorHandler,
          { functionName: "account.getAssetBalances", params: { publicKey, filter } },
          () =>
            withLogging(logger, "account.getAssetBalances", { publicKey, filter }, () =>
              getAssetBalances(horizonUrl, publicKey, filter),
            ),
        ).then(applyTx),
      stream: (publicKey, streamConfig, signal) =>
        streamAccount(horizonUrl, publicKey, streamConfig, signal, logger),
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
          client.trustedIssuers,
        ).then(applyTx);
      },
      buildCreateAccount: (sourcePublicKey, params) => {
        logger.debug("transaction.buildCreateAccount", { sourcePublicKey });
        return buildCreateAccountTransaction(
          horizonUrl,
          networkConfig,
          sourcePublicKey,
          params,
        ).then(applyTx);
      },
      buildTrustline: (sourcePublicKey, params) => {
        logger.debug("transaction.buildTrustline", { sourcePublicKey });
        return buildTrustlineTransaction(
          horizonUrl,
          networkConfig,
          sourcePublicKey,
          params,
          client.trustedIssuers,
        ).then(applyTx);
      },
      submit: async (signedXdr) => {
        logger.debug("transaction.submit");
        if (rateLimiter) await rateLimiter.acquire();
        return submitTransaction(horizonUrl, networkPassphrase, signedXdr, config.cache).then(applyTx);
      },
      getStatus: (hash) => {
        logger.debug("transaction.getStatus", { hash });
        return getTransactionStatus(horizonUrl, hash).then(applyTx);
      },
      estimateFee: (input) => {
        logger.debug("transaction.estimateFee");
        return estimateFee(rpcUrl, horizonUrl, networkConfig, input, config.cache).then(applyTx);
      },
      stream: (publicKey, config, signal) => {
        logger.debug("transaction.stream", { publicKey });
        return streamTransactions(horizonUrl, publicKey, config, signal);
      },
    },

    soroban: {
      getContractMethods: (contractId, ttlMs) =>
        withLogging(
          logger,
          "soroban.getContractMethods",
          { contractId },
          () =>
            getContractMethods(rpcUrl, contractId, {
              ...(config.cache && { cache: config.cache }),
              ...(ttlMs !== undefined && { ttlMs }),
            }),
        ).then(applyTx),
      simulate: (transactionXdr) =>
        withErrorHandling(
          errorHandler,
          { functionName: "soroban.simulate" },
          () =>
            withLogging(logger, "soroban.simulate", undefined, () =>
              simulateTransaction(rpcUrl, networkPassphrase, transactionXdr),
            ),
        ).then(applyTx),
      prepare: (params) =>
        withErrorHandling(
          errorHandler,
          { functionName: "soroban.prepare", params: { contractId: params.contractId, method: params.method } },
          () =>
            withLogging(
              logger,
              "soroban.prepare",
              { contractId: params.contractId, method: params.method },
              () => prepareContractCall(rpcUrl, networkConfig, horizonUrl, params),
            ),
        ).then(applyTx),
      execute: (signedXdr, pollConfig) =>
        withErrorHandling(
          errorHandler,
          { functionName: "soroban.execute" },
          () =>
            executeContract(
              rpcUrl,
              networkConfig,
              signedXdr,
              pollConfig ?? defaultPollConfig,
              logger,
            ),
        ).then(applyTx),
      invoke: (params, signFn, pollConfig) =>
        withErrorHandling(
          errorHandler,
          { functionName: "soroban.invoke", params: { contractId: params.contractId, method: params.method } },
          () =>
            withLogging(
              logger,
              "soroban.invoke",
              { contractId: params.contractId, method: params.method },
              () =>
                invokeContract(
                  rpcUrl,
                  networkConfig,
                  horizonUrl,
                  params,
                  signFn,
                  pollConfig ?? defaultPollConfig,
                  logger,
                ),
            ),
        ).then(applyTx),
      read: (params) =>
        withErrorHandling(
          errorHandler,
          { functionName: "soroban.read", params: { contractId: params.contractId, method: params.method } },
          () =>
            withLogging(
              logger,
              "soroban.read",
              { contractId: params.contractId, method: params.method },
              () => readContract(rpcUrl, horizonUrl, networkConfig, params),
            ),
        ).then(applyTx),
    },

    network: {
      getConfig: () => networkConfig,
    },
  };

  return ok(client);
}
