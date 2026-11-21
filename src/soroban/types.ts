/**
 * Soroban module public types.
 */
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractEvent } from "./subscribeContractEvents";
import type { ContractStateTracker } from "./contractStateTracker";
export type { ContractStateTracker };
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../shared/constants";

export interface ContractMethodInput {
  name: string;
  type: string;
}

export interface ContractAbiField {
  name: string;
  type: string | ContractAbiTypeDescriptor;
}

export interface ContractAbiTypeDescriptor {
  type: string;
  valueType?: string | ContractAbiTypeDescriptor;
  keyType?: string | ContractAbiTypeDescriptor;
  elementType?: string | ContractAbiTypeDescriptor;
  fields?: ContractAbiField[];
  variants?: ContractAbiField[];
}

/**
 * Visibility level of a contract method.
 * - "public"   — callable by any account
 * - "private"  — callable only from within the contract
 * - "admin"    — callable only by designated admin accounts
 * - "restricted" — callable only by accounts meeting authorization requirements
 */
export type ContractMethodVisibility =
  | "public"
  | "private"
  | "admin"
  | "restricted";

/**
 * Authorization requirements for a contract method.
 * When present, `prepareCall()` validates that the invoking account
 * satisfies these requirements before constructing the invocation.
 */
export interface ContractAuthorizationRequirement {
  /** List of public keys authorized to call this method. */
  requiredSigners?: string[];
}

export interface ContractMethod {
  name: string;
  inputs: ContractMethodInput[];
  returnType: string | null;
  /**
   * Optional visibility declaration. When absent, the method is treated as
   * callable — existing contracts that do not expose visibility metadata
   * remain compatible with the current behavior.
   */
  visibility?: ContractMethodVisibility;
  /**
   * Optional authorization requirements. Validated against the invoking
   * public key when available. Not exposed in error messages to avoid
   * leaking sensitive authorization data.
   */
  authorizationRequirements?: ContractAuthorizationRequirement;
}

export interface ContractAbiMethod {
  name: string;
  args: unknown[];
  returns?: unknown;
}

export interface ContractAbiObject {
  methods: ContractAbiMethod[];
}

export interface ContractAbiFunctionObject {
  functions: ContractAbiMethod[];
}

export interface ContractAbiSpec {
  funcs(): xdr.ScSpecFunctionV0[];
}

export type ContractAbi =
  | ContractAbiObject
  | ContractAbiFunctionObject
  | ContractAbiSpec
  | xdr.ScSpecFunctionV0[];

export interface ContractInvokeParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /** Optional tracker for cache invalidation based on contract state changes */
  stateTracker?: ContractStateTracker;
  /** Public key of the invoking account */
  publicKey: string;
}

export interface ContractReadParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /**
   * Public key of a funded account to use as the simulation source.
   * Required — the Soroban RPC needs a real account to simulate against.
   */
  publicKey: string;
  /** Optional cache for contract read results */
  cache?: import("../shared/cache").SorokitCache;
  /** Bypass cache lookup, deduplication, and writes for this request */
  bypassCache?: boolean;
  /** Optional tracker for cache invalidation based on contract state changes */
  stateTracker?: ContractStateTracker;
  /** Optional TTL for cache entries in milliseconds (default: 5 minutes) */
  ttlMs?: number;
}

export interface ContractCallResult {
  /** Raw ScVal result */
  result: xdr.ScVal;
  /** Convenience: result decoded to a native JS value where possible */
  value: unknown;
}

export interface PreparedContractCall {
  /** XDR-encoded transaction ready for signing */
  transactionXdr: string;
  /** Estimated fee in stroops */
  fee: string;
}

/**
 * Configuration for the polling loop in invokeContract().
 */
export interface SorobanPollConfig {
  /**
   * Maximum number of polling attempts before giving up.
   * @default DEFAULT_POLL_MAX_ATTEMPTS (20)
   */
  maxAttempts?: number;
  /**
   * Milliseconds between polling attempts.
   * @default DEFAULT_POLL_INTERVAL_MS (1500)
   */
  intervalMs?: number;
}

/**
 * Result of a pre-flight transaction simulation.
 * Returned by soroban.simulate() — used for fee estimation and pre-flight checks.
 */
export interface SimulateTransactionResult {
  /** Estimated fee in stroops */
  fee: string;
  /** Whether the simulation succeeded */
  success: boolean;
  /** Error message if simulation failed */
  error?: string;
  /** Detailed ledger resource usage returned by Soroban RPC, when available */
  resourceUsage?: SorobanSimulationResourceUsage;
  /** Fee components derived from the RPC simulation response */
  feeBreakdown?: SorobanSimulationFeeBreakdown;
  /** Warning message if RPC simulation response had missing or incomplete expected resource fields */
  warning?: string;
}

export interface SorobanSimulationResourceUsage {
  instructions?: string;
  readBytes?: number;
  writeBytes?: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
  footprint?: {
    readOnly?: number;
    readWrite?: number;
  };
  /** Missing expected fields detected during response validation */
  missingFields?: string[];
  /** Warning message describing missing expected fields */
  warning?: string;
  /** Validation error message when required resource fields are missing */
  error?: string;
}

export interface SorobanSimulationFeeBreakdown {
  minResourceFee: string;
  refundableFee?: string;
  nonRefundableFee?: string;
  total?: string;
}

/** A single contract invocation in a batch. */
export interface BatchContractInvocation {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  publicKey: string;
  cachedMetadata?: ContractMethod[];
  contractAbi?: ContractAbi;
  stateTracker?: ContractStateTracker;
}

/** Result for one invocation within a batch — preserves contractId and method for correlation. */
export type BatchContractResult =
  | { status: "ok"; data: string; contractId: string; method: string }
  | {
      status: "error";
      error: { code: string; message: string };
      contractId: string;
      method: string;
    };

export type ContractResultType =
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "string"
  | "symbol"
  | "bytes"
  | "void"
  | "vec"
  | "map"
  | "address";

export interface ParsedContractResult {
  type: string;
  value: unknown;
}

export interface DecodedContractEvent {
  contractId: string;
  name: string;
  topics: string[];
  value: unknown;
  raw: unknown;
  type: string;
}

export interface StreamContractEventsOptions {
  horizonUrl: string;
  intervalMs?: number;
  maxBackoffMs?: number;
  /**
   * Delay in milliseconds before the next poll when a successful fetch returns
   * no new events. Defaults to `intervalMs`. Set to a shorter value (e.g. 100)
   * to poll more aggressively during idle periods.
   */
  emptyPollDelayMs?: number;
  fetch?: typeof fetch;
  onEvent: (events: ContractEvent[]) => void;
  onError?: (err: Error, attempt: number) => void;
  onReconnect?: (attempt: number) => void;
}

export interface EventIndexFilter {
  contractId?: string;
  name?: string;
  topics?: string[];
  minLedger?: number;
  maxLedger?: number;
  predicate?: (event: ContractEvent) => boolean;
}

/** A single contract storage entry returned by calculateStorageRent */
export interface StorageEntry {
  contractId: string;
  /** xdr.LedgerKey serialised to base64 for the caller's reference */
  keyXdr: string;
  /** Ledger sequence after which the entry expires (from liveUntilLedgerSeq) */
  liveUntilLedgerSeq: number;
  /** Ledger sequences remaining until expiry (liveUntilLedgerSeq - latestLedger) */
  remainingLedgers: number;
  /**
   * Rough cost estimate in stroops derived from remaining TTL.
   * Formula: ceil(remainingLedgers / 1000) * 10000 stroops.
   * Returns 0 when the entry is already expired or not found.
   * @remarks This is an estimate only — actual renewal cost depends on simulation.
   */
  estimatedRenewalCostStroops: number;
}

/** Aggregated result from calculateStorageRent */
export interface StorageRentResult {
  /** Ledger sequence returned by the RPC node at the time of the call */
  ledgerSequence: number;
  entries: StorageEntry[];
}

/** Result from renewContractStorage */
export interface RenewContractStorageResult {
  /** Base64-encoded TransactionEnvelope XDR containing ExtendFootprintTTL */
  operationXdr: string;
  /** Current account sequence number used as the transaction source */
  suggestedSequence: string;
}
