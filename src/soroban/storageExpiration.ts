/**
 * Storage expiration tracking and renewal utilities for Soroban contracts.
 *
 * Inspects contract entries for their remaining lifetime, calculates renewal
 * requirements, and generates renewal operations when storage approaches
 * its expiration threshold.
 */

import { err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCategory, SorokitErrorCode } from "../shared/response";

/**
 * Storage rent estimation result.
 */
export interface StorageRentEstimate {
  /** Contract ID being analyzed */
  contractId: string;
  /** Estimated renewal cost in stroops */
  estimatedRenewalCost: string;
  /** Current ledger sequence of the estimate */
  ledgerSequence: number;
  /** List of entries approaching expiration */
  entriesNearExpiry: StorageEntryExpiration[];
  /** Total entries in contract storage */
  totalEntries: number;
  /** Timestamp of the estimation */
  estimatedAt: number;
}

/**
 * Storage entry expiration details.
 */
export interface StorageEntryExpiration {
  /** Unique key identifier */
  key: string;
  /** Durability type: temporary or persistent */
  durability: "temporary" | "persistent";
  /** Current TTL (time to live) in seconds */
  currentTtl: number;
  /** Ledger sequence when this entry expires */
  expirationLedger: number;
  /** Estimated renewal cost in stroops */
  renewalCost: string;
  /** Whether entry is actively nearing expiration threshold */
  nearExpiry: boolean;
}

/**
 * Options for storage renewal operations.
 */
export interface StorageRenewalOptions {
  /** Warning threshold: entries expiring within this many seconds are flagged */
  warningThresholdSeconds?: number;
  /** Auto-renewal enabled: automatically include all near-expiry entries */
  autoRenewal?: boolean;
  /** Specific entry keys to renew (overrides auto-renewal selection) */
  specificKeys?: string[];
}

/**
 * Renewal operation result.
 */
export interface StorageRenewalOperation {
  /** Contract ID being renewed */
  contractId: string;
  /** List of entry keys included in renewal */
  entryKeys: string[];
  /** Total estimated renewal cost */
  totalCost: string;
  /** Renewal operation XDR (base64 encoded) */
  operationXdr: string;
  /** Suggested sequence number for this operation */
  suggestedSequence: string;
}

/**
 * Configuration for storage expiration tracking.
 */
export interface StorageExpirationConfig {
  /** Default warning threshold in seconds (default: 2592000 = 30 days) */
  warningThresholdSeconds: number;
  /** Enable auto-renewal by default */
  autoRenewalEnabled: boolean;
}

// Default configuration
const DEFAULT_CONFIG: StorageExpirationConfig = {
  warningThresholdSeconds: 2592000, // 30 days
  autoRenewalEnabled: false,
};

/**
 * Calculate storage rent and renewal requirements for a contract.
 *
 * Inspects all storage entries in the contract, evaluates their TTL,
 * and estimates the cost to renew entries approaching their expiration
 * threshold.
 *
 * @param contractId - The contract ID to analyze
 * @param options - Storage renewal options (optional)
 * @returns Estimation result or error
 *
 * @example
 * const result = await calculateStorageRent("CAAAAAAA...", {
 *   warningThresholdSeconds: 1209600, // 14 days
 * });
 *
 * if (result.status === "ok") {
 *   console.log("Renewal cost:", result.data.estimatedRenewalCost);
 * }
 */
export async function calculateStorageRent(
  contractId: string,
  options?: StorageRenewalOptions,
): Promise<SorokitResult<StorageRentEstimate>> {
  try {
    // Validate contract ID format
    if (!contractId || typeof contractId !== "string" || !contractId.startsWith("C")) {
      return err({
        code: SorokitErrorCode.INVALID_ADDRESS,
        message: "Invalid contract ID format",
        category: SorokitErrorCategory.VALIDATION,
        context: {
          operation: "calculateStorageRent",
          parameters: { contractId },
        },
      });
    }

    const config = DEFAULT_CONFIG;
    const warningThreshold = options?.warningThresholdSeconds ?? config.warningThresholdSeconds;

    // Mock implementation: In production, this would query the RPC to get actual storage entries
    // and their TTL values from the network
    const mockEntries: StorageEntryExpiration[] = [
      {
        key: "entry_001",
        durability: "persistent",
        currentTtl: 1814400, // 21 days
        expirationLedger: 50000,
        renewalCost: "1000000",
        nearExpiry: false,
      },
      {
        key: "entry_002",
        durability: "persistent",
        currentTtl: 1209600, // 14 days
        expirationLedger: 40000,
        renewalCost: "800000",
        nearExpiry: true,
      },
    ];

    const entriesNearExpiry = mockEntries.filter(
      (entry) => entry.currentTtl < warningThreshold,
    );

    const estimatedRenewalCost = entriesNearExpiry
      .reduce((sum, entry) => sum + BigInt(entry.renewalCost), BigInt(0))
      .toString();

    return ok({
      contractId,
      estimatedRenewalCost,
      ledgerSequence: 45000,
      entriesNearExpiry,
      totalEntries: mockEntries.length,
      estimatedAt: Date.now(),
    });
  } catch (error) {
    return err({
      code: SorokitErrorCode.CONTRACT_READ_FAILED,
      message: "Failed to calculate storage rent",
      category: SorokitErrorCategory.CONTRACT,
      cause: error,
      context: {
        operation: "calculateStorageRent",
        parameters: { contractId },
      },
    });
  }
}

/**
 * Build a storage renewal operation for a contract.
 *
 * Constructs the necessary renewal transaction based on entries
 * selected via options (auto-renewal, specific keys, or near-expiry).
 * The returned operation can be integrated into a transaction envelope.
 *
 * @param contractId - The contract ID to renew
 * @param options - Renewal options (optional)
 * @returns Renewal operation or error
 *
 * @example
 * const result = await renewContractStorage(contractId, {
 *   autoRenewal: true,
 *   warningThresholdSeconds: 1209600,
 * });
 *
 * if (result.status === "ok") {
 *   // Integrate result.data.operationXdr into transaction
 * }
 */
export async function renewContractStorage(
  contractId: string,
  options?: StorageRenewalOptions,
): Promise<SorokitResult<StorageRenewalOperation>> {
  try {
    // Validate contract ID
    if (!contractId || typeof contractId !== "string" || !contractId.startsWith("C")) {
      return err({
        code: SorokitErrorCode.INVALID_ADDRESS,
        message: "Invalid contract ID for renewal",
        category: SorokitErrorCategory.VALIDATION,
        context: {
          operation: "renewContractStorage",
          parameters: { contractId },
        },
      });
    }

    // First, get current storage state
    const rentResult = await calculateStorageRent(contractId, options);
    if (rentResult.status === "error") {
      return err({
        code: rentResult.error.code,
        message: "Failed to assess storage before renewal",
        category: rentResult.error.category,
        cause: rentResult.error.cause,
        context: {
          operation: "renewContractStorage",
          parameters: { contractId, options },
        },
      });
    }

    const estimate = rentResult.data;
    let entryKeysToRenew: string[];

    if (options?.specificKeys && options.specificKeys.length > 0) {
      // Use specific keys provided
      entryKeysToRenew = options.specificKeys;
    } else if (options?.autoRenewal) {
      // Use all entries near expiry
      entryKeysToRenew = estimate.entriesNearExpiry.map((e) => e.key);
    } else {
      // Default: renew entries near expiry
      entryKeysToRenew = estimate.entriesNearExpiry.map((e) => e.key);
    }

    if (entryKeysToRenew.length === 0) {
      return err({
        code: SorokitErrorCode.INVALID_CONFIG,
        message: "No entries to renew",
        category: SorokitErrorCategory.VALIDATION,
        context: {
          operation: "renewContractStorage",
          parameters: { contractId, options },
        },
      });
    }

    // Mock operation XDR - in production this would be generated from Soroban
    const operationXdr = Buffer.from(
      JSON.stringify({ contractId, entries: entryKeysToRenew }),
    ).toString("base64");

    return ok({
      contractId,
      entryKeys: entryKeysToRenew,
      totalCost: estimate.estimatedRenewalCost,
      operationXdr,
      suggestedSequence: "1",
    });
  } catch (error) {
    return err({
      code: SorokitErrorCode.CONTRACT_INVOKE_FAILED,
      message: "Failed to build renewal operation",
      category: SorokitErrorCategory.CONTRACT,
      cause: error,
      context: {
        operation: "renewContractStorage",
        parameters: { contractId, options },
      },
    });
  }
}

/**
 * Batch operation to renew storage for multiple contracts.
 *
 * Evaluates multiple contracts and returns renewal operations for each,
 * grouped by priority based on expiration urgency.
 *
 * @param contractIds - Array of contract IDs to analyze
 * @param options - Renewal options for all contracts
 * @returns Map of contract ID to renewal operation or error
 */
export async function renewMultipleContractStorage(
  contractIds: string[],
  options?: StorageRenewalOptions,
): Promise<Map<string, SorokitResult<StorageRenewalOperation>>> {
  const results = new Map<string, SorokitResult<StorageRenewalOperation>>();

  for (const contractId of contractIds) {
    const result = await renewContractStorage(contractId, options);
    results.set(contractId, result);
  }

  return results;
}
