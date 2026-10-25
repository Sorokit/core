import { rpc as SorobanRpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  toMessage,
} from "../shared";
import type {
  SimulateTransactionResult,
  SorobanSimulationFeeBreakdown,
  SorobanSimulationResourceUsage,
} from "./types";
import type { SorokitCache } from "../shared/cache";
import { createSimulationCacheKey } from "./contractCallIdentity";
import { createSorobanServer } from "../shared/serverFactory";
import { emitObservabilityEvent } from "../shared/observability";

export interface ExtractResourceUsageOptions {
  /**
   * If true, throws an Error when expected resource fields are missing.
   * Defaults to false (logs a warning instead).
   */
  strict?: boolean;
  /**
   * Optional custom logger for warning output. Defaults to `console.warn`.
   */
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
  };
}

export interface ResourceUsageValidationResult {
  valid: boolean;
  missingFields: string[];
  error?: string;
}

export interface SimulateTransactionOptions {
  cache?: SorokitCache;
  ttlMs?: number;
  /**
   * When true, missing expected resource fields in RPC simulation responses
   * cause the simulation to fail with a validation error.
   */
  strictResourceValidation?: boolean;
  /**
   * Optional custom logger to receive simulation warnings.
   */
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
  };
}

function describeSimulationFailure(cause: unknown): string {
  if (isXdrInvalidError(cause)) {
    return `Transaction simulation failed because the transaction XDR is malformed: ${toMessage(cause)}`;
  }
  if (isTimeoutError(cause)) {
    return `Transaction simulation timed out while contacting RPC: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Transaction simulation failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Transaction simulation failed: ${toMessage(cause)}`;
}

function stringifyFee(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function getProp<T>(obj: unknown, prop: string): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[prop];
  if (typeof val === "function") {
    try {
      return val.call(obj) as T;
    } catch {
      return undefined;
    }
  }
  return val as T;
}

function getResources(transactionData: unknown): unknown {
  if (!transactionData || typeof transactionData !== "object") return undefined;
  const td = transactionData as { resources?: unknown };
  if (typeof td.resources === "function") {
    try {
      return td.resources();
    } catch {
      return undefined;
    }
  }
  return td.resources;
}

function parseBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseEntryCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

/**
 * Validates whether an RPC simulation success response contains expected resource fields.
 */
export function validateResourceUsageResponse(
  simResult: unknown,
): ResourceUsageValidationResult {
  if (simResult == null || typeof simResult !== "object") {
    return {
      valid: false,
      missingFields: ["simResult"],
      error: "Simulation response is missing or not an object.",
    };
  }

  const raw = simResult as {
    cost?: {
      cpuInsns?: unknown;
      memBytes?: unknown;
    };
    transactionData?: unknown;
  };

  const missingFields: string[] = [];
  const hasCost = raw.cost !== undefined && raw.cost !== null && typeof raw.cost === "object";
  const hasTransactionData = raw.transactionData !== undefined && raw.transactionData !== null;

  if (!hasCost && !hasTransactionData) {
    missingFields.push("cost", "transactionData");
  } else if (!hasTransactionData && hasCost) {
    if (raw.cost!.cpuInsns === undefined || raw.cost!.cpuInsns === null) {
      missingFields.push("cost.cpuInsns");
    }
    if (raw.cost!.memBytes === undefined || raw.cost!.memBytes === null) {
      missingFields.push("cost.memBytes");
    }
  } else if (hasTransactionData) {
    const resources = getResources(raw.transactionData);
    if (!resources) {
      missingFields.push("transactionData.resources");
      if (hasCost) {
        if (raw.cost!.cpuInsns === undefined || raw.cost!.cpuInsns === null) {
          missingFields.push("cost.cpuInsns");
        }
        if (raw.cost!.memBytes === undefined || raw.cost!.memBytes === null) {
          missingFields.push("cost.memBytes");
        }
      }
    } else {
      const instructionsVal = getProp(resources, "instructions") ?? raw.cost?.cpuInsns;
      if (instructionsVal === undefined || instructionsVal === null) {
        missingFields.push("instructions");
      }
      const readBytesVal = getProp(resources, "readBytes");
      if (readBytesVal === undefined || readBytesVal === null) {
        missingFields.push("readBytes");
      }
      const writeBytesVal = getProp(resources, "writeBytes") ?? raw.cost?.memBytes;
      if (writeBytesVal === undefined || writeBytesVal === null) {
        missingFields.push("writeBytes");
      }
    }
  }

  const valid = missingFields.length === 0;
  return {
    valid,
    missingFields,
    ...(valid
      ? {}
      : {
          error: `RPC simulation response is missing required resource fields: ${missingFields.join(", ")}`,
        }),
  };
}

/**
 * Extracts resource usage from a Soroban RPC simulation response.
 * Validates the response shape first and reports any missing fields via warning or error.
 */
export function extractResourceUsage(
  simResult: SorobanRpc.Api.SimulateTransactionSuccessResponse | unknown,
  options?: ExtractResourceUsageOptions,
): SorobanSimulationResourceUsage {
  const validation = validateResourceUsageResponse(simResult);
  const raw = (simResult && typeof simResult === "object" ? simResult : {}) as {
    cost?: {
      cpuInsns?: unknown;
      memBytes?: unknown;
    };
    transactionData?: unknown;
  };

  const resources = getResources(raw.transactionData);
  const footprint = getProp(resources, "footprint");
  const readOnlyEntries = footprint ? getProp(footprint, "readOnly") : undefined;
  const writeOnlyEntries = footprint ? getProp(footprint, "readWrite") : undefined;
  const readLedgerEntries = parseEntryCount(readOnlyEntries);
  const writeLedgerEntries = parseEntryCount(writeOnlyEntries);

  const usage: SorobanSimulationResourceUsage = {};
  const instructionsVal = getProp(resources, "instructions") ?? raw.cost?.cpuInsns;
  const instructions = stringifyFee(instructionsVal);

  if (instructions !== undefined) usage.instructions = instructions;
  const readBytes = parseBytes(getProp(resources, "readBytes"));
  if (readBytes !== undefined) usage.readBytes = readBytes;
  const writeBytes = parseBytes(getProp(resources, "writeBytes") ?? raw.cost?.memBytes);
  if (writeBytes !== undefined) usage.writeBytes = writeBytes;
  if (readLedgerEntries !== undefined) usage.readLedgerEntries = readLedgerEntries;
  if (writeLedgerEntries !== undefined) usage.writeLedgerEntries = writeLedgerEntries;
  if (readLedgerEntries !== undefined || writeLedgerEntries !== undefined) {
    usage.footprint = {
      ...(readLedgerEntries !== undefined ? { readOnly: readLedgerEntries } : {}),
      ...(writeLedgerEntries !== undefined ? { readWrite: writeLedgerEntries } : {}),
    };
  }

  if (!validation.valid) {
    const warningMessage = `[sorokit] extractResourceUsage: RPC response is missing expected resource fields (${validation.missingFields.join(", ")}). Resource usage estimates may be incomplete.`;

    if (options?.strict) {
      throw new Error(validation.error ?? warningMessage);
    }

    if (options?.logger?.warn) {
      options.logger.warn(warningMessage);
    } else if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(warningMessage);
    }

    usage.missingFields = validation.missingFields;
    usage.warning = warningMessage;
    if (validation.error) {
      usage.error = validation.error;
    }
  }

  return usage;
}

function extractFeeBreakdown(
  simResult: SorobanRpc.Api.SimulateTransactionSuccessResponse,
): SorobanSimulationFeeBreakdown {
  const raw = simResult as unknown as {
    minResourceFee?: unknown;
    refundableFee?: unknown;
    nonRefundableFee?: unknown;
    totalFee?: unknown;
  };

  const minResourceFee = stringifyFee(raw.minResourceFee) ?? "0";
  const refundableFee = stringifyFee(raw.refundableFee);
  const nonRefundableFee = stringifyFee(raw.nonRefundableFee);
  return {
    minResourceFee,
    ...(refundableFee !== undefined ? { refundableFee } : {}),
    ...(nonRefundableFee !== undefined ? { nonRefundableFee } : {}),
    total: stringifyFee(raw.totalFee) ?? minResourceFee,
  };
}

/**
 * Simulate any transaction XDR against the Soroban RPC.
 * Used for fee estimation and pre-flight validation without submitting.
 *
 * Lives in soroban/ because it uses the Soroban RPC server.
 * For contract calls, prefer soroban.prepare() which handles
 * simulation and assembly in one step.
 */
export async function simulateTransaction(
  rpcUrl: string,
  networkPassphrase: string,
  transactionXdr: string,
  options?: SimulateTransactionOptions,
): Promise<SorokitResult<SimulateTransactionResult>> {
  if (isXdrInvalidError(transactionXdr)) {
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      "Transaction simulation failed because the transaction XDR is malformed.",
      transactionXdr,
    );
  }

  const cache = options?.cache;
  const cacheKey = cache
    ? createSimulationCacheKey(transactionXdr, networkPassphrase)
    : undefined;

  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached != null) {
      return ok(cached as SimulateTransactionResult);
    }
  }

  const start = Date.now();
  try {
    const rpc = createSorobanServer(rpcUrl);
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    const simResult = await rpc.simulateTransaction(tx);

    try {
      emitObservabilityEvent({
        type: "rpc_call",
        method: "simulateTransaction",
        url: rpcUrl,
        durationMs: Date.now() - start,
        success: true,
      });
    } catch {
      // Ignore observability hook errors
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const result: SimulateTransactionResult = { success: false, fee: "0", error: simResult.error };
      if (cache && cacheKey) {
        const ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
        cache.set(cacheKey, result, ttlMs);
      }
      return ok(result);
    }

    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      const feeBreakdown = extractFeeBreakdown(simResult);
      const resourceUsage = extractResourceUsage(simResult, {
        ...(options?.strictResourceValidation !== undefined
          ? { strict: options.strictResourceValidation }
          : {}),
        ...(options?.logger ? { logger: options.logger } : {}),
      });
      const result: SimulateTransactionResult = {
        success: true,
        fee: feeBreakdown.minResourceFee,
        resourceUsage,
        feeBreakdown,
        ...(resourceUsage.warning !== undefined ? { warning: resourceUsage.warning } : {}),
      };
      if (cache && cacheKey) {
        const ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
        cache.set(cacheKey, result, ttlMs);
      }
      return ok(result);
    }

    try {
      emitObservabilityEvent({
        type: "rpc_call",
        method: "simulateTransaction",
        url: rpcUrl,
        durationMs: Date.now() - start,
        success: false,
        errorCode: SorokitErrorCode.TX_SIMULATE_FAILED,
      });
    } catch {
      // Ignore
    }
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      "Transaction simulation returned an unexpected result.",
      simResult,
    );
  } catch (cause) {
    try {
      emitObservabilityEvent({
        type: "rpc_call",
        method: "simulateTransaction",
        url: rpcUrl,
        durationMs: Date.now() - start,
        success: false,
        errorCode: SorokitErrorCode.TX_SIMULATE_FAILED,
      });
    } catch {
      // Ignore observability hook errors
    }
    return err(
      SorokitErrorCode.TX_SIMULATE_FAILED,
      describeSimulationFailure(cause),
      cause,
    );
  }
}

/**
 * Result for a single transaction in a batch simulation.
 * Each result is tagged with the index it was submitted at.
 */
export interface BatchSimulationResult {
  /** Index of this transaction in the input array */
  index: number;
  /** Simulation result — ok or error */
  result: SorokitResult<SimulateTransactionResult>;
}

/**
 * Simulate multiple transaction XDRs concurrently via Promise.allSettled.
 *
 * Independent simulations execute in parallel. Results remain mapped to their
 * source transactions by index. Partial failures do not discard successful
 * results — each outcome is isolated.
 *
 * @param rpcUrl          - Soroban RPC endpoint URL
 * @param networkPassphrase - Network passphrase (e.g. "Test SDF Network ; September 2024")
 * @param transactionXdrs - Array of transaction XDR strings to simulate
 * @param options         - Optional cache and TTL settings
 * @returns Array of results in the same order as inputs, each tagged with its index
 */
export async function simulateTransactionBatch(
  rpcUrl: string,
  networkPassphrase: string,
  transactionXdrs: string[],
  options?: SimulateTransactionOptions,
): Promise<BatchSimulationResult[]> {
  if (transactionXdrs.length === 0) return [];

  const settled = await Promise.allSettled(
    transactionXdrs.map((xdr) =>
      simulateTransaction(rpcUrl, networkPassphrase, xdr, options),
    ),
  );

  return settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return { index, result: outcome.value };
    }
    return {
      index,
      result: err<SimulateTransactionResult>(
        SorokitErrorCode.TX_SIMULATE_FAILED,
        String(outcome.reason),
        outcome.reason,
      ),
    };
  });
}
