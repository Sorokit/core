/**
 * Intelligent cache invalidation and TTL management for Sorokit.
 *
 * This module provides smart cache invalidation strategies that track state-modifying
 * operations, listen to Horizon events, and adapt TTLs based on data freshness requirements.
 *
 * Strategies:
 * - "default": Invalidates related cache entries on transaction submission
 * - "smart": Enhanced default with adaptive TTL based on data type and frequency
 * - "aggressive": Invalidates on submission + invalidates on Horizon event confirmation
 */

import type { SorokitCache } from "./cache";
import type { SorokitLogger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InvalidationStrategy = "default" | "smart" | "aggressive";

export interface InvalidationStrategyConfig {
  strategy?: InvalidationStrategy;
  horizonEventPollingIntervalMs?: number;
  adaptiveTtlEnabled?: boolean;
}

/**
 * Data types that can have different invalidation and TTL requirements.
 */
export type DataType =
  | "account"
  | "balance"
  | "trustline"
  | "operations"
  | "effects"
  | "offers"
  | "trades"
  | "contract_read"
  | "contract_metadata"
  | "fee_estimate"
  | "transaction";

/**
 * Adaptive TTL configuration based on data type.
 * Determines how long cached data remains valid before refresh is recommended.
 */
interface AdaptiveTtlConfig {
  baseTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
}

/**
 * Tracks which cache keys are related to which operations and accounts.
 */
export interface CacheKeyMapping {
  account: string[];
  balance: string[];
  trustline: string[];
  operations: string[];
  effects: string[];
  offers: string[];
  trades: string[];
  contractRead: string[];
}

/**
 * Operation that modifies account or contract state.
 */
export interface StateModifyingOperation {
  type: "payment" | "trustline" | "account_merge" | "set_options" | "create_account" | "bump_sequence" | "claim_claimable_balance" | "contract_write";
  affectedAccount?: string;
  affectedAssets?: string[];
  affectedContracts?: string[];
  timestamp: number;
}

/**
 * Horizon event that indicates cache invalidation should occur.
 */
export interface HorizonInvalidationEvent {
  type: "transaction_confirmed" | "account_modified" | "trustline_modified" | "contract_state_changed";
  affectedAccount?: string;
  affectedAssets?: string[];
  affectedContracts?: string[];
  ledgerSequence?: number;
  timestamp: number;
}

/**
 * Configuration for cache invalidation manager.
 */
export interface CacheInvalidationConfig {
  cache: SorokitCache;
  horizonUrl: string;
  strategy?: InvalidationStrategy;
  horizonEventPollingIntervalMs?: number;
  adaptiveTtlEnabled?: boolean;
  logger?: SorokitLogger;
}

/**
 * Statistics about cache invalidation activity.
 */
export interface InvalidationStats {
  totalInvalidations: number;
  invalidationsByStrategy: Record<InvalidationStrategy, number>;
  invalidationsByType: Record<DataType, number>;
  lastInvalidationTime?: number;
  eventPollingActive: boolean;
}

// ─── Adaptive TTL Configuration ───────────────────────────────────────────────

const ADAPTIVE_TTL_CONFIG: Record<DataType, AdaptiveTtlConfig> = {
  account: {
    baseTtlMs: 30_000,        // 30 seconds
    minTtlMs: 5_000,           // 5 seconds
    maxTtlMs: 60_000,          // 1 minute
  },
  balance: {
    baseTtlMs: 30_000,         // 30 seconds
    minTtlMs: 5_000,           // 5 seconds
    maxTtlMs: 60_000,          // 1 minute
  },
  trustline: {
    baseTtlMs: 60_000,         // 1 minute
    minTtlMs: 10_000,          // 10 seconds
    maxTtlMs: 300_000,         // 5 minutes
  },
  operations: {
    baseTtlMs: 60_000,         // 1 minute
    minTtlMs: 30_000,          // 30 seconds
    maxTtlMs: 600_000,         // 10 minutes
  },
  effects: {
    baseTtlMs: 60_000,         // 1 minute
    minTtlMs: 30_000,          // 30 seconds
    maxTtlMs: 600_000,         // 10 minutes
  },
  offers: {
    baseTtlMs: 120_000,        // 2 minutes
    minTtlMs: 30_000,          // 30 seconds
    maxTtlMs: 600_000,         // 10 minutes
  },
  trades: {
    baseTtlMs: 300_000,        // 5 minutes
    minTtlMs: 60_000,          // 1 minute
    maxTtlMs: 1_800_000,       // 30 minutes
  },
  contract_read: {
    baseTtlMs: 60_000,         // 1 minute
    minTtlMs: 10_000,          // 10 seconds
    maxTtlMs: 300_000,         // 5 minutes
  },
  contract_metadata: {
    baseTtlMs: 3_600_000,      // 1 hour
    minTtlMs: 600_000,         // 10 minutes
    maxTtlMs: 7_200_000,       // 2 hours
  },
  fee_estimate: {
    baseTtlMs: 300_000,        // 5 minutes
    minTtlMs: 60_000,          // 1 minute
    maxTtlMs: 600_000,         // 10 minutes
  },
  transaction: {
    baseTtlMs: 300_000,        // 5 minutes
    minTtlMs: 60_000,          // 1 minute
    maxTtlMs: 1_800_000,       // 30 minutes
  },
};

// ─── Cache Key Pattern Matching ───────────────────────────────────────────────

/**
 * Determines which cache keys are affected by a state-modifying operation.
 * This enables targeted invalidation rather than clearing the entire cache.
 */
export function getAffectedCacheKeys(
  operation: StateModifyingOperation,
): CacheKeyMapping {
  const mapping: CacheKeyMapping = {
    account: [],
    balance: [],
    trustline: [],
    operations: [],
    effects: [],
    offers: [],
    trades: [],
    contractRead: [],
  };

  // Account-related operations affect account and balance caches
  if (operation.affectedAccount) {
    const account = operation.affectedAccount;
    mapping.account.push(`account:get:*:${account}`);
    mapping.balance.push(`account:balances:*:${account}`);
    mapping.operations.push(`account:operations:*:${account}`);
    mapping.effects.push(`account:effects:*:${account}`);
    mapping.offers.push(`account:offers:*:${account}`);
    mapping.trades.push(`account:trades:*:${account}`);

    // Asset-specific balance invalidation
    if (operation.affectedAssets) {
      for (const asset of operation.affectedAssets) {
        mapping.balance.push(`account:assetBalances:*:${account}:*${asset}*`);
      }
    }

    // Trustline modifications affect trustline cache
    if (operation.type === "trustline") {
      mapping.trustline.push(`account:trustlines:*:${account}`);
      if (operation.affectedAssets) {
        for (const asset of operation.affectedAssets) {
          mapping.trustline.push(`trustline:*:${account}:${asset}`);
        }
      }
    }
  }

  // Contract write operations affect contract read caches
  if (operation.affectedContracts) {
    for (const contract of operation.affectedContracts) {
      mapping.contractRead.push(`sorokit:contract-read:${contract}:*`);
    }
  }

  return mapping;
}

/**
 * Creates a regex pattern matcher for cache keys affected by an operation.
 * Used with cache.invalidateByPrefix or custom invalidation logic.
 */
export function createInvalidationPattern(dataType: DataType, account?: string): RegExp {
  const patterns: Record<DataType, (account?: string) => string> = {
    account: (acc) => `^account:get:.*:${acc}$`,
    balance: (acc) => `^account:balances:.*:${acc}$`,
    trustline: (acc) => `^(trustline|account:trustlines):.*:${acc}`,
    operations: (acc) => `^account:operations:.*:${acc}$`,
    effects: (acc) => `^account:effects:.*:${acc}$`,
    offers: (acc) => `^account:offers:.*:${acc}$`,
    trades: (acc) => `^account:trades:.*:${acc}$`,
    contract_read: () => `^sorokit:contract-read:`,
    contract_metadata: () => `^sorokit:contract-metadata:`,
    fee_estimate: () => `^fee:estimate:`,
    transaction: () => `^tx:`,
  };

  const pattern = patterns[dataType]?.(account) || "";
  return new RegExp(pattern);
}

// ─── Adaptive TTL Management ──────────────────────────────────────────────────

/**
 * Calculates an adaptive TTL based on data type and optional frequency hint.
 * Can shorten TTL for frequently-accessed data or lengthen for stable data.
 *
 * @param dataType The type of data being cached
 * @param frequencyHint Optional hint about access patterns (0-1, where 1 is high frequency)
 * @returns TTL in milliseconds
 */
export function calculateAdaptiveTtl(
  dataType: DataType,
  frequencyHint?: number,
): number {
  const config = ADAPTIVE_TTL_CONFIG[dataType];
  if (!config) return 60_000; // Fallback to 1 minute

  if (frequencyHint === undefined || frequencyHint <= 0) {
    return config.baseTtlMs;
  }

  // High frequency data gets shorter TTL for freshness
  // Low frequency data gets longer TTL to reduce redundant fetches
  const adjustedTtl = config.baseTtlMs * (1 - frequencyHint * 0.5);
  return Math.max(config.minTtlMs, Math.min(config.maxTtlMs, Math.floor(adjustedTtl)));
}

/**
 * Gets the recommended TTL for a data type without adaptive adjustment.
 */
export function getBaseTtl(dataType: DataType): number {
  return ADAPTIVE_TTL_CONFIG[dataType]?.baseTtlMs ?? 60_000;
}

// ─── Cache Invalidation Manager ───────────────────────────────────────────────

/**
 * Manages intelligent cache invalidation with support for multiple strategies.
 * Handles both operation-based and event-based invalidation.
 */
export class CacheInvalidationManager {
  private cache: SorokitCache;
  private horizonUrl: string;
  private strategy: InvalidationStrategy;
  private adaptiveTtlEnabled: boolean;
  private logger: SorokitLogger | undefined;
  private stats: InvalidationStats;
  private eventPollingIntervals: Map<string, NodeJS.Timeout>;
  private operationQueue: StateModifyingOperation[];

  constructor(config: CacheInvalidationConfig) {
    this.cache = config.cache;
    this.horizonUrl = config.horizonUrl;
    this.strategy = config.strategy ?? "smart";
    this.adaptiveTtlEnabled = config.adaptiveTtlEnabled ?? true;
    this.logger = config.logger;
    this.eventPollingIntervals = new Map();
    this.operationQueue = [];
    this.stats = {
      totalInvalidations: 0,
      invalidationsByStrategy: {
        default: 0,
        smart: 0,
        aggressive: 0,
      },
      invalidationsByType: {
        account: 0,
        balance: 0,
        trustline: 0,
        operations: 0,
        effects: 0,
        offers: 0,
        trades: 0,
        contract_read: 0,
        contract_metadata: 0,
        fee_estimate: 0,
        transaction: 0,
      },
      eventPollingActive: false,
    };
  }

  /**
   * Invalidates cache after a state-modifying operation.
   * Strategy determines scope and timing of invalidation.
   */
  public invalidateAfterOperation(
    operation: StateModifyingOperation,
  ): void {
    this.operationQueue.push(operation);

    switch (this.strategy) {
      case "aggressive":
        // Aggressive: invalidate immediately + queue for event confirmation
        this.performInvalidation(operation);
        break;
      case "smart":
        // Smart: invalidate after a small delay to batch multiple operations
        this.scheduleInvalidation(operation);
        break;
      case "default":
      default:
        // Default: invalidate immediately
        this.performInvalidation(operation);
        break;
    }
  }

  /**
   * Invalidates cache based on a Horizon event (transaction confirmation).
   * Used with "aggressive" strategy for real-time cache freshness.
   */
  public invalidateAfterEvent(event: HorizonInvalidationEvent): void {
    this.logger?.debug("cache.invalidation.event", {
      type: event.type,
      account: event.affectedAccount,
      ledger: event.ledgerSequence,
    });

    const keys = this.getAffectedKeysFromEvent(event);
    this.invalidateCacheKeys(keys);

    this.stats.totalInvalidations++;
    this.stats.lastInvalidationTime = Date.now();
  }

  /**
   * Starts listening to Horizon events for real-time cache invalidation.
   * Only effective with "aggressive" strategy.
   */
  public startHorizonEventListening(
    account?: string,
    pollingIntervalMs?: number,
  ): void {
    if (this.strategy !== "aggressive") {
      this.logger?.debug("cache.invalidation.horizon_listening_disabled", {
        reason: "strategy is not aggressive",
      });
      return;
    }

    const interval = pollingIntervalMs ?? 5_000;
    const listenerKey = account ?? "global";

    // Prevent duplicate listeners
    if (this.eventPollingIntervals.has(listenerKey)) {
      return;
    }

    this.logger?.debug("cache.invalidation.horizon_listening_started", {
      account,
      interval,
    });

    this.stats.eventPollingActive = true;

    // Note: Actual Horizon event polling would be implemented here.
    // This is a placeholder that should be integrated with subscribeContractEvents
    // or a similar event subscription mechanism in a real implementation.
  }

  /**
   * Stops listening to Horizon events.
   */
  public stopHorizonEventListening(account?: string): void {
    const listenerKey = account ?? "global";
    const timeout = this.eventPollingIntervals.get(listenerKey);
    if (timeout) {
      clearInterval(timeout);
      this.eventPollingIntervals.delete(listenerKey);
      this.logger?.debug("cache.invalidation.horizon_listening_stopped", {
        account,
      });
    }
    if (this.eventPollingIntervals.size === 0) {
      this.stats.eventPollingActive = false;
    }
  }

  /**
   * Manually invalidates specific cache keys.
   */
  public invalidateCacheKeys(keys: string[]): void {
    for (const key of keys) {
      this.cache.invalidate(key);
    }
    this.stats.totalInvalidations += keys.length;
    this.stats.lastInvalidationTime = Date.now();
    this.logger?.debug("cache.invalidation.keys_invalidated", {
      count: keys.length,
    });
  }

  /**
   * Manually invalidates cache by prefix pattern.
   */
  public invalidateCachePrefix(prefix: string): void {
    if (this.cache.invalidateByPrefix) {
      this.cache.invalidateByPrefix(prefix);
      this.logger?.debug("cache.invalidation.prefix_invalidated", { prefix });
    }
  }

  /**
   * Gets current invalidation statistics.
   */
  public getStats(): InvalidationStats {
    return { ...this.stats };
  }

  /**
   * Resets invalidation statistics.
   */
  public resetStats(): void {
    this.stats = {
      totalInvalidations: 0,
      invalidationsByStrategy: {
        default: 0,
        smart: 0,
        aggressive: 0,
      },
      invalidationsByType: {
        account: 0,
        balance: 0,
        trustline: 0,
        operations: 0,
        effects: 0,
        offers: 0,
        trades: 0,
        contract_read: 0,
        contract_metadata: 0,
        fee_estimate: 0,
        transaction: 0,
      },
      eventPollingActive: false,
    };
  }

  /**
   * Sets the invalidation strategy at runtime.
   */
  public setStrategy(strategy: InvalidationStrategy): void {
    this.strategy = strategy;
    this.logger?.debug("cache.invalidation.strategy_changed", { strategy });
  }

  /**
   * Clears all pending operations and stops all background tasks.
   */
  public shutdown(): void {
    this.operationQueue = [];
    for (const timeout of this.eventPollingIntervals.values()) {
      clearInterval(timeout);
    }
    this.eventPollingIntervals.clear();
    this.stats.eventPollingActive = false;
    this.logger?.debug("cache.invalidation.shutdown");
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private performInvalidation(operation: StateModifyingOperation): void {
    const affectedKeys = getAffectedCacheKeys(operation);
    const keysByType = this.flattenAffectedKeys(affectedKeys);

    for (const [dataType, keys] of Object.entries(keysByType)) {
      for (const key of keys) {
        this.cache.invalidate(key);
      }
      this.stats.invalidationsByType[dataType as DataType]++;
    }

    this.stats.totalInvalidations++;
    this.stats.invalidationsByStrategy[this.strategy]++;
    this.stats.lastInvalidationTime = Date.now();

    this.logger?.debug("cache.invalidation.performed", {
      operation: operation.type,
      keysInvalidated: keysByType,
    });
  }

  private scheduleInvalidation(operation: StateModifyingOperation): void {
    // Batch multiple operations within a short window (100ms)
    // to avoid redundant invalidations
    if (this.operationQueue.length === 1) {
      setTimeout(() => {
        const operations = [...this.operationQueue];
        this.operationQueue = [];
        for (const op of operations) {
          this.performInvalidation(op);
        }
      }, 100);
    }
  }

  private getAffectedKeysFromEvent(event: HorizonInvalidationEvent): string[] {
    const keys: string[] = [];

    switch (event.type) {
      case "transaction_confirmed":
      case "account_modified":
        if (event.affectedAccount) {
          keys.push(`account:get:*:${event.affectedAccount}`);
          keys.push(`account:balances:*:${event.affectedAccount}`);
          keys.push(`account:operations:*:${event.affectedAccount}`);
          keys.push(`account:effects:*:${event.affectedAccount}`);
        }
        break;

      case "trustline_modified":
        if (event.affectedAccount) {
          keys.push(`account:trustlines:*:${event.affectedAccount}`);
          if (event.affectedAssets) {
            for (const asset of event.affectedAssets) {
              keys.push(`trustline:*:${event.affectedAccount}:${asset}`);
            }
          }
        }
        break;

      case "contract_state_changed":
        if (event.affectedContracts) {
          for (const contract of event.affectedContracts) {
            keys.push(`sorokit:contract-read:${contract}:*`);
          }
        }
        break;
    }

    return keys;
  }

  private flattenAffectedKeys(
    mapping: CacheKeyMapping,
  ): Record<string, string[]> {
    return {
      account: mapping.account,
      balance: mapping.balance,
      trustline: mapping.trustline,
      operations: mapping.operations,
      effects: mapping.effects,
      offers: mapping.offers,
      trades: mapping.trades,
      contract_read: mapping.contractRead,
      contract_metadata: [],
      fee_estimate: [],
      transaction: [],
    };
  }
}

// ─── Factory and Convenience Functions ────────────────────────────────────────

/**
 * Creates a cache invalidation manager with default configuration.
 */
export function createCacheInvalidationManager(
  config: CacheInvalidationConfig,
): CacheInvalidationManager {
  return new CacheInvalidationManager(config);
}

/**
 * Utility to invalidate account-related caches after a transaction.
 * Useful for manual invalidation when automatic invalidation is not enabled.
 */
export function invalidateAccountCachesForTransaction(
  cache: SorokitCache,
  publicKey: string,
): void {
  const keys = [
    `account:get:*:${publicKey}`,
    `account:balances:*:${publicKey}`,
    `account:operations:*:${publicKey}`,
    `account:effects:*:${publicKey}`,
    `account:offers:*:${publicKey}`,
    `account:trades:*:${publicKey}`,
  ];

  for (const key of keys) {
    cache.invalidate(key);
  }
}
