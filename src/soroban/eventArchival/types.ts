/**
 * Contract event archival types.
 *
 * Defines storage adapters, query interfaces, and persistence models
 * for long-term contract event analytics.
 */

import type { SorokitResult } from "../../shared/response";
import type { ContractEvent, ContractEventFilter } from "../subscribeContractEvents";

/**
 * Normalized archived contract event record.
 *
 * Retains all essential event data for historical queries and analytics.
 */
export interface ArchivedContractEvent {
  /** Unique event identifier */
  id: string;
  /** Contract address that emitted the event */
  contractId: string;
  /** Event type/name */
  eventType: string;
  /** Event topics (indexed parameters) */
  topics: string[];
  /** Event value/data payload */
  value: unknown;
  /** Ledger sequence number */
  ledger: number;
  /** Event timestamp (ISO 8601 or Unix ms) */
  timestamp: string | number;
  /** Transaction hash that included this event */
  transactionHash?: string;
  /** Source account that triggered the event */
  emitter?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Query filters for archived contract events.
 */
export interface EventArchiveQuery {
  /** Filter by contract ID(s) */
  contractIds?: string[];
  /** Filter by event type(s) */
  eventTypes?: string[];
  /** Filter by topic patterns */
  topics?: Array<string | RegExp>;
  /** Start time (ISO 8601 or Unix ms) */
  fromTimestamp?: string | number;
  /** End time (ISO 8601 or Unix ms) */
  toTimestamp?: string | number;
  /** Start ledger sequence */
  fromLedger?: number;
  /** End ledger sequence */
  toLedger?: number;
  /** Source account filter */
  emitter?: string;
  /** Maximum number of results */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Sort order */
  order?: "asc" | "desc";
  /** Sort field */
  orderBy?: "timestamp" | "ledger" | "contractId" | "eventType";
}

/**
 * Pagination information for query results.
 */
export interface PaginationInfo {
  /** Total number of results matching the query */
  total: number;
  /** Number of results returned in this page */
  count: number;
  /** Current page offset */
  offset: number;
  /** Maximum results per page */
  limit: number;
  /** Whether more results are available */
  hasMore: boolean;
}

/**
 * Query result with pagination.
 */
export interface ArchiveQueryResult {
  /** Archived events matching the query */
  events: ArchivedContractEvent[];
  /** Pagination information */
  pagination: PaginationInfo;
}

/**
 * Time series aggregation bucket.
 */
export interface TimeSeriesBucket {
  /** Bucket timestamp (start of interval) */
  timestamp: number;
  /** Event count in this bucket */
  count: number;
  /** Events in this bucket (optional) */
  events?: ArchivedContractEvent[];
}

/**
 * Event count aggregation by type.
 */
export interface EventTypeCount {
  /** Event type */
  eventType: string;
  /** Number of events of this type */
  count: number;
}

/**
 * Aggregation result.
 */
export interface EventAggregation {
  /** Total events */
  total: number;
  /** Counts by event type */
  byType: EventTypeCount[];
  /** Time series buckets (if requested) */
  timeSeries?: TimeSeriesBucket[];
  /** Average events per time unit */
  rate?: number;
}

/**
 * Storage adapter for persisting archived events.
 *
 * Implementations can use any storage backend (database, object storage, etc).
 * The adapter is responsible for serialization, deduplication, and retrieval.
 */
export interface EventArchiveStorage {
  /**
   * Persist one or more contract events.
   *
   * @param events - Events to archive
   * @returns Success or error
   */
  store(events: ArchivedContractEvent[]): Promise<SorokitResult<void>>;

  /**
   * Query archived events with filters and pagination.
   *
   * @param query - Query filters and pagination options
   * @returns Query results with pagination info
   */
  query(query: EventArchiveQuery): Promise<SorokitResult<ArchiveQueryResult>>;

  /**
   * Get aggregated event statistics.
   *
   * @param query - Query filters
   * @param intervalMs - Time series interval (optional)
   * @returns Aggregated statistics
   */
  aggregate(query: EventArchiveQuery, intervalMs?: number): Promise<SorokitResult<EventAggregation>>;

  /**
   * Delete archived events matching the query.
   *
   * @param query - Query filters
   * @returns Number of deleted events
   */
  delete(query: EventArchiveQuery): Promise<SorokitResult<number>>;

  /**
   * Check if an event has already been archived.
   *
   * @param eventId - Event identifier
   * @returns True if event exists
   */
  exists(eventId: string): Promise<boolean>;

  /**
   * Get storage statistics.
   *
   * @returns Storage stats
   */
  getStats(): Promise<SorokitResult<StorageStats>>;
}

/**
 * Storage statistics.
 */
export interface StorageStats {
  /** Total number of archived events */
  totalEvents: number;
  /** Number of unique contracts */
  uniqueContracts: number;
  /** Oldest event timestamp */
  oldestTimestamp?: number;
  /** Newest event timestamp */
  newestTimestamp?: number;
  /** Storage size in bytes (if available) */
  storageSizeBytes?: number;
}

/**
 * Options for event archival.
 */
export interface EventArchivalOptions {
  /** Storage adapter to use */
  storage: EventArchiveStorage;
  /** Batch size for archival operations */
  batchSize?: number;
  /** Whether to deduplicate events before storing */
  deduplicate?: boolean;
  /** Error handler for storage failures */
  onStorageError?: (error: Error, events: ArchivedContractEvent[]) => void;
}

/**
 * Event archival subscription result.
 */
export interface EventArchivalSubscription {
  /** Stop archiving events */
  unsubscribe: () => void;
  /** Get archival statistics */
  getStats: () => ArchivalStats;
}

/**
 * Archival statistics.
 */
export interface ArchivalStats {
  /** Number of events archived */
  archivedCount: number;
  /** Number of duplicate events skipped */
  duplicateCount: number;
  /** Number of storage errors encountered */
  errorCount: number;
  /** Last archival timestamp */
  lastArchivedAt?: number;
}
