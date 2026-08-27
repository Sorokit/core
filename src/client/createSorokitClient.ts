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
import { generateDeviceFingerprint, evaluateDeviceTrust, DEFAULT_TRUST_THRESHOLD } from "../wallet/deviceTrust";
import type { DeviceSignals, DeviceFingerprint, TrustHistoryEntry, TrustEvaluation } from "../wallet/deviceTrust";
import { createI18n } from "../shared/i18n";
import type { I18n, TranslationMap } from "../shared/i18n";
import { getAccount } from "../account/getAccount";
import { getAccountsBatch } from "../account/getAccountsBatch";
import { getBalances } from "../account/getBalances";
import { getAssetBalances } from "../account/getAssetBalances";
import { streamAccount } from "../account/streamAccount";
import { setSponsor, removeSponsor } from "../account/sponsorship";
import type { SponsorshipResult } from "../account/sponsorship";
import {
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
  buildAccountMerge,
} from "../transaction/buildTransaction";
import type { AccountMergeOptions } from "../transaction/buildTransaction";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";
import { estimateFee } from "../transaction/estimateFee";
import { streamTransactions } from "../transaction/streamTransactions";
import { exportTransactionHistory } from "../transaction/exportTransactionHistory";
import { queryTransactionHistory } from "../transaction/queryTransactionHistory";
import { validateDestination } from "../transaction/validateDestination";
import type {
  DestinationValidationResult,
  ValidateDestinationOptions,
} from "../transaction/validateDestination";
import { readContract } from "../soroban/readContract";
import { prepareContractCall } from "../soroban/prepareCall";
import { simulateTransaction } from "../soroban/simulateTransaction";
import {
  executeContract,
  validateSorobanPollConfig,
} from "../soroban/executeContract";
import { invokeContract } from "../soroban/invokeContract";
import { getContractMethods } from "../soroban/contractMetadata";
import { createContractStateTracker } from "../soroban/contractStateTracker";
import {
  createLogger,
  createTracedLogger,
  withLogging,
  sanitizeLogMeta,
} from "../shared/logger";
import {
  createTraceContext,
  createTracedFetch,
  getTraceContext,
} from "../shared/tracing";
import { setTracedFetch } from "../shared/serverFactory";
import type { TraceContext } from "../shared/tracing";
import {
  formatAddress,
  generateTraceId,
  isValidPublicKey,
  isValidContractId,
  TokenBucketRateLimiter,
} from "../shared/utils";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { LogLevel, SorokitLogger } from "../shared/logger";
import { wrapCache } from "../shared/cache";
import type { SorokitCache } from "../shared/cache";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { ErrorHandler, ErrorContext } from "../shared/errors";
import {
  applyErrorHandler,
  withErrorHandling,
  applyCodeTransformer,
} from "../shared/errors";
import type { ErrorCodeTransformer } from "../shared/errors";
import { SDK_VERSION } from "../shared/constants";
import {
  resolveOperationTimeout,
  type GlobalTimeoutOverride,
  type OperationType,
} from "../shared/config";
import {
  runWithTimeout,
  isOperationTimeoutError,
} from "../shared/timeout";
import type { NetworkType } from "../network/config";
import { checkNetworkHealth } from "../network";
import type { NetworkHealthReport } from "../network";
import type {
  WalletAdapter,
  WalletState,
  SignTransactionInput,
  PersistenceAdapter,
} from "../wallet/types";
import type { AccountInfo, AssetBalance } from "../account/types";
import type { AssetBalanceFilter } from "../account/getAssetBalances";
import type { AccountStreamConfig } from "../account/streamAccount";
import type {
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  TransactionResult,
  PathPaymentParams,
} from "../transaction/types";
import type {
  FeeEstimate,
  FeeEstimateInput,
  FeeEstimateOptions,
} from "../transaction/estimateFee";
import type {
  TransactionStreamConfig,
  TransactionPage,
} from "../transaction/streamTransactions";
import type { ExportTransactionHistoryOptions } from "../transaction/exportTransactionHistory";
import type {
  TransactionHistoryQuery,
  TransactionHistoryResult,
} from "../transaction/queryTransactionHistory";
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

export interface HealthCheckReport {
  /** Overall health status */
  status: "healthy" | "degraded" | "down";
  /** SDK version */
  version: string;
  /** Network type (testnet, mainnet, futurenet) */
  network: NetworkType;
  /** Network connectivity check */
  networkHealth: NetworkHealthReport;
  /** Timestamp of the health check */
  timestamp: string;
}

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
  /**
   * Prefix for built-in console log lines. Defaults to `"[sorokit]"`.
   * Use distinct values (e.g. `"[sorokit:testnet]"`) when running multiple clients.
   * Ignored when a custom `logger` is provided.
   */
  logPrefix?: string;
  /** Custom logger — overrides the built-in console logger */
  logger?: SorokitLogger;
  /**
   * Default Soroban polling config — can be overridden per-call.
   * Defaults to DEFAULT_POLL_MAX_ATTEMPTS (20) and DEFAULT_POLL_INTERVAL_MS (1500).
   */
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
  /**
   * Global timeout override for all operations in milliseconds.
   * Set to null to use per-operation defaults.
   * Can be overridden per-call via timeoutMs parameter.
   */
  timeoutMs?: GlobalTimeoutOverride;
  /**
   * Default timeout (ms) applied to every network-bound operation (#392).
   * Defaults to 30 seconds. Per-call `timeoutMs` arguments take precedence,
   * as does the global `timeoutMs` override above.
   */
  defaultTimeoutMs?: number;
  /** Locale used for SDK presentation messages; defaults to English. */
  locale?: string;
  /** Custom message translations keyed by locale and message key. */
  translations?: TranslationMap;
  /** Trust score below which wallet sessions require additional verification. */
  deviceTrustThreshold?: number;
  /**
   * Optional adapter for persisting wallet connection state across page
   * reloads.  When provided, the client automatically saves wallet state
   * after each successful connect/disconnect and attempts to restore it
   * on client creation.  Restored state is validated against the wallet
   * adapter — if validation fails, the client returns a disconnected
   * state instead of crashing.
   */
  persistenceAdapter?: PersistenceAdapter;
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface SorokitClient {
  /** SDK version string from package.json */
  readonly version: string;
  /** Resolved network configuration for this client instance */
  readonly networkConfig: ResolvedNetworkConfig;
  /** Trusted asset issuers whitelist — null means no whitelist (all issuers allowed) */
  readonly trustedIssuers: string[] | null;
  /** Correlation ID stamped onto every error and log entry from this client. */
  readonly traceId: string;
  /** Distributed trace context for this client instance (#212). */
  readonly traceContext: TraceContext;
  /** Presentation-layer translator; machine-readable error codes remain unchanged. */
  readonly i18n: I18n;
  /** Get the current trace context (null if none set). */
  readonly getTraceContext: () => TraceContext | null;

  /**
   * Check the health status of the client and its network connections.
   * Returns a simple health report with status, network connectivity, and version info.
   * Lightweight and dependency-free — suitable for monitoring endpoints.
   */
  healthCheck(): Promise<SorokitResult<HealthCheckReport>>;

  readonly wallet: {
    /** Connect and return WalletState */
    connect(
      adapter: WalletAdapter,
      timeoutMs?: number,
    ): Promise<SorokitResult<WalletState>>;
    /** Generate a privacy-conscious fingerprint for the current runtime. */
    fingerprintDevice(signals?: DeviceSignals): DeviceFingerprint;
    /** Evaluate a device against connection history and configured threshold. */
    evaluateTrust(
      fingerprint: DeviceFingerprint | string,
      history?: TrustHistoryEntry[],
    ): TrustEvaluation;
    /** Disconnect and return clean WalletState */
    disconnect(
      adapter: WalletAdapter,
      timeoutMs?: number,
    ): Promise<SorokitResult<WalletState>>;
    /** Sign a transaction XDR */
    signTransaction(
      adapter: WalletAdapter,
      input: SignTransactionInput,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /**
     * Return a canonical disconnected WalletState.
     * Pure utility — returns SorokitResult<WalletState>, cannot fail.
     */
    emptyState(): SorokitResult<WalletState>;
  };

  readonly account: {
    /** Fetch full account info including all balances */
    get(
      publicKey: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<AccountInfo>>;
    /** Fetch full account info for multiple accounts in parallel */
    getAccountsBatch(
      publicKeys: string[],
      timeoutMs?: number,
    ): Promise<SorokitResult<SorokitResult<AccountInfo>[]>>;
    /** Fetch balances only */
    getBalances(
      publicKey: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<AssetBalance[]>>;
    /**
     * Fetch balances with optional filtering by asset code, issuer, type,
     * or zero-balance exclusion.
     */
    getAssetBalances(
      publicKey: string,
      filter?: AssetBalanceFilter,
      timeoutMs?: number,
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
    /**
     * Check whether a string is a well-formed Stellar public key (G...).
     * Pure utility — returns boolean directly, cannot fail.
     */
    isValidPublicKey(key: string): boolean;
    /**
     * Check whether a string is a well-formed Stellar contract ID (C...).
     * Pure utility — returns boolean directly, cannot fail.
     */
    isValidContractId(id: string): boolean;
    /** Build operations to set a sponsor for an account */
    setSponsor(
      account: string,
      sponsor: string,
    ): SorokitResult<SponsorshipResult>;
    /** Build operations to remove sponsorship from an account */
    removeSponsor(account: string): SorokitResult<SponsorshipResult>;
  };

  readonly transaction: {
    /** Build a payment transaction XDR (unsigned) */
    buildPayment(
      sourcePublicKey: string,
      params: PaymentParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Build a create account transaction XDR (unsigned) */
    buildCreateAccount(
      sourcePublicKey: string,
      params: AccountCreateParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Build a trustline transaction XDR (unsigned) */
    buildTrustline(
      sourcePublicKey: string,
      params: TrustlineParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Build an account merge transaction XDR (unsigned) */
    buildAccountMerge(
      sourcePublicKey: string,
      destinationPublicKey: string,
      options?: AccountMergeOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Submit a signed transaction XDR */
    submit(
      signedXdr: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<TransactionResult>>;
    /** Fetch the status of a transaction by hash */
    getStatus(
      hash: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<TransactionResult>>;
    /**
     * Estimate the fee for a transaction.
     * Pass a pre-built XDR or payment params to build a sample transaction.
     */
    estimateFee(
      input: FeeEstimateInput,
      timeoutMs?: number,
    ): Promise<SorokitResult<FeeEstimate>>;
    /**
     * Stream transactions for an account by polling Horizon.
     * Yields SorokitResult<TransactionPage> on every poll.
     */
    stream(
      publicKey: string,
      config?: TransactionStreamConfig,
      signal?: AbortSignal,
    ): AsyncGenerator<SorokitResult<TransactionPage>>;
    /**
     * Validate a destination address before building a transaction.
     */
    validateDestination(
      publicKey: string,
      options?: Omit<ValidateDestinationOptions, "horizonUrl">,
      timeoutMs?: number,
    ): Promise<SorokitResult<DestinationValidationResult>>;
    /**
     * Query transaction history with filtering, sorting, and pagination.
     * Returns structured paginated data instead of a formatted string.
     */
    queryHistory(
      publicKey: string,
      query?: TransactionHistoryQuery,
      timeoutMs?: number,
    ): Promise<SorokitResult<TransactionHistoryResult>>;
    /**
     * Export transaction history for an account with optional date, type, asset, and amount filters.
     * Supports CSV (default) and JSON formats.
     */
    exportHistory(
      publicKey: string,
      options?: ExportTransactionHistoryOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Alias for exportHistory */
    exportTransactionHistory(
      publicKey: string,
      options?: ExportTransactionHistoryOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
  };

  readonly soroban: {
    /** Discover available contract methods and cache metadata by contract ID */
    getContractMethods(
      contractId: string,
      ttlMs?: number,
      timeoutMs?: number,
    ): Promise<SorokitResult<ContractMethod[]>>;
    /**
     * Simulate any transaction XDR for fee estimation and pre-flight checks.
     * Uses the Soroban RPC.
     */
    simulate(
      transactionXdr: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<SimulateTransactionResult>>;
    /**
     * Step 1 of the invoke pipeline.
     * Build + simulate + assemble a contract call. Returns assembled XDR.
     */
    prepare(
      params: ContractInvokeParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<PreparedContractCall>>;
    /**
     * Step 3 of the invoke pipeline.
     * Submit a signed XDR and poll until confirmed. Returns tx hash.
     */
    execute(
      signedXdr: string,
      pollConfig?: SorobanPollConfig,
      timeoutMs?: number,
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
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Read contract data — no signing required */
    read(
      params: ContractReadParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<ContractCallResult>>;
  };

  readonly network: {
    /** Return the resolved network config for this client instance */
    getConfig(): ResolvedNetworkConfig;
    /** Return the network type identifier string (e.g. "testnet", "mainnet", "futurenet") */
    getId(): NetworkType;
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function isValidUrlString(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate client configuration on startup (#137).
 * Checks required fields, types, URL formats, and optional interface implementations.
 */
export function validateClientConfig(
  config: SorokitClientConfig,
): SorokitResult<void> {
  if (!config || typeof config !== "object") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Configuration must be an object",
    );
  }

  const validNetworks = ["mainnet", "testnet", "futurenet"];
  if (!config.network || !validNetworks.includes(config.network)) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Invalid network type: ${String(config.network)}. Must be one of: mainnet, testnet, futurenet`,
    );
  }

  if (config.horizonUrl !== undefined) {
    if (
      typeof config.horizonUrl !== "string" ||
      !isValidUrlString(config.horizonUrl)
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid horizonUrl: ${String(config.horizonUrl)}`,
      );
    }
  }

  if (config.rpcUrl !== undefined) {
    if (typeof config.rpcUrl !== "string" || !isValidUrlString(config.rpcUrl)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid rpcUrl: ${String(config.rpcUrl)}`,
      );
    }
  }

  if (config.cache !== undefined && config.cache !== null) {
    const c = config.cache as any;
    if (
      typeof c !== "object" ||
      typeof c.get !== "function" ||
      typeof c.set !== "function" ||
      (typeof c.invalidate !== "function" && typeof c.delete !== "function")
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Cache interface must implement get, set, and invalidate/delete methods",
      );
    }
  }

  if (config.logger !== undefined && config.logger !== null) {
    const l = config.logger as any;
    if (
      typeof l !== "object" ||
      typeof l.debug !== "function" ||
      typeof l.info !== "function" ||
      typeof l.warn !== "function" ||
      typeof l.error !== "function"
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Logger interface must implement debug, info, warn, and error methods",
      );
    }
  }

  if (config.errorHandler !== undefined && config.errorHandler !== null) {
    if (typeof config.errorHandler !== "function") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "ErrorHandler must be a function",
      );
    }
  }

  if (
    config.errorCodeTransformer !== undefined &&
    config.errorCodeTransformer !== null
  ) {
    if (typeof config.errorCodeTransformer !== "function") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "ErrorCodeTransformer must be a function",
      );
    }
  }

  if (config.maxTxPerSecond !== undefined) {
    if (
      typeof config.maxTxPerSecond !== "number" ||
      isNaN(config.maxTxPerSecond) ||
      config.maxTxPerSecond <= 0
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "maxTxPerSecond must be a positive number",
      );
    }
  }

  if (config.logLevel !== undefined) {
    const validLogLevels = ["off", "debug", "info", "warn", "error"];
    if (!validLogLevels.includes(config.logLevel as string)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid logLevel: ${String(config.logLevel)}`,
      );
    }
  }

  if (config.trustedIssuers !== undefined && config.trustedIssuers !== null) {
    if (!Array.isArray(config.trustedIssuers)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "trustedIssuers must be an array of public keys",
      );
    }
  }

  if (config.sorobanPoll) {
    const pollErr = validateSorobanPollConfig(config.sorobanPoll);
    if (pollErr) return pollErr;
  }

  if (config.timeoutMs !== undefined && config.timeoutMs !== null) {
    if (
      typeof config.timeoutMs !== "number" ||
      isNaN(config.timeoutMs) ||
      config.timeoutMs < 0
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "timeoutMs must be a non-negative number",
      );
    }
  }

  if (config.deviceTrustThreshold !== undefined &&
      (typeof config.deviceTrustThreshold !== "number" ||
       !Number.isFinite(config.deviceTrustThreshold) ||
       config.deviceTrustThreshold < 0 || config.deviceTrustThreshold > 100)) {
    return err(SorokitErrorCode.INVALID_CONFIG, "deviceTrustThreshold must be a number between 0 and 100");
  }

  if (config.defaultTimeoutMs !== undefined) {
    if (
      typeof config.defaultTimeoutMs !== "number" ||
      isNaN(config.defaultTimeoutMs) ||
      config.defaultTimeoutMs < 0
    ) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "defaultTimeoutMs must be a non-negative number",
      );
    }
  }

  return ok(undefined);
}

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
  const validationResult = validateClientConfig(config);
  if (validationResult.status === "error") {
    return validationResult as SorokitResult<SorokitClient>;
  }

  const networkResult = resolveNetwork(config.network, {
    horizonUrl: config.horizonUrl,
    rpcUrl: config.rpcUrl,
  });

  if (networkResult.status === "error") return networkResult;

  const networkConfig = networkResult.data;
  const { horizonUrl, rpcUrl, networkPassphrase } = networkConfig;
  const traceId = config.traceId ?? generateTraceId();
  const i18n = createI18n({
    ...(config.locale !== undefined ? { locale: config.locale } : {}),
    ...(config.translations !== undefined ? { translations: config.translations } : {}),
  });
  const globalTimeout = config.timeoutMs;
  const baseLogger =
    config.logger ??
    createLogger({
      logLevel: config.logLevel ?? (config.debug ? "debug" : "off"),
      ...(config.logPrefix !== undefined ? { prefix: config.logPrefix } : {}),
    });
  const logger = createTracedLogger(baseLogger, { traceId });

  // Set up distributed tracing with correlation IDs (#212).
  const traceContext = createTraceContext(traceId);
  const tracedFetch = createTracedFetch(traceContext);

  const defaultPollConfig = config.sorobanPoll;
  const errorHandler = config.errorHandler;
  const cache = config.cache ? wrapCache(config.cache) : undefined;
  const contractStateTracker = cache
    ? createContractStateTracker(cache, horizonUrl, { fetch: tracedFetch })
    : undefined;
  const feeEstimateOptions: FeeEstimateOptions = {
    ...(cache !== undefined ? { cache } : {}),
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

  /**
   * Enforce the operation timeout window (#392).
   * Precedence: per-call timeoutMs > config.timeoutMs > config.defaultTimeoutMs
   * > per-operation default > 30 s. Timed-out requests are aborted where
   * supported (the signal is forwarded into Horizon/RPC fetch) and surface as
   * SorokitErrorCode.OPERATION_TIMEOUT — distinct from explicit cancellation.
   */
  const guard = <T>(
    opType: OperationType,
    perCallMs: number | undefined,
    run: (signal?: AbortSignal) => Promise<SorokitResult<T>>,
  ): Promise<SorokitResult<T>> =>
    runWithTimeout(
      resolveOperationTimeout(
        opType,
        perCallMs ?? null,
        config.defaultTimeoutMs ?? null,
        globalTimeout ?? null,
      ),
      run,
    ).catch((cause) => {
      if (!isOperationTimeoutError(cause)) throw cause;
      logger.warn("operation.timeout", {
        operation: opType,
        timeoutMs: cause.timeoutMs,
      });
      return err(
        SorokitErrorCode.OPERATION_TIMEOUT,
        cause.message,
        cause,
      ) as SorokitResult<T>;
    });

  logger.info(
    "client.create",
    sanitizeLogMeta({
      operation: "client.create",
      status: "ok",
      network: config.network,
      horizonUrl,
      rpcUrl,
    }),
  );

  // Client creation checks cache for recovered state
  if (cache) {
    const cachedVal = cache.get("wallet:state");
    logger.debug("client.create: checked cache for recovered wallet state", {
      hasCachedState: !!cachedVal,
    });
  }

  // Attempt to restore persisted wallet state from the persistence adapter
  const persistenceAdapter = config.persistenceAdapter;
  if (persistenceAdapter) {
    const persisted = persistenceAdapter.load("state");
    logger.debug("client.create: checked persistence adapter for wallet state", {
      hasPersistedState: !!persisted,
    });
  }

  const client: SorokitClient = {
    i18n,
    version: SDK_VERSION,
    networkConfig,
    trustedIssuers: config.trustedIssuers ?? null,
    traceId,
    traceContext,
    getTraceContext,

    healthCheck: async () => {
      const networkHealthResult = await checkNetworkHealth(horizonUrl, rpcUrl);
      const networkHealth =
        networkHealthResult.status === "ok"
          ? networkHealthResult.data
          : {
              status: "down" as const,
              horizon: {
                reachable: false,
                latencyMs: null,
                error: "Failed to check",
              },
              rpc: {
                reachable: false,
                latencyMs: null,
                error: "Failed to check",
              },
              issues: ["Health check failed"],
              recommendations: ["Check network configuration"],
            };

      const overallStatus = networkHealth.status;

      return ok({
        status: overallStatus,
        version: SDK_VERSION,
        network: config.network,
        networkHealth,
        timestamp: new Date().toISOString(),
      });
    },

    wallet: {
      fingerprintDevice: (signals) => generateDeviceFingerprint(signals),
      evaluateTrust: (fingerprint, history) => evaluateDeviceTrust(fingerprint, history, {
        threshold: config.deviceTrustThreshold ?? DEFAULT_TRUST_THRESHOLD,
      }),
      connect: (adapter, timeoutMs) => {
        const action = () => {
          // Try cache-based recovery first
          if (cache) {
            const cachedVal = cache.get("wallet:state");
            let cached: WalletState | null = null;
            if (cachedVal) {
              if (typeof cachedVal === "string") {
                try {
                  cached = JSON.parse(cachedVal);
                } catch {
                  // ignore
                }
              } else if (typeof cachedVal === "object") {
                cached = cachedVal as WalletState;
              }
            }

            if (
              cached &&
              cached.connected &&
              cached.walletType === adapter.walletType
            ) {
              if (adapter.isAvailable()) {
                logger.info("wallet.connect.recover", {
                  walletType: adapter.walletType,
                  status: "ok",
                });
                // Persist restored state via the persistence adapter
                if (persistenceAdapter) {
                  persistenceAdapter.save("state", cached);
                }
                return Promise.resolve(applyTx(ok(cached)));
              } else {
                logger.warn("wallet.connect.recover.validation_failed", {
                  walletType: adapter.walletType,
                });
                cache.invalidate("wallet:state");
                if (persistenceAdapter) {
                  persistenceAdapter.clear("state");
                }
                return Promise.resolve(
                  applyTx(
                    ok({
                      connected: false,
                      publicKey: null,
                      walletType: null,
                    }),
                  ),
                );
              }
            }
          }

          // Try persistence adapter recovery
          if (persistenceAdapter) {
            const persisted = persistenceAdapter.load("state");
            if (
              persisted &&
              persisted.connected &&
              persisted.walletType === adapter.walletType
            ) {
              if (adapter.isAvailable()) {
                logger.info("wallet.connect.recover.persistence", {
                  walletType: adapter.walletType,
                  status: "ok",
                });
                // Also hydrate the cache if available
                if (cache) {
                  cache.set("wallet:state", persisted);
                }
                return Promise.resolve(applyTx(ok(persisted)));
              } else {
                logger.warn("wallet.connect.recover.persistence.validation_failed", {
                  walletType: adapter.walletType,
                });
                persistenceAdapter.clear("state");
                return Promise.resolve(
                  applyTx(
                    ok({
                      connected: false,
                      publicKey: null,
                      walletType: null,
                    }),
                  ),
                );
              }
            }
          }

          return withLogging(
            logger,
            "wallet.connect",
            { walletType: adapter.walletType },
            () => connectWallet(adapter, cache),
          ).then((result) => {
            // Persist successful connection via the persistence adapter
            if (result.status === "ok" && persistenceAdapter) {
              persistenceAdapter.save("state", result.data);
            }
            return result;
          });
        };
        return guard("wallet_connect", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "wallet.connect",
              params: { walletType: adapter.walletType },
            },
            action,
          ).then(applyTx),
        );
      },
      disconnect: (adapter, timeoutMs) =>
        guard("wallet_disconnect", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "wallet.disconnect",
              params: { walletType: adapter.walletType },
            },
            () =>
              withLogging(
                logger,
                "wallet.disconnect",
                { walletType: adapter.walletType },
                () => disconnectWallet(adapter, cache),
              ).then((result) => {
                // Clear persisted state on successful disconnect
                if (result.status === "ok" && persistenceAdapter) {
                  persistenceAdapter.clear("state");
                }
                return result;
              }),
          ).then(applyTx),
        ),
      signTransaction: (adapter, input, timeoutMs) =>
        guard("wallet_sign", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "wallet.signTransaction",
              params: { walletType: adapter.walletType },
            },
            () =>
              withLogging(
                logger,
                "wallet.signTransaction",
                { walletType: adapter.walletType },
                () => signTransaction(adapter, input),
              ),
          ).then(applyTx),
        ),
      emptyState: () => emptyWalletState(),
    },

    account: {
      get: (publicKey, timeoutMs) =>
        guard("account_get", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "account.get", params: { publicKey } },
            () =>
              withLogging(logger, "account.get", { publicKey }, async () => {
                const cacheKey = `account:get:${horizonUrl}:${publicKey}`;
                if (cache) {
                  const cachedVal = cache.get(cacheKey);
                  if (cachedVal) return ok(cachedVal as AccountInfo);
                }
                const res = await getAccount(horizonUrl, publicKey, { signal });
                if (cache && res.status === "ok") cache.set(cacheKey, res.data);
                return res;
              }),
          ).then(applyTx),
        ),
      getAccountsBatch: (publicKeys, timeoutMs) =>
        guard("account_get_batch", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "account.getAccountsBatch", params: { publicKeys } },
            () =>
              withLogging(
                logger,
                "account.getAccountsBatch",
                { publicKeys },
                () => getAccountsBatch(horizonUrl, publicKeys, { signal, ...(cache && { cache }) }),
              ),
          ).then(applyTx),
        ),
      getBalances: (publicKey, timeoutMs) =>
        guard("account_get_balances", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "account.getBalances", params: { publicKey } },
            () =>
              withLogging(
                logger,
                "account.getBalances",
                { publicKey },
                async () => {
                  const cacheKey = `account:balances:${horizonUrl}:${publicKey}`;
                  if (cache) {
                    const cachedVal = cache.get(cacheKey);
                    if (cachedVal) return ok(cachedVal as AssetBalance[]);
                  }
                  const res = await getBalances(horizonUrl, publicKey, { signal });
                  if (cache && res.status === "ok") cache.set(cacheKey, res.data);
                  return res;
                },
              ),
          ).then(applyTx),
        ),
      getAssetBalances: (publicKey, filter, timeoutMs) =>
        guard("account_get_balances", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "account.getAssetBalances",
              params: { publicKey, filter },
            },
            () =>
              withLogging(
                logger,
                "account.getAssetBalances",
                { publicKey, filter },
                async () => {
                  const cacheKey = `account:assetBalances:${horizonUrl}:${publicKey}:${JSON.stringify(filter ?? {})}`;
                  if (cache) {
                    const cachedVal = cache.get(cacheKey);
                    if (cachedVal) return ok(cachedVal as AssetBalance[]);
                  }
                  const res = await getAssetBalances(
                    horizonUrl,
                    publicKey,
                    filter,
                    undefined,
                    { signal },
                  );
                  if (cache && res.status === "ok") cache.set(cacheKey, res.data);
                  return res;
                },
              ),
          ).then(applyTx),
        ),
      stream: (publicKey, streamConfig, signal) =>
        streamAccount(horizonUrl, publicKey, streamConfig, signal, logger),
      formatAddress: (publicKey, chars) => formatAddress(publicKey, chars),
      isValidPublicKey: (key) => isValidPublicKey(key),
      isValidContractId: (id) => isValidContractId(id),
      setSponsor: (account, sponsor) => applyTx(setSponsor(account, sponsor)),
      removeSponsor: (account) => applyTx(removeSponsor(account)),
    },

    transaction: {
      buildPayment: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildPayment",
              params: { sourcePublicKey, ...params },
            },
            () => {
              logger.debug("transaction.buildPayment", { sourcePublicKey });
              return buildPaymentTransaction(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
                client.trustedIssuers,
              );
            },
          ).then(applyTx),
        ),
      buildCreateAccount: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildCreateAccount",
              params: { sourcePublicKey, ...params },
            },
            () => {
              logger.debug("transaction.buildCreateAccount", { sourcePublicKey });
              return buildCreateAccountTransaction(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
              );
            },
          ).then(applyTx),
        ),
      buildTrustline: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildTrustline",
              params: { sourcePublicKey, ...params },
            },
            () => {
              logger.debug("transaction.buildTrustline", { sourcePublicKey });
              return buildTrustlineTransaction(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
                client.trustedIssuers,
              );
            },
          ).then(applyTx),
        ),
      buildAccountMerge: (
        sourcePublicKey,
        destinationPublicKey,
        options,
        timeoutMs,
      ) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildAccountMerge",
              params: { sourcePublicKey, destinationPublicKey, options },
            },
            () => {
              logger.debug("transaction.buildAccountMerge", {
                sourcePublicKey,
                destinationPublicKey,
              });
              return buildAccountMerge(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                destinationPublicKey,
                options,
              );
            },
          ).then(applyTx),
        ),
      submit: async (signedXdr, timeoutMs) =>
        guard("tx_submit", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "transaction.submit" },
            async () => {
              logger.debug("transaction.submit");
              if (rateLimiter) await rateLimiter.acquire();
              return submitTransaction(
                horizonUrl,
                networkPassphrase,
                signedXdr,
                cache,
                { signal },
              );
            },
          ).then(applyTx),
        ),
      getStatus: (hash, timeoutMs) =>
        guard("tx_status", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "transaction.getStatus", params: { hash } },
            () => {
              logger.debug("transaction.getStatus", { hash });
              return getTransactionStatus(horizonUrl, hash, cache, { signal });
            },
          ).then(applyTx),
        ),
      estimateFee: (input, timeoutMs) =>
        guard("tx_estimate_fee", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            { functionName: "transaction.estimateFee", params: { ...input } },
            () => {
              logger.debug("transaction.estimateFee");
              return estimateFee(
                rpcUrl,
                horizonUrl,
                networkConfig,
                input,
                cache,
                undefined,
                feeEstimateOptions,
              );
            },
          ).then(applyTx),
        ),
      stream: (publicKey, config, signal) => {
        logger.debug("transaction.stream", { publicKey });
        return streamTransactions(horizonUrl, publicKey, config, signal);
      },
      validateDestination: (publicKey, options, timeoutMs) =>
        guard("tx_validate_destination", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.validateDestination",
              params: { publicKey, options },
            },
            () => {
              logger.debug("transaction.validateDestination", { publicKey });
              return validateDestination(publicKey, {
                ...options,
                horizonUrl: horizonUrl,
              });
            },
          ).then(applyTx),
        ),
      queryHistory: (publicKey, query, timeoutMs) =>
        guard("tx_query_history", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.queryHistory",
              params: { publicKey, query },
            },
            () => {
              logger.debug("transaction.queryHistory", { publicKey });
              return queryTransactionHistory(horizonUrl, publicKey, {
                ...query,
                networkPassphrase: query?.networkPassphrase ?? networkPassphrase,
              });
            },
          ).then(applyTx),
        ),
      exportHistory: (publicKey, options, timeoutMs) =>
        guard("tx_export_history", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.exportHistory",
              params: { publicKey, options },
            },
            () => {
              logger.debug("transaction.exportHistory", { publicKey });
              return exportTransactionHistory(horizonUrl, publicKey, {
                ...options,
                networkPassphrase:
                  options?.networkPassphrase ?? networkPassphrase,
              });
            },
          ).then(applyTx),
        ),
      exportTransactionHistory: (publicKey, options, timeoutMs) =>
        guard("tx_export_history", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.exportTransactionHistory",
              params: { publicKey, options },
            },
            () => {
              logger.debug("transaction.exportTransactionHistory", { publicKey });
              return exportTransactionHistory(horizonUrl, publicKey, {
                ...options,
                networkPassphrase:
                  options?.networkPassphrase ?? networkPassphrase,
              });
            },
          ).then(applyTx),
        ),
    },

    soroban: {
      getContractMethods: (contractId, ttlMs, timeoutMs) =>
        guard("soroban_get_methods", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.getContractMethods",
              params: { contractId },
            },
            () =>
              withLogging(
                logger,
                "soroban.getContractMethods",
                { contractId },
                () =>
                  getContractMethods(rpcUrl, contractId, {
                    ...(cache && { cache }),
                    ...(ttlMs !== undefined && { ttlMs }),
                  }),
              ),
          ).then(applyTx),
        ),
      simulate: (transactionXdr, timeoutMs) =>
        guard("soroban_simulate", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            { functionName: "soroban.simulate" },
            () =>
              withLogging(logger, "soroban.simulate", {}, () =>
                simulateTransaction(rpcUrl, networkPassphrase, transactionXdr),
              ),
          ).then(applyTx),
        ),
      prepare: (params, timeoutMs) =>
        guard("soroban_prepare", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.prepare",
              params: { contractId: params.contractId, method: params.method },
            },
            () =>
              withLogging(
                logger,
                "soroban.prepare",
                { contractId: params.contractId, method: params.method },
                () =>
                  prepareContractCall(rpcUrl, networkConfig, horizonUrl, params),
              ),
          ).then(applyTx),
        ),
      execute: (signedXdr, pollConfig, timeoutMs) =>
        guard("soroban_execute", timeoutMs, () =>
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
                contractStateTracker,
              ),
          ).then(applyTx),
        ),
      invoke: (params, signFn, pollConfig, timeoutMs) =>
        guard("soroban_invoke", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.invoke",
              params: { contractId: params.contractId, method: params.method },
            },
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
                    {
                      ...params,
                      ...(params.stateTracker === undefined &&
                      contractStateTracker !== undefined
                        ? { stateTracker: contractStateTracker }
                        : {}),
                    },
                    signFn,
                    pollConfig ?? defaultPollConfig,
                    logger,
                  ),
              ),
          ).then(applyTx),
        ),
      read: (params, timeoutMs) =>
        guard("soroban_read", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.read",
              params: { contractId: params.contractId, method: params.method },
            },
            () =>
              withLogging(
                logger,
                "soroban.read",
                { contractId: params.contractId, method: params.method },
                () =>
                  readContract(rpcUrl, horizonUrl, networkConfig, {
                    ...params,
                    ...(params.stateTracker === undefined &&
                    contractStateTracker !== undefined
                      ? { stateTracker: contractStateTracker }
                      : {}),
                  }),
              ),
          ).then(applyTx),
        ),
    },

    network: {
      getConfig: () => networkConfig,
      getId: () => config.network,
    },
  };

  return ok(client);
}
