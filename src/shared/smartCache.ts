/**
 * Smart caching layer with intelligent invalidation, TTL management, and performance tracking.
 *
 * Provides deterministic cache key generation, data-type specific TTLs,
 * automatic cache invalidation on state-modifying operations, and comprehensive metrics.
 */

import { createInMemoryCache, type SorokitCache } from "./cache";
import type { SorokitLogger } from "./logger";

export type CacheDataType =
  | "account"
  | "contract"
  | "metadata"
  | "transaction"
  | "fee_estimate"
  | "network"
  | "custom";

export interface CacheMetrics {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  hitRate: number; // 0.0 - 1.0
  totalRequests: number;
}

export interface SmartCacheConfig {
  storage?: SorokitCache | undefined;
  defaultTtlMs?: number | undefined;
  ttlByDataType?: Partial<Record<CacheDataType, number>> | undefined;
  logger?: SorokitLogger | undefined;
  enableMetrics?: boolean | undefined;
}

export interface CacheKeyOptions {
  dataType?: CacheDataType | undefined;
  account?: string | undefined;
  contractId?: string | undefined;
  method?: string | undefined;
  params?: Record<string, unknown> | unknown[] | undefined;
}

export interface GetOrSetOptions {
  dataType?: CacheDataType | undefined;
  ttlMs?: number | undefined;
  tags?: string[] | undefined;
}

export interface StateChangeNotification {
  type: "payment" | "contract_call" | "trustline" | "account_update" | "custom";
  affectedAccount?: string | undefined;
  affectedAccounts?: string[] | undefined;
  affectedContractId?: string | undefined;
  affectedContracts?: string[] | undefined;
}

const DEFAULT_TTLS: Record<CacheDataType, number> = {
  account: 30_000,       // 30s
  contract: 60_000,      // 60s
  metadata: 300_000,     // 5m
  transaction: 10_000,   // 10s
  fee_estimate: 15_000,  // 15s
  network: 600_000,      // 10m
  custom: 60_000,        // 60s
};

/**
 * Deterministically generates a hash or normalized string from parameters.
 */
export function hashParams(params: unknown): string {
  if (params === undefined || params === null) return "";
  if (typeof params !== "object") return String(params);

  if (Array.isArray(params)) {
    return `[${params.map((p) => hashParams(p)).join(",")}]`;
  }

  const keys = Object.keys(params as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${k}:${hashParams((params as Record<string, unknown>)[k])}`
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Generate a deterministic cache key for an operation.
 */
export function generateCacheKey(
  operation: string,
  optionsOrParams?: CacheKeyOptions | Record<string, unknown> | unknown[]
): string {
  if (!optionsOrParams) {
    return `sorokit:${operation}`;
  }

  if (
    typeof optionsOrParams === "object" &&
    ("dataType" in optionsOrParams ||
      "account" in optionsOrParams ||
      "contractId" in optionsOrParams ||
      "method" in optionsOrParams)
  ) {
    const opts = optionsOrParams as CacheKeyOptions;
    const parts: string[] = ["sorokit"];
    if (opts.dataType) parts.push(opts.dataType);
    parts.push(operation);
    if (opts.account) parts.push(`acc:${opts.account}`);
    if (opts.contractId) parts.push(`ctr:${opts.contractId}`);
    if (opts.method) parts.push(`fn:${opts.method}`);
    if (opts.params) parts.push(`p:${hashParams(opts.params)}`);
    return parts.join(":");
  }

  return `sorokit:${operation}:${hashParams(optionsOrParams)}`;
}

export class SmartCache {
  private storage: SorokitCache;
  private defaultTtlMs: number;
  private ttlByDataType: Record<CacheDataType, number>;
  private logger?: SorokitLogger | undefined;
  private enableMetrics: boolean;

  // Key tracking by account and contract for targeted invalidation
  private accountKeyMap = new Map<string, Set<string>>();
  private contractKeyMap = new Map<string, Set<string>>();
  private typeKeyMap = new Map<CacheDataType, Set<string>>();

  // Metrics
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private invalidations = 0;

  constructor(config: SmartCacheConfig = {}) {
    this.storage = config.storage ?? createInMemoryCache();
    this.defaultTtlMs = config.defaultTtlMs ?? 60_000;
    this.ttlByDataType = {
      ...DEFAULT_TTLS,
      ...(config.ttlByDataType ?? {}),
    };
    this.logger = config.logger;
    this.enableMetrics = config.enableMetrics ?? true;
  }

  /**
   * Retrieve a value from the cache.
   */
  get<T>(key: string): T | undefined {
    const value = this.storage.get(key) as T | undefined;
    if (this.enableMetrics) {
      if (value !== undefined) {
        this.hits++;
      } else {
        this.misses++;
      }
    }
    return value;
  }

  /**
   * Set a value in the cache with optional TTL or data-type TTL.
   */
  set<T>(
    key: string,
    value: T,
    options?:
      | number
      | {
          ttlMs?: number | undefined;
          dataType?: CacheDataType | undefined;
          account?: string | undefined;
          contractId?: string | undefined;
        }
      | undefined,
  ): void {
    let ttlMs: number | undefined;
    let dataType: CacheDataType | undefined;
    let account: string | undefined;
    let contractId: string | undefined;

    if (typeof options === "number") {
      ttlMs = options;
    } else if (options) {
      ttlMs = options.ttlMs;
      dataType = options.dataType;
      account = options.account;
      contractId = options.contractId;
    }

    if (ttlMs === undefined) {
      if (dataType && this.ttlByDataType[dataType]) {
        ttlMs = this.ttlByDataType[dataType];
      } else {
        ttlMs = this.defaultTtlMs;
      }
    }

    this.storage.set(key, value, ttlMs);
    if (this.enableMetrics) {
      this.sets++;
    }

    // Index key for invalidation
    if (account) {
      if (!this.accountKeyMap.has(account)) this.accountKeyMap.set(account, new Set());
      this.accountKeyMap.get(account)!.add(key);
    }
    if (contractId) {
      if (!this.contractKeyMap.has(contractId)) this.contractKeyMap.set(contractId, new Set());
      this.contractKeyMap.get(contractId)!.add(key);
    }
    if (dataType) {
      if (!this.typeKeyMap.has(dataType)) this.typeKeyMap.set(dataType, new Set());
      this.typeKeyMap.get(dataType)!.add(key);
    }
  }

  /**
   * Get an existing cached value, or compute and cache it if missing.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: GetOrSetOptions
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await fetcher();
    this.set(key, value, {
      ...(options?.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options?.dataType !== undefined ? { dataType: options.dataType } : {}),
    });
    return value;
  }

  /**
   * Invalidate a specific cache key.
   */
  invalidate(key: string): void {
    this.storage.invalidate(key);
    if (this.enableMetrics) {
      this.invalidations++;
    }

    // Cleanup index sets
    for (const set of this.accountKeyMap.values()) set.delete(key);
    for (const set of this.contractKeyMap.values()) set.delete(key);
    for (const set of this.typeKeyMap.values()) set.delete(key);
  }

  /**
   * Invalidate all keys associated with a specific data type.
   */
  invalidateByType(dataType: CacheDataType): void {
    const keys = this.typeKeyMap.get(dataType);
    if (keys) {
      for (const key of Array.from(keys)) {
        this.invalidate(key);
      }
      this.typeKeyMap.delete(dataType);
    }
    // Also wildcard invalidate
    this.storage.invalidate(`sorokit:${dataType}:*`);
  }

  /**
   * Invalidate all cached entries for a given account.
   */
  invalidateForAccount(account: string): void {
    const keys = this.accountKeyMap.get(account);
    if (keys) {
      for (const key of Array.from(keys)) {
        this.invalidate(key);
      }
      this.accountKeyMap.delete(account);
    }
    this.storage.invalidate(`*acc:${account}*`);
    this.storage.invalidate(`*account*${account}*`);
  }

  /**
   * Invalidate all cached entries for a given contract.
   */
  invalidateForContract(contractId: string): void {
    const keys = this.contractKeyMap.get(contractId);
    if (keys) {
      for (const key of Array.from(keys)) {
        this.invalidate(key);
      }
      this.contractKeyMap.delete(contractId);
    }
    this.storage.invalidate(`*ctr:${contractId}*`);
    this.storage.invalidate(`*contract*${contractId}*`);
  }

  /**
   * Notify smart cache of a state-modifying operation to auto-invalidate relevant keys.
   */
  onStateChange(event: StateChangeNotification): void {
    this.logger?.debug("SmartCache state change received", {
      type: event.type,
      ...(event.affectedAccount !== undefined ? { affectedAccount: event.affectedAccount } : {}),
      ...(event.affectedContractId !== undefined ? { affectedContractId: event.affectedContractId } : {}),
    });

    if (event.affectedAccount) {
      this.invalidateForAccount(event.affectedAccount);
    }
    if (event.affectedAccounts) {
      for (const acc of event.affectedAccounts) {
        this.invalidateForAccount(acc);
      }
    }
    if (event.affectedContractId) {
      this.invalidateForContract(event.affectedContractId);
    }
    if (event.affectedContracts) {
      for (const ctr of event.affectedContracts) {
        this.invalidateForContract(ctr);
      }
    }
  }

  /**
   * Retrieve performance metrics.
   */
  getMetrics(): CacheMetrics {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      invalidations: this.invalidations,
      hitRate,
      totalRequests,
    };
  }

  /**
   * Reset performance metrics.
   */
  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.invalidations = 0;
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.storage.clear();
    this.accountKeyMap.clear();
    this.contractKeyMap.clear();
    this.typeKeyMap.clear();
  }
}

/**
 * Factory function to create a SmartCache instance.
 */
export function createSmartCache(config?: SmartCacheConfig): SmartCache {
  return new SmartCache(config);
}
