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
import {
  generateDeviceFingerprint,
  evaluateDeviceTrust,
  DEFAULT_TRUST_THRESHOLD,
} from "../wallet/deviceTrust";
import type {
  DeviceSignals,
  DeviceFingerprint,
  TrustHistoryEntry,
  TrustEvaluation,
} from "../wallet/deviceTrust";
import {
  createAccountManager,
  WalletAccountManager,
} from "../wallet/accountManager";
import type {
  AccountData,
  AccountMetadata,
  AccountSwitchListener,
  AccountSwitchUnsubscribe,
  AccountStorageAdapter,
} from "../wallet/accountManager";
import {
  createWalletEventEmitter,
  toConnectedEvent,
} from "../wallet/eventEmitter";
import {
  saveSession,
  restoreSession,
  clearSession,
  isSessionValid,
} from "../wallet/sessionPersistence";
import type {
  SessionData,
  WalletConnection,
  SessionPersistenceOptions,
} from "../wallet/sessionPersistence";
import type {
  WalletEventName,
  WalletEventListener,
  WalletEventUnsubscribe,
} from "../wallet/eventEmitter";
import { createI18n } from "../shared/i18n";
import type { I18n, TranslationMap } from "../shared/i18n";
import { getAccount } from "../account/getAccount";
import { getAccountsBatch } from "../account/getAccountsBatch";
import { getBalances } from "../account/getBalances";
import { getAssetBalances } from "../account/getAssetBalances";
import { getOffers, getTrades } from "../account/dexActivity";
import type {
  DexActivityOptions,
  DexActivityResult,
  OfferInfo,
  TradeInfo,
} from "../account/dexActivity";
import { streamAccount } from "../account/streamAccount";
import { setSponsor, removeSponsor } from "../account/sponsorship";
import {
  getSigners,
  getThresholds,
  analyzeSigningRequirement,
} from "../account/signers";
import { calculateHealthScore } from "../account/healthScore";
import type { HealthData } from "../account/healthScore";
import {
  addRecoverySigner,
  getRecoveryPlan,
  removeOldSigner,
  rotateKeys,
} from "../account/recoveryHelper";
import type { RecoveryPlan } from "../account/recoveryHelper";
import { getPaymentHistory } from "../account/paymentHistory";
import { getEffects } from "../account/getEffects";
import { getDataEntries } from "../account/dataEntries";
import { simulateAccountMerge } from "../account/mergeSafety";
import type {
  AccountMergeSimulation,
  SimulateAccountMergeOptions,
} from "../account/mergeSafety";
import type { SponsorshipResult } from "../account/sponsorship";
import {
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
  buildAccountMerge,
} from "../transaction/buildTransaction";
import type { AccountMergeOptions } from "../transaction/buildTransaction";
import {
  buildCreateClaimableBalance,
  buildClaimClaimableBalance,
} from "../transaction/claimableBalance";
import { buildBumpSequenceTransaction } from "../transaction/bumpSequence";
import {
  buildSetDataEntryTransaction,
  buildDeleteDataEntryTransaction,
} from "../transaction/dataEntry";
import { compose } from "../transaction/compose";
import type { ComposeOptions } from "../transaction/compose";
import { orchestrate } from "../transaction/atomicOrchestrator";
import type { AtomicOrchestratorOptions } from "../transaction/atomicOrchestrator";
import {
  aggregateEvents as aggregateContractEvents,
  filterEvents as filterContractEvents,
  streamEvents as streamContractEvents,
} from "../soroban/eventAnalytics";
import type {
  ContractEventAnalyticsFilter,
  EventAggregate,
  EventGroupBy,
} from "../soroban/eventAnalytics";
import { decodeContractResult as decodeSorobanResult } from "../soroban/resultDecoder";
import type {
  ContractResultInput,
  ContractResultSchema,
  DecodedContractResult,
} from "../soroban/resultDecoder";
import {
  getContractState as readContractState,
  getContractStateAt as readContractStateAt,
  getStateChanges as compareContractState,
  watchContractState as streamContractState,
} from "../soroban/stateHistory";
import type {
  ContractStateSource,
  WatchContractStateOptions,
} from "../soroban/stateHistory";
import type {
  ContractStateComparison,
  ContractStateSnapshotRecord,
} from "../soroban/contractStateHistory";
import { createContractStateHistory } from "../soroban/contractStateHistory";
import type { StreamContractEventsRealTimeOptions } from "../soroban/streamContractEventsRealTime";
import { submitTransaction } from "../transaction/submitTransaction";
import { getTransactionStatus } from "../transaction/status";
import { previewTransaction } from "../transaction/simulationPreview";
import type { TransactionPreview } from "../transaction/simulationPreview";
import { estimateFee } from "../transaction/estimateFee";
import { streamTransactions } from "../transaction/streamTransactions";
import { exportTransactionHistory } from "../transaction/exportTransactionHistory";
import { queryTransactionHistory } from "../transaction/queryTransactionHistory";
import { validateDestination } from "../transaction/validateDestination";
import { buildSetOptionsTransaction } from "../transaction/setOptions";
import type {
  DestinationValidationResult,
  ValidateDestinationOptions,
} from "../transaction/validateDestination";
import type { UpgradeEvent } from "../soroban/upgradeDetection";
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
import {
  configureEndpointFailover,
  validateEndpointList,
} from "../network/endpointFailover";
import { createEndpointRegistry } from "../network/endpointRegistry";
import type { TraceContext } from "../shared/tracing";
import { createDID } from "../integration/didSupport";
import type { DIDData } from "../integration/didSupport";
import type {
  GovernanceCallOptions,
  GovernanceNetwork,
  GovernanceProposal,
  ProposalId,
  ProposalStatus,
  ProposalTracker,
  TrackProposalOptions,
  VoteChoice,
  VoteReceipt,
  VotingPower,
} from "../integration/governance";
import { createAuditTrail } from "../compliance/auditTrail";
import type { AuditTrail } from "../compliance/auditTrail";
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
import type { MainnetSafetyOptions } from "../shared/mainnetSafety";
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
import { runWithTimeout, isOperationTimeoutError } from "../shared/timeout";
import type { NetworkType } from "../network/config";
import { checkNetworkHealth } from "../network";
import { createRequestDeduplicator } from "../network/requestDedup";
import type { DedupConfig } from "../network/requestDedup";
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
  CreateClaimableBalanceParams,
  ClaimClaimableBalanceParams,
  BumpSequenceParams,
  SetOptionsParams,
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
import type { ContractEvent } from "../soroban/subscribeContractEvents";
import type {
  AnchorAsset,
  AnchorRequestOptions,
  Sep10AuthOptions,
  Sep24InteractiveResult,
} from "../integration/anchors";
import type {
  AuthToken,
  InitiateSep10AuthOptions,
} from "../integration/sep10Auth";
import type {
  FetchStellarTomlOptions,
  StellarToml,
} from "../integration/sep1Toml";
import type {
  FederationResolverOptions,
  ResolvedAddress,
} from "../integration/federationResolver";
import type {
  DerivedStellarKey,
  RotateSecretKeyOptions,
} from "../shared/keyManagement";
import type { Transaction } from "@stellar/stellar-sdk";

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
  /** Ordered Horizon endpoints: primary first, followed by backup endpoints. */
  horizonEndpoints?: string[];
  /** Ordered Soroban RPC endpoints: primary first, followed by backup endpoints. */
  rpcEndpoints?: string[];
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
  /** Request deduplication config for concurrent reads */
  dedupe?: DedupConfig;
  /** Optional custom storage adapter for multi-account management */
  accountStorageAdapter?: AccountStorageAdapter;
  /** Custom WalletAccountManager instance */
  accountManager?: WalletAccountManager;
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

  /** SEP-2 federation lookup and SEP-6/10/24 anchor APIs, loaded on first use. */
  readonly integration: {
    resolveFederatedAddress(
      address: string,
      options?: FederationResolverOptions,
    ): Promise<SorokitResult<ResolvedAddress>>;
    fetchStellarToml(
      domain: string,
      options?: FetchStellarTomlOptions,
    ): Promise<SorokitResult<StellarToml>>;
    clearStellarTomlCache(domain?: string): Promise<void>;
    authenticateSep10(
      anchorUrl: string,
      options: Sep10AuthOptions,
    ): Promise<SorokitResult<string>>;
    initiateSep10Auth(
      serverUrl: string,
      publicKey: string,
      options?: InitiateSep10AuthOptions,
    ): Promise<SorokitResult<string>>;
    completeSep10Auth(
      challengeXdr: string,
      signedChallengeXdr: string,
      options?: { now?: number; timeoutMs?: number },
    ): Promise<SorokitResult<AuthToken>>;
    validateSep10Token(
      token: string,
      now?: number,
    ): Promise<SorokitResult<AuthToken>>;
    initiateSep6Transfer(
      anchorUrl: string,
      asset: AnchorAsset,
      options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" },
    ): Promise<SorokitResult<Record<string, unknown>>>;
    initiateSep24Interactive(
      anchorUrl: string,
      asset: AnchorAsset,
      options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" },
    ): Promise<SorokitResult<Sep24InteractiveResult>>;
    getSep6TransactionStatus(
      anchorUrl: string,
      id: string,
      options?: AnchorRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    initiateDeposit(
      serverUrl: string,
      asset: import("../integration/sep6Flow").Sep6FlowAsset,
      options?: import("../integration/sep6Flow").Sep6FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    initiateWithdraw(
      serverUrl: string,
      asset: import("../integration/sep6Flow").Sep6FlowAsset,
      options?: import("../integration/sep6Flow").Sep6FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    trackTransaction(
      serverUrl: string,
      txId: string,
      options?: import("../integration/sep6Flow").Sep6FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    getKycFields(
      serverUrl: string,
      account: string,
      options?: import("../integration/sep12Kyc").KycRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    submitKycInfo(
      serverUrl: string,
      account: string,
      info: import("../integration/sep12Kyc").KycSubmissionInfo,
      options?: import("../integration/sep12Kyc").KycRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    getKycStatus(
      serverUrl: string,
      account: string,
      options?: import("../integration/sep12Kyc").KycRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    initiateInteractiveDeposit(
      serverUrl: string,
      asset: import("../integration/sep24Flow").Sep24FlowAsset,
      options?: import("../integration/sep24Flow").Sep24FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    initiateInteractiveWithdraw(
      serverUrl: string,
      asset: import("../integration/sep24Flow").Sep24FlowAsset,
      options?: import("../integration/sep24Flow").Sep24FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    monitorTransaction(
      serverUrl: string,
      txId: string,
      options?: import("../integration/sep24Flow").Sep24FlowRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    quoteDirectPayment(
      serverUrl: string,
      sendingAsset: import("../integration/sep31DirectPayment").DirectPaymentAsset,
      receiver:
        | string
        | import("../integration/sep31DirectPayment").DirectPaymentReceiver,
      options?: import("../integration/sep31DirectPayment").DirectPaymentQuoteRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    sendDirectPayment(
      serverUrl: string,
      amount: string,
      receiver:
        | string
        | import("../integration/sep31DirectPayment").DirectPaymentReceiver,
      options?: import("../integration/sep31DirectPayment").DirectPaymentQuoteRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    trackDirectPayment(
      serverUrl: string,
      txId: string,
      options?: import("../integration/sep31DirectPayment").DirectPaymentQuoteRequestOptions,
    ): Promise<SorokitResult<Record<string, unknown>>>;
    createDID(publicKey: string): SorokitResult<DIDData>;
    resolveDID(did: string): Promise<SorokitResult<DIDData>>;
    linkAccountToDID(
      publicKey: string,
      did: string,
    ): Promise<SorokitResult<DIDData>>;
    verifyDIDOwnership(
      did: string,
      publicKey: string,
      proof: import("../integration/didSupport").DIDOwnershipProof,
    ): Promise<
      SorokitResult<
        import("../integration/didSupport").VerifyDIDOwnershipResult
      >
    >;
    /** #686: governance — active proposals on `network` (defaults to the client's network). */
    getProposals(
      network?: GovernanceNetwork,
      options?: GovernanceCallOptions & { status?: ProposalStatus | "all" },
    ): Promise<SorokitResult<GovernanceProposal[]>>;
    voteOnProposal(
      proposalId: ProposalId,
      vote: VoteChoice | string,
      options?: GovernanceCallOptions & { voter?: string },
    ): Promise<SorokitResult<VoteReceipt>>;
    getVotingPower(
      publicKey: string,
      options?: GovernanceCallOptions,
    ): Promise<SorokitResult<VotingPower>>;
    trackProposal(
      proposalId: ProposalId,
      options?: TrackProposalOptions,
    ): Promise<SorokitResult<ProposalTracker>>;
  };

  /** Key derivation and signer rotation utilities, loaded on first use. */
  readonly shared: {
    deriveKey(
      mnemonic: string,
      path?: string,
      passphrase?: string,
    ): Promise<SorokitResult<DerivedStellarKey>>;
    validateSecretKey(
      secretKey: string,
    ): Promise<SorokitResult<{ publicKey: string }>>;
    rotateSecretKey(
      options: RotateSecretKeyOptions,
    ): Promise<SorokitResult<Transaction>>;
  };

  /** Append-only operation auditing and compliance reports for this client. */
  readonly compliance: AuditTrail;

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
      optionsOrTimeoutMs?:
        | number
        | import("../wallet/types").WalletConnectOptions,
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
    /** Register an account with optional metadata (#579) */
    addAccount(
      publicKey: string,
      metadata?: AccountMetadata,
    ): Promise<SorokitResult<AccountData>>;
    /** Unregister an account by public key (#579) */
    removeAccount(publicKey: string): Promise<SorokitResult<boolean>>;
    /** Switch active account to specified public key (#579) */
    switchAccount(publicKey: string): Promise<SorokitResult<AccountData>>;
    /** Get currently active account record (#579) */
    getActiveAccount(): SorokitResult<AccountData | null>;
    /** List all registered accounts (#579) */
    listAccounts(): Promise<SorokitResult<AccountData[]>>;
    /** Subscribe to real-time active account switches (#579) */
    watchAccountSwitch(
      listener: AccountSwitchListener,
    ): AccountSwitchUnsubscribe;
    /**
     * Named wallet lifecycle event subscriptions (#613): "connected",
     * "disconnected", "accountChanged", "networkChanged".
     *
     * "networkChanged" is never emitted by any bundled WalletAdapter today —
     * no adapter currently detects the connected wallet switching networks.
     * It exists for a custom adapter to report via a WalletEventEmitter it
     * holds a reference to, and will start firing once one does.
     */
    on<E extends WalletEventName>(
      event: E,
      listener: WalletEventListener<E>,
    ): WalletEventUnsubscribe;
    /** Remove a previously registered wallet event listener (#613) */
    off<E extends WalletEventName>(
      event: E,
      listener: WalletEventListener<E>,
    ): void;
    /** Persist wallet connection session to local storage with encryption and TTL (#671) */
    saveSession(
      connection: WalletConnection,
      options?: SessionPersistenceOptions,
    ): Promise<SorokitResult<SessionData>>;
    /** Restore persisted wallet session from local storage with auto-recovery (#671) */
    restoreSession(
      options?: SessionPersistenceOptions,
    ): Promise<SorokitResult<SessionData>>;
    /** Clear persisted wallet session (logout) (#671) */
    clearSession(
      options?: Pick<SessionPersistenceOptions, "storage" | "storageKey">,
    ): SorokitResult<void>;
    /** Check whether a session is valid and not expired (#671) */
    isSessionValid(session: SessionData | null | undefined): boolean;
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
    /** Assess signer security, recovery coverage, and native-balance reserve health. */
    calculateHealthScore(publicKey: string): Promise<SorokitResult<HealthData>>;
    /** Return a safe, staged signer recovery plan. */
    getRecoveryPlan(publicKey: string): Promise<SorokitResult<RecoveryPlan>>;
    /** Build an unsigned transaction that adds a lower-weight backup signer. */
    addRecoverySigner(
      account: string,
      recoveryKey: string,
      recoveryWeight?: number,
    ): Promise<SorokitResult<string>>;
    /** Build an unsigned transaction that installs a replacement signer and disables master weight. */
    rotateKeys(
      account: string,
      newKey: string,
      newKeyWeight?: number,
    ): Promise<SorokitResult<string>>;
    /** Build an unsigned transaction to remove a signer after the recovery delay. */
    removeOldSigner(
      account: string,
      oldKey: string,
      rotatedAt: number | string | Date,
      options?: { waitMs?: number; now?: number },
    ): Promise<SorokitResult<string>>;
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
    getOffers(
      publicKey: string,
      options?: DexActivityOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<DexActivityResult<OfferInfo>>>;
    getTrades(
      publicKey: string,
      options?: DexActivityOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<DexActivityResult<TradeInfo>>>;
    /**
     * Simulate an account merge and run all safety checks before any transaction
     * is built or signed. Account merge is destructive and irreversible — use this
     * to validate the operation before calling `transaction.buildAccountMerge`.
     *
     * Checks: address validity, destination exists, no open trustlines (unless
     * `allowTrustlines` is set), minimum balance met.
     */
    simulateAccountMerge(
      sourcePublicKey: string,
      destinationPublicKey: string,
      options?: SimulateAccountMergeOptions,
      timeoutMs?: number,
    ): Promise<SorokitResult<AccountMergeSimulation>>;
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
    /** Build a create claimable balance transaction XDR (unsigned) (#543) */
    buildCreateClaimableBalance(
      sourcePublicKey: string,
      params: CreateClaimableBalanceParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Build a claim claimable balance transaction XDR (unsigned) (#543) */
    buildClaimClaimableBalance(
      sourcePublicKey: string,
      params: ClaimClaimableBalanceParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /** Build a bump sequence transaction XDR (unsigned) (#554) */
    buildBumpSequence(
      sourcePublicKey: string,
      params: BumpSequenceParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    buildSetOptions(
      sourcePublicKey: string,
      params: SetOptionsParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<string>>;
    /**
     * Start a fluent multi-operation transaction builder bound to this client's
     * network config. Call `.build()` on the returned builder for the XDR (#542).
     */
    compose(
      sourcePublicKey: string,
      options?: ComposeOptions,
    ): ReturnType<typeof compose>;
    /** Create a sequential multi-step orchestration with compensating rollback. */
    orchestrate(
      options?: AtomicOrchestratorOptions,
    ): ReturnType<typeof orchestrate>;
    /** Submit a signed transaction XDR */
    submit(
      signedXdr: string,
      options?: number | (MainnetSafetyOptions & { timeoutMs?: number }),
    ): Promise<SorokitResult<TransactionResult>>;
    /** Alias for submit; accepts the same Mainnet safety options. */
    submitTransaction(
      signedXdr: string,
      options?: number | (MainnetSafetyOptions & { timeoutMs?: number }),
    ): Promise<SorokitResult<TransactionResult>>;
    /**
     * Preview a transaction's effects before submitting it: projected balance
     * changes, fee, and other state changes (e.g. new trustlines) (#612).
     *
     * `sourcePublicKey` is accepted for API-ergonomics parity with the rest
     * of the transaction namespace, but the transaction's own encoded source
     * account is what determines its effects — the two must match the
     * transaction being previewed.
     */
    previewTransaction(
      transactionXdr: string,
      sourcePublicKey: string,
      timeoutMs?: number,
    ): Promise<SorokitResult<TransactionPreview>>;
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
    /** Detect deployed Wasm changes and invalidate contract-scoped caches. */
    detectContractUpgrade(
      contractId: string,
      onUpgrade?: (event: UpgradeEvent) => void,
      timeoutMs?: number,
    ): Promise<SorokitResult<UpgradeEvent>>;
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
      safetyOptions?: MainnetSafetyOptions,
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
      safetyOptions?: MainnetSafetyOptions,
    ): Promise<SorokitResult<string>>;
    /** Read contract data — no signing required */
    read(
      params: ContractReadParams,
      timeoutMs?: number,
    ): Promise<SorokitResult<ContractCallResult>>;
    /**
     * Stream contract events in near real-time via the Soroban RPC `getEvents`
     * endpoint. Applies cursor pagination, exponential backoff with jitter on
     * transient failures, and hash-based deduplication (#541).
     */
    streamContractEventsRealTime(
      contractId: string,
      options?: Omit<StreamContractEventsRealTimeOptions, "rpcUrl">,
    ): AsyncGenerator<ContractEvent[]>;
    filterEvents(
      contractId: string,
      filters: ContractEventAnalyticsFilter,
    ): Promise<SorokitResult<ContractEvent[]>>;
    aggregateEvents(
      contractId: string,
      groupBy: EventGroupBy,
      filters?: ContractEventAnalyticsFilter,
    ): Promise<SorokitResult<Record<string, EventAggregate>>>;
    streamEvents(
      contractId: string,
      filters: ContractEventAnalyticsFilter,
      options?: Omit<StreamContractEventsRealTimeOptions, "rpcUrl">,
    ): AsyncGenerator<SorokitResult<ContractEvent[]>>;
    decodeContractResult<S extends ContractResultSchema>(
      result: ContractResultInput,
      schema: S,
    ): SorokitResult<DecodedContractResult<S>>;
    getContractState(
      contractId: string,
      source: ContractStateSource,
    ): Promise<SorokitResult<ContractStateSnapshotRecord>>;
    getContractStateAt(
      contractId: string,
      ledger: number,
    ): SorokitResult<ContractStateSnapshotRecord>;
    getStateChanges(
      contractId: string,
      fromLedger: number,
      toLedger: number,
    ): SorokitResult<ContractStateComparison>;
    watchContractState(
      contractId: string,
      source: ContractStateSource,
      options?: WatchContractStateOptions,
    ): AsyncGenerator<SorokitResult<ContractStateSnapshotRecord>>;
  };

  readonly network: {
    /** Return the resolved network config for this client instance */
    getConfig(): ResolvedNetworkConfig;
    /** Return the network type identifier string (e.g. "testnet", "mainnet", "futurenet") */
    getId(): NetworkType;
    /** Register a custom endpoint with optional weight and priority (#672) */
    registerEndpoint(
      type: import("../network/endpointRegistry").EndpointType,
      url: string,
      weight?: number,
      priority?: number,
    ): SorokitResult<import("../network/endpointRegistry").Endpoint>;
    /** Select the optimal endpoint by weighted score (#672) */
    getOptimalEndpoint(
      type: import("../network/endpointRegistry").EndpointType,
    ): SorokitResult<import("../network/endpointRegistry").Endpoint>;
    /** Round-robin rotate through endpoints (#672) */
    rotateEndpoints(
      type: import("../network/endpointRegistry").EndpointType,
    ): SorokitResult<import("../network/endpointRegistry").Endpoint>;
    /** Health-check an endpoint URL (#672) */
    testEndpoint(
      url: string,
    ): Promise<
      SorokitResult<import("../network/endpointRegistry").EndpointHealthResult>
    >;
    /** List all registered endpoints, optionally filtered by type (#672) */
    getEndpoints(
      type?: import("../network/endpointRegistry").EndpointType,
    ): import("../network/endpointRegistry").Endpoint[];
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

  for (const [name, endpoints] of [
    ["horizonEndpoints", config.horizonEndpoints],
    ["rpcEndpoints", config.rpcEndpoints],
  ] as const) {
    const endpointResult = validateEndpointList(endpoints);
    if (endpointResult.status === "error") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `${name}: ${endpointResult.error.message}`,
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

  if (
    config.sorobanPoll?.maxAttempts !== undefined &&
    (!Number.isInteger(config.sorobanPoll.maxAttempts) ||
      config.sorobanPoll.maxAttempts <= 0)
  ) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "sorobanPoll.maxAttempts must be a positive integer.",
    );
  }
  if (
    config.sorobanPoll?.intervalMs !== undefined &&
    (!Number.isFinite(config.sorobanPoll.intervalMs) ||
      config.sorobanPoll.intervalMs < 0)
  ) {
    return err(
      SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      "sorobanPoll.intervalMs must be a non-negative number.",
    );
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

  if (
    config.deviceTrustThreshold !== undefined &&
    (typeof config.deviceTrustThreshold !== "number" ||
      !Number.isFinite(config.deviceTrustThreshold) ||
      config.deviceTrustThreshold < 0 ||
      config.deviceTrustThreshold > 100)
  ) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "deviceTrustThreshold must be a number between 0 and 100",
    );
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
    horizonUrl: config.horizonEndpoints?.[0] ?? config.horizonUrl,
    rpcUrl: config.rpcEndpoints?.[0] ?? config.rpcUrl,
  });

  if (networkResult.status === "error") return networkResult;

  const networkConfig = networkResult.data;
  const { horizonUrl, rpcUrl, networkPassphrase } = networkConfig;
  if (config.horizonEndpoints) {
    configureEndpointFailover(
      config.horizonEndpoints[0]!,
      config.horizonEndpoints.slice(1),
    );
  }
  if (config.rpcEndpoints) {
    configureEndpointFailover(
      config.rpcEndpoints[0]!,
      config.rpcEndpoints.slice(1),
    );
  }
  const traceId = config.traceId ?? generateTraceId();
  const i18n = createI18n({
    ...(config.locale !== undefined ? { locale: config.locale } : {}),
    ...(config.translations !== undefined
      ? { translations: config.translations }
      : {}),
  });
  const globalTimeout = config.timeoutMs;
  const baseLogger =
    config.logger ??
    createLogger({
      logLevel: config.logLevel ?? (config.debug ? "debug" : "off"),
      ...(config.logPrefix !== undefined ? { prefix: config.logPrefix } : {}),
    });
  const logger = createTracedLogger(baseLogger, { traceId });
  const safetyLogger = createTracedLogger(
    config.logger ??
      createLogger({
        logLevel: "warn",
        ...(config.logPrefix !== undefined ? { prefix: config.logPrefix } : {}),
      }),
    { traceId },
  );

  // Set up distributed tracing with correlation IDs (#212).
  const traceContext = createTraceContext(traceId);
  const deduplicator = createRequestDeduplicator(config.dedupe);
  const tracedFetch = createTracedFetch(traceContext);
  const endpointRegistry = createEndpointRegistry();

  const defaultPollConfig = config.sorobanPoll;
  const errorHandler = config.errorHandler;
  const cache = config.cache ? wrapCache(config.cache) : undefined;
  let contractStateTrackerPromise:
    | Promise<
        | import("../soroban/contractStateTracker").ContractStateTracker
        | undefined
      >
    | undefined;
  const getContractStateTracker = () => {
    if (!cache) return Promise.resolve(undefined);
    contractStateTrackerPromise ??=
      import("../soroban/contractStateTracker").then(
        ({ createContractStateTracker }) =>
          createContractStateTracker(cache, horizonUrl, { fetch: tracedFetch }),
      );
    return contractStateTrackerPromise;
  };
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
    logger.debug(
      "client.create: checked persistence adapter for wallet state",
      {
        hasPersistedState: !!persisted,
      },
    );
  }

  // Initialize Multi-Account Manager (#579)
  const accountManager =
    config.accountManager ??
    createAccountManager({
      ...(config.accountStorageAdapter && {
        storageAdapter: config.accountStorageAdapter,
      }),
    });

  // Wallet event emitter (#613) — bridges accountManager's own switch
  // notifications into the named "accountChanged" event.
  const walletEvents = createWalletEventEmitter();
  accountManager.watchAccountSwitch((activeAccount, previousAccount) => {
    walletEvents.emit("accountChanged", { activeAccount, previousAccount });
  });
  const contractStateHistory = createContractStateHistory();

  const client: SorokitClient = {
    i18n,
    version: SDK_VERSION,
    networkConfig,
    trustedIssuers: config.trustedIssuers ?? null,
    traceId,
    traceContext,
    getTraceContext,

    integration: {
      resolveFederatedAddress: async (address, options) =>
        (
          await import("../integration/federationResolver")
        ).resolveFederatedAddress(address, options),
      fetchStellarToml: async (domain, options) =>
        (await import("../integration/sep1Toml")).fetchStellarToml(
          domain,
          options,
        ),
      clearStellarTomlCache: async (domain) =>
        (await import("../integration/sep1Toml")).clearStellarTomlCache(domain),
      authenticateSep10: async (anchorUrl, options) =>
        (await import("../integration/anchors")).authenticateSep10(
          anchorUrl,
          options,
        ),
      initiateSep10Auth: async (serverUrl, publicKey, options) =>
        (await import("../integration/sep10Auth")).initiateSep10Auth(
          serverUrl,
          publicKey,
          options,
        ),
      completeSep10Auth: async (challengeXdr, signedChallengeXdr, options) =>
        (await import("../integration/sep10Auth")).completeSep10Auth(
          challengeXdr,
          signedChallengeXdr,
          options,
        ),
      validateSep10Token: async (token, now) =>
        (await import("../integration/sep10Auth")).validateSep10Token(
          token,
          now,
        ),
      initiateSep6Transfer: async (anchorUrl, asset, options) =>
        (await import("../integration/anchors")).initiateSep6Transfer(
          anchorUrl,
          asset,
          options,
        ),
      initiateSep24Interactive: async (anchorUrl, asset, options) =>
        (await import("../integration/anchors")).initiateSep24Interactive(
          anchorUrl,
          asset,
          options,
        ),
      getSep6TransactionStatus: async (anchorUrl, id, options) =>
        (await import("../integration/anchors")).getSep6TransactionStatus(
          anchorUrl,
          id,
          options,
        ),
      initiateDeposit: async (serverUrl, asset, options) =>
        (await import("../integration/sep6Flow")).initiateDeposit(
          serverUrl,
          asset,
          options,
        ),
      initiateWithdraw: async (serverUrl, asset, options) =>
        (await import("../integration/sep6Flow")).initiateWithdraw(
          serverUrl,
          asset,
          options,
        ),
      trackTransaction: async (serverUrl, txId, options) =>
        (await import("../integration/sep6Flow")).trackTransaction(
          serverUrl,
          txId,
          options,
        ),
      getKycFields: async (serverUrl, account, options) =>
        (await import("../integration/sep12Kyc")).getKycFields(
          serverUrl,
          account,
          options,
        ),
      submitKycInfo: async (serverUrl, account, info, options) =>
        (await import("../integration/sep12Kyc")).submitKycInfo(
          serverUrl,
          account,
          info,
          options,
        ),
      getKycStatus: async (serverUrl, account, options) =>
        (await import("../integration/sep12Kyc")).getKycStatus(
          serverUrl,
          account,
          options,
        ),
      initiateInteractiveDeposit: async (serverUrl, asset, options) =>
        (await import("../integration/sep24Flow")).initiateInteractiveDeposit(
          serverUrl,
          asset,
          options,
        ),
      initiateInteractiveWithdraw: async (serverUrl, asset, options) =>
        (await import("../integration/sep24Flow")).initiateInteractiveWithdraw(
          serverUrl,
          asset,
          options,
        ),
      monitorTransaction: async (serverUrl, txId, options) =>
        (await import("../integration/sep24Flow")).monitorTransaction(
          serverUrl,
          txId,
          options,
        ),
      quoteDirectPayment: async (serverUrl, sendingAsset, receiver, options) =>
        (await import("../integration/sep31DirectPayment")).quoteDirectPayment(
          serverUrl,
          sendingAsset,
          receiver,
          options,
        ),
      sendDirectPayment: async (serverUrl, amount, receiver, options) =>
        (await import("../integration/sep31DirectPayment")).sendDirectPayment(
          serverUrl,
          amount,
          receiver,
          options,
        ),
      trackDirectPayment: async (serverUrl, txId, options) =>
        (await import("../integration/sep31DirectPayment")).trackDirectPayment(
          serverUrl,
          txId,
          options,
        ),
      createDID,
      resolveDID: async (did) =>
        (await import("../integration/didSupport")).resolveDID(did),
      linkAccountToDID: async (publicKey, did) =>
        (await import("../integration/didSupport")).linkAccountToDID(
          publicKey,
          did,
        ),
      verifyDIDOwnership: async (
        did: string,
        publicKey: string,
        proof: import("../integration/didSupport").DIDOwnershipProof,
      ) =>
        (await import("../integration/didSupport")).verifyDIDOwnership(
          did,
          publicKey,
          proof,
        ),
      // #686: governance, loaded on first use.
      getProposals: async (network, options) =>
        (await import("../integration/governance")).getProposals(
          network ?? networkConfig.network,
          options,
        ),
      voteOnProposal: async (proposalId, vote, options) =>
        (await import("../integration/governance")).voteOnProposal(
          proposalId,
          vote,
          { network: networkConfig.network, ...options },
        ),
      getVotingPower: async (publicKey, options) =>
        (await import("../integration/governance")).getVotingPower(publicKey, {
          network: networkConfig.network,
          ...options,
        }),
      trackProposal: async (proposalId, options) =>
        (await import("../integration/governance")).trackProposal(proposalId, {
          network: networkConfig.network,
          ...options,
        }),
    },

    shared: {
      deriveKey: async (mnemonic, path, passphrase) =>
        (await import("../shared/keyManagement")).deriveKey(
          mnemonic,
          path,
          passphrase,
        ),
      validateSecretKey: async (secretKey) =>
        (await import("../shared/keyManagement")).validateSecretKey(secretKey),
      rotateSecretKey: async (options) =>
        (await import("../shared/keyManagement")).rotateSecretKey(options),
    },

    compliance: createAuditTrail(),

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
      evaluateTrust: (fingerprint, history) =>
        evaluateDeviceTrust(fingerprint, history, {
          threshold: config.deviceTrustThreshold ?? DEFAULT_TRUST_THRESHOLD,
        }),
      connect: (adapter, optionsOrTimeoutMs) => {
        const connectOpts:
          | import("../wallet/types").WalletConnectOptions
          | undefined =
          typeof optionsOrTimeoutMs === "number"
            ? { timeoutMs: optionsOrTimeoutMs }
            : optionsOrTimeoutMs;
        const timeoutMs = connectOpts?.timeoutMs;

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
                logger.warn(
                  "wallet.connect.recover.persistence.validation_failed",
                  {
                    walletType: adapter.walletType,
                  },
                );
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
            () => connectWallet(adapter, cache, connectOpts),
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
        ).then((result) => {
          // Emit "connected" (#613) after the wrapped result is finalized
          if (result.status === "ok") {
            const connectedEvent = toConnectedEvent(result.data);
            if (connectedEvent) walletEvents.emit("connected", connectedEvent);
          }
          return result;
        });
      },
      disconnect: (adapter, timeoutMs) =>
        guard("wallet_disconnect", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "wallet.disconnect",
              params: { walletType: adapter.walletType },
            },
            async () =>
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
        ).then((result) => {
          // Emit "disconnected" (#613) after the wrapped result is finalized
          if (result.status === "ok") {
            walletEvents.emit("disconnected", {
              walletType: adapter.walletType,
            });
          }
          return result;
        }),
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
      addAccount: (publicKey, metadata) =>
        accountManager.addAccount(publicKey, metadata),
      removeAccount: (publicKey) => accountManager.removeAccount(publicKey),
      switchAccount: (publicKey) => accountManager.switchAccount(publicKey),
      getActiveAccount: () => accountManager.getActiveAccount(),
      listAccounts: () => accountManager.listAccounts(),
      watchAccountSwitch: (listener) =>
        accountManager.watchAccountSwitch(listener),
      on: (event, listener) => walletEvents.on(event, listener),
      off: (event, listener) => walletEvents.off(event, listener),
      saveSession: (connection, options) => saveSession(connection, options),
      restoreSession: (options) => restoreSession(options),
      clearSession: (options) => clearSession(options),
      isSessionValid: (session) => isSessionValid(session),
    },

    account: {
      calculateHealthScore: (publicKey) =>
        calculateHealthScore(horizonUrl, publicKey),
      getRecoveryPlan: (publicKey) => getRecoveryPlan(horizonUrl, publicKey),
      addRecoverySigner: (account, recoveryKey, recoveryWeight) =>
        addRecoverySigner(
          horizonUrl,
          networkConfig,
          account,
          recoveryKey,
          recoveryWeight,
        ),
      rotateKeys: (account, newKey, newKeyWeight) =>
        rotateKeys(horizonUrl, networkConfig, account, newKey, newKeyWeight),
      removeOldSigner: (account, oldKey, rotatedAt, options) =>
        removeOldSigner(
          horizonUrl,
          networkConfig,
          account,
          oldKey,
          rotatedAt,
          options,
        ),
      get: (publicKey, timeoutMs) =>
        guard("account_get", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["account.get", horizonUrl, publicKey],
            (dedupSignal) =>
              withErrorHandling(
                errorHandler,
                { functionName: "account.get", params: { publicKey } },
                () =>
                  withLogging(
                    logger,
                    "account.get",
                    { publicKey },
                    async () => {
                      const cacheKey = `account:get:${horizonUrl}:${publicKey}`;
                      if (cache) {
                        const cachedVal = cache.get(cacheKey);
                        if (cachedVal) return ok(cachedVal as AccountInfo);
                      }
                      const res = await getAccount(horizonUrl, publicKey, {
                        signal: dedupSignal,
                      });
                      if (cache && res.status === "ok")
                        cache.set(cacheKey, res.data);
                      return res;
                    },
                  ),
              ).then(applyTx),
            signal,
          ),
        ),
      getAccountsBatch: (publicKeys, timeoutMs) =>
        guard("account_get_batch", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "account.getAccountsBatch",
              params: { publicKeys },
            },
            () =>
              withLogging(
                logger,
                "account.getAccountsBatch",
                { publicKeys },
                () =>
                  getAccountsBatch(horizonUrl, publicKeys, {
                    signal,
                    ...(cache && { cache }),
                  }),
              ),
          ).then(applyTx),
        ),
      getBalances: (publicKey, timeoutMs) =>
        guard("account_get_balances", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["account.getBalances", horizonUrl, publicKey],
            (dedupSignal) =>
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
                      const res = await getBalances(horizonUrl, publicKey, {
                        signal: dedupSignal,
                      });
                      if (cache && res.status === "ok")
                        cache.set(cacheKey, res.data);
                      return res;
                    },
                  ),
              ).then(applyTx),
            signal,
          ),
        ),
      getAssetBalances: (publicKey, filter, timeoutMs) =>
        guard("account_get_balances", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["account.getAssetBalances", horizonUrl, publicKey, filter],
            (dedupSignal) =>
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
                        { signal: dedupSignal },
                      );
                      if (cache && res.status === "ok")
                        cache.set(cacheKey, res.data);
                      return res;
                    },
                  ),
              ).then(applyTx),
            signal,
          ),
        ),
      stream: (publicKey, streamConfig, signal) =>
        streamAccount(horizonUrl, publicKey, streamConfig, signal, logger),
      formatAddress: (publicKey, chars) => formatAddress(publicKey, chars),
      isValidPublicKey: (key) => isValidPublicKey(key),
      isValidContractId: (id) => isValidContractId(id),
      setSponsor: (account, sponsor) => applyTx(setSponsor(account, sponsor)),
      removeSponsor: (account) => applyTx(removeSponsor(account)),
      getOffers: (publicKey, options, timeoutMs) =>
        guard("account_get_offers", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "account.getOffers",
              params: { publicKey, options },
            },
            () => getOffers(horizonUrl, publicKey, options),
          ).then(applyTx),
        ),
      getTrades: (publicKey, options, timeoutMs) =>
        guard("account_get_trades", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "account.getTrades",
              params: { publicKey, options },
            },
            () => getTrades(horizonUrl, publicKey, options),
          ).then(applyTx),
        ),
      simulateAccountMerge: (
        sourcePublicKey,
        destinationPublicKey,
        options,
        timeoutMs,
      ) =>
        guard("account_get", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "account.simulateAccountMerge",
              params: { sourcePublicKey, destinationPublicKey },
            },
            () =>
              withLogging(
                logger,
                "account.simulateAccountMerge",
                { sourcePublicKey, destinationPublicKey },
                () =>
                  simulateAccountMerge(
                    horizonUrl,
                    sourcePublicKey,
                    destinationPublicKey,
                    {
                      ...options,
                      ...(signal !== undefined
                        ? { signal }
                        : options?.signal !== undefined
                          ? { signal: options.signal }
                          : {}),
                    },
                  ),
              ),
          ).then(applyTx),
        ),
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
              logger.debug("transaction.buildCreateAccount", {
                sourcePublicKey,
              });
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
      buildCreateClaimableBalance: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildCreateClaimableBalance",
              params: { sourcePublicKey, ...params },
            },
            () => {
              logger.debug("transaction.buildCreateClaimableBalance", {
                sourcePublicKey,
              });
              return buildCreateClaimableBalance(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
                client.trustedIssuers,
              );
            },
          ).then(applyTx),
        ),
      buildClaimClaimableBalance: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildClaimClaimableBalance",
              params: { sourcePublicKey, balanceId: params.balanceId },
            },
            () => {
              logger.debug("transaction.buildClaimClaimableBalance", {
                sourcePublicKey,
              });
              return buildClaimClaimableBalance(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
              );
            },
          ).then(applyTx),
        ),
      buildBumpSequence: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildBumpSequence",
              params: {
                sourcePublicKey,
                bumpToSequence: params.bumpToSequence,
              },
            },
            () => {
              logger.debug("transaction.buildBumpSequence", {
                sourcePublicKey,
              });
              return buildBumpSequenceTransaction(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
              );
            },
          ).then(applyTx),
        ),
      buildSetOptions: (sourcePublicKey, params, timeoutMs) =>
        guard("tx_build", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "transaction.buildSetOptions",
              params: { sourcePublicKey, ...params },
            },
            () =>
              buildSetOptionsTransaction(
                horizonUrl,
                networkConfig,
                sourcePublicKey,
                params,
              ),
          ).then(applyTx),
        ),
      compose: (sourcePublicKey, options) => {
        logger.debug("transaction.compose", { sourcePublicKey });
        return compose(sourcePublicKey, networkConfig, options);
      },
      orchestrate: (options) => orchestrate(options),
      submit: async (signedXdr, optionsOrTimeoutMs) => {
        const submitOptions =
          typeof optionsOrTimeoutMs === "number"
            ? { timeoutMs: optionsOrTimeoutMs }
            : optionsOrTimeoutMs;
        const timeoutMs = submitOptions?.timeoutMs;
        return guard("tx_submit", timeoutMs, (signal) =>
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
                {
                  ...submitOptions,
                  signal,
                  logger: submitOptions?.logger ?? safetyLogger,
                },
              );
            },
          ).then(applyTx),
        );
      },
      submitTransaction: (signedXdr, options) =>
        client.transaction.submit(signedXdr, options),
      previewTransaction: (transactionXdr, _sourcePublicKey, timeoutMs) =>
        guard("tx_preview", timeoutMs, (signal) =>
          withErrorHandling(
            errorHandler,
            { functionName: "transaction.previewTransaction" },
            () => {
              logger.debug("transaction.previewTransaction");
              return previewTransaction(
                horizonUrl,
                networkPassphrase,
                transactionXdr,
                {
                  rpcUrl,
                  signal,
                },
              );
            },
          ).then(applyTx),
        ),
      getStatus: (hash, timeoutMs) =>
        guard("tx_status", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["transaction.getStatus", horizonUrl, hash],
            (dedupSignal) =>
              withErrorHandling(
                errorHandler,
                { functionName: "transaction.getStatus", params: { hash } },
                () => {
                  logger.debug("transaction.getStatus", { hash });
                  return getTransactionStatus(horizonUrl, hash, cache, {
                    signal: dedupSignal,
                  });
                },
              ).then(applyTx),
            signal,
          ),
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
                networkPassphrase:
                  query?.networkPassphrase ?? networkPassphrase,
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
              logger.debug("transaction.exportTransactionHistory", {
                publicKey,
              });
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
            async () =>
              (await import("../soroban")).getContractMethods(
                rpcUrl,
                contractId,
                {
                  ...(cache ? { cache } : {}),
                  ...(ttlMs !== undefined ? { ttlMs } : {}),
                },
              ),
          ).then(applyTx),
        ),
      detectContractUpgrade: (contractId, onUpgrade, timeoutMs) =>
        guard("soroban_get_methods", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.detectContractUpgrade",
              params: { contractId },
            },
            async () =>
              (await import("../soroban")).detectContractUpgrade(
                rpcUrl,
                contractId,
                {
                  ...(cache ? { cache } : {}),
                  ...(onUpgrade ? { onUpgrade } : {}),
                },
              ),
          ).then(applyTx),
        ),
      simulate: (transactionXdr, timeoutMs) =>
        guard("soroban_simulate", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["soroban.simulate", rpcUrl, networkPassphrase, transactionXdr],
            () =>
              withErrorHandling(
                errorHandler,
                { functionName: "soroban.simulate" },
                async () =>
                  (await import("../soroban")).simulateTransaction(
                    rpcUrl,
                    networkPassphrase,
                    transactionXdr,
                  ),
              ).then(applyTx),
            signal,
          ),
        ),
      prepare: (params, timeoutMs) =>
        guard("soroban_prepare", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.prepare",
              params: { contractId: params.contractId, method: params.method },
            },
            async () =>
              (await import("../soroban")).prepareContractCall(
                rpcUrl,
                networkConfig,
                horizonUrl,
                params,
              ),
          ).then(applyTx),
        ),
      execute: (signedXdr, pollConfig, timeoutMs, safetyOptions) =>
        guard("soroban_execute", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            { functionName: "soroban.execute" },
            async () =>
              (await import("../soroban")).executeContract(
                rpcUrl,
                networkConfig,
                signedXdr,
                pollConfig ?? defaultPollConfig,
                logger,
                await getContractStateTracker(),
                {
                  ...safetyOptions,
                  logger: safetyOptions?.logger ?? safetyLogger,
                },
              ),
          ).then(applyTx),
        ),
      invoke: (params, signFn, pollConfig, timeoutMs, safetyOptions) =>
        guard("soroban_invoke", timeoutMs, () =>
          withErrorHandling(
            errorHandler,
            {
              functionName: "soroban.invoke",
              params: { contractId: params.contractId, method: params.method },
            },
            async () => {
              const stateTracker = await getContractStateTracker();
              return (await import("../soroban")).invokeContract(
                rpcUrl,
                networkConfig,
                horizonUrl,
                {
                  ...params,
                  ...(params.stateTracker === undefined && stateTracker
                    ? { stateTracker }
                    : {}),
                },
                signFn,
                pollConfig ?? defaultPollConfig,
                logger,
                {
                  ...safetyOptions,
                  logger: safetyOptions?.logger ?? safetyLogger,
                },
              );
            },
          ).then(applyTx),
        ),
      read: (params, timeoutMs) =>
        guard("soroban_read", timeoutMs, (signal) =>
          deduplicator.deduplicate(
            ["soroban.read", rpcUrl, params],
            () =>
              withErrorHandling(
                errorHandler,
                {
                  functionName: "soroban.read",
                  params: {
                    contractId: params.contractId,
                    method: params.method,
                  },
                },
                async () => {
                  const stateTracker = await getContractStateTracker();
                  return (await import("../soroban")).readContract(
                    rpcUrl,
                    horizonUrl,
                    networkConfig,
                    {
                      ...params,
                      ...(params.stateTracker === undefined && stateTracker
                        ? { stateTracker }
                        : {}),
                    },
                  );
                },
              ).then(applyTx),
            signal,
          ),
        ),
      streamContractEventsRealTime: async function* (contractId, options) {
        logger.debug("soroban.streamContractEventsRealTime", { contractId });
        yield* (await import("../soroban")).streamContractEventsRealTime(
          contractId,
          {
            rpcUrl,
            ...options,
          },
        );
      },
      filterEvents: (contractId, filters) =>
        filterContractEvents(contractId, filters, { rpcUrl }),
      aggregateEvents: (contractId, groupBy, filters) =>
        aggregateContractEvents(contractId, groupBy, { rpcUrl }, filters),
      streamEvents: async function* (contractId, filters, options) {
        yield* streamContractEvents(contractId, filters, {
          rpcUrl,
          ...(options !== undefined ? { streamOptions: options } : {}),
        });
      },
      decodeContractResult: (result, schema) =>
        decodeSorobanResult(result, schema),
      getContractState: (contractId, source) =>
        readContractState(contractId, source, contractStateHistory),
      getContractStateAt: (contractId, ledger) =>
        readContractStateAt(contractId, ledger, contractStateHistory),
      getStateChanges: (contractId, fromLedger, toLedger) =>
        compareContractState(
          contractId,
          fromLedger,
          toLedger,
          contractStateHistory,
        ),
      watchContractState: (contractId, source, options) =>
        streamContractState(contractId, source, options, contractStateHistory),
    },

    network: {
      getConfig: () => networkConfig,
      getId: () => config.network,
      registerEndpoint: (type, url, weight?, priority?) =>
        endpointRegistry.registerEndpoint(type, url, weight, priority),
      getOptimalEndpoint: (type) => endpointRegistry.getOptimalEndpoint(type),
      rotateEndpoints: (type) => endpointRegistry.rotateEndpoints(type),
      testEndpoint: (url) => endpointRegistry.testEndpoint(url),
      getEndpoints: (type?) => endpointRegistry.getEndpoints(type),
    },
  };

  return ok(client);
}
