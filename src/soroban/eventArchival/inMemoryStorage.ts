/**
 * In-memory event archive storage implementation.
 *
 * Stores events in memory for testing and development.
 * For production use, implement a persistent storage adapter.
 */

import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type {
  EventArchiveStorage,
  ArchivedContractEvent,
  EventArchiveQuery,
  ArchiveQueryResult,
  EventAggregation,
  StorageStats,
  TimeSeriesBucket,
  EventTypeCount,
} from "./types";

/**
 * In-memory event archive storage.
 *
 * Stores events in a Map with deterministic ordering.
 * Suitable for testing and development only.
 */
export class InMemoryEventArchiveStorage implements EventArchiveStorage {
  private events: Map<string, ArchivedContractEvent> = new Map();
  private eventsByContract: Map<string, Set<string>> = new Map();
  private eventsByType: Map<string, Set<string>> = new Map();

  async store(events: ArchivedContractEvent[]): Promise<SorokitResult<void>> {
    try {
      for (const event of events) {
        // Store event
        this.events.set(event.id, event);

        // Index by contract
        if (!this.eventsByContract.has(event.contractId)) {
          this.eventsByContract.set(event.contractId, new Set());
        }
        this.eventsByContract.get(event.contractId)!.add(event.id);

        // Index by type
        if (!this.eventsByType.has(event.eventType)) {
          this.eventsByType.set(event.eventType, new Set());
        }
        this.eventsByType.get(event.eventType)!.add(event.id);
      }

      return ok(undefined);
    } catch (error) {
      return err(
        SorokitErrorCode.UNKNOWN,
        `Failed to store events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async query(query: EventArchiveQuery): Promise<SorokitResult<ArchiveQueryResult>> {
    try {
      // Get all events as array
      let results = Array.from(this.events.values());

      // Apply filters
      results = this.applyFilters(results, query);

      // Apply sorting
      results = this.applySorting(results, query);

      // Count total before pagination
      const total = results.length;

      // Apply pagination
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      const paginatedResults = results.slice(offset, offset + limit);

      return ok({
        events: paginatedResults,
        pagination: {
          total,
          count: paginatedResults.length,
          offset,
          limit,
          hasMore: offset + paginatedResults.length < total,
        },
      });
    } catch (error) {
      return err(
        SorokitErrorCode.UNKNOWN,
        `Failed to query events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async aggregate(
    query: EventArchiveQuery,
    intervalMs?: number
  ): Promise<SorokitResult<EventAggregation>> {
    try {
      // Get all events
      let results = Array.from(this.events.values());

      // Apply filters
      results = this.applyFilters(results, query);

      // Count by type
      const typeCounts = new Map<string, number>();
      for (const event of results) {
        typeCounts.set(event.eventType, (typeCounts.get(event.eventType) ?? 0) + 1);
      }

      const byType: EventTypeCount[] = Array.from(typeCounts.entries())
        .map(([eventType, count]) => ({ eventType, count }))
        .sort((a, b) => b.count - a.count);

      // Time series aggregation
      let timeSeries: TimeSeriesBucket[] | undefined;
      if (intervalMs && intervalMs > 0) {
        const buckets = new Map<number, ArchivedContractEvent[]>();
        
        for (const event of results) {
          const ts = this.getEventTimestamp(event);
          if (ts !== undefined) {
            const bucket = Math.floor(ts / intervalMs) * intervalMs;
            if (!buckets.has(bucket)) {
              buckets.set(bucket, []);
            }
            buckets.get(bucket)!.push(event);
          }
        }

        timeSeries = Array.from(buckets.entries())
          .map(([timestamp, events]) => ({
            timestamp,
            count: events.length,
            events,
          }))
          .sort((a, b) => a.timestamp - b.timestamp);
      }

      // Calculate rate
      let rate: number | undefined;
      if (results.length >= 2) {
        const timestamps = results
          .map((e) => this.getEventTimestamp(e))
          .filter((ts): ts is number => ts !== undefined)
          .sort((a, b) => a - b);
        
        if (timestamps.length >= 2) {
          const elapsedMs = timestamps[timestamps.length - 1]! - timestamps[0]!;
          rate = elapsedMs > 0 ? results.length / (elapsedMs / 1000) : 0;
        }
      }

      return ok({
        total: results.length,
        byType,
        timeSeries,
        rate,
      });
    } catch (error) {
      return err(
        SorokitErrorCode.UNKNOWN,
        `Failed to aggregate events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(query: EventArchiveQuery): Promise<SorokitResult<number>> {
    try {
      // Get events to delete
      let results = Array.from(this.events.values());
      results = this.applyFilters(results, query);

      // Delete events
      let deletedCount = 0;
      for (const event of results) {
        if (this.events.delete(event.id)) {
          deletedCount++;

          // Remove from contract index
          this.eventsByContract.get(event.contractId)?.delete(event.id);
          if (this.eventsByContract.get(event.contractId)?.size === 0) {
            this.eventsByContract.delete(event.contractId);
          }

          // Remove from type index
          this.eventsByType.get(event.eventType)?.delete(event.id);
          if (this.eventsByType.get(event.eventType)?.size === 0) {
            this.eventsByType.delete(event.eventType);
          }
        }
      }

      return ok(deletedCount);
    } catch (error) {
      return err(
        SorokitErrorCode.UNKNOWN,
        `Failed to delete events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async exists(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async getStats(): Promise<SorokitResult<StorageStats>> {
    try {
      const allEvents = Array.from(this.events.values());
      const timestamps = allEvents
        .map((e) => this.getEventTimestamp(e))
        .filter((ts): ts is number => ts !== undefined);

      return ok({
        totalEvents: this.events.size,
        uniqueContracts: this.eventsByContract.size,
        oldestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
        newestTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
      });
    } catch (error) {
      return err(
        SorokitErrorCode.UNKNOWN,
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Clear all stored events (for testing).
   */
  clear(): void {
    this.events.clear();
    this.eventsByContract.clear();
    this.eventsByType.clear();
  }

  /**
   * Get all events (for testing).
   */
  getAllEvents(): ArchivedContractEvent[] {
    return Array.from(this.events.values());
  }

  private applyFilters(
    events: ArchivedContractEvent[],
    query: EventArchiveQuery
  ): ArchivedContractEvent[] {
    let filtered = events;

    // Filter by contract IDs
    if (query.contractIds && query.contractIds.length > 0) {
      const contractIdSet = new Set(query.contractIds);
      filtered = filtered.filter((e) => contractIdSet.has(e.contractId));
    }

    // Filter by event types
    if (query.eventTypes && query.eventTypes.length > 0) {
      const eventTypeSet = new Set(query.eventTypes);
      filtered = filtered.filter((e) => eventTypeSet.has(e.eventType));
    }

    // Filter by topics
    if (query.topics && query.topics.length > 0) {
      filtered = filtered.filter((event) =>
        event.topics.some((topic) =>
          query.topics!.some((pattern) =>
            pattern instanceof RegExp
              ? pattern.test(topic)
              : pattern === topic
          )
        )
      );
    }

    // Filter by emitter
    if (query.emitter) {
      filtered = filtered.filter((e) => e.emitter === query.emitter);
    }

    // Filter by timestamp range
    if (query.fromTimestamp !== undefined || query.toTimestamp !== undefined) {
      const fromTs = this.normalizeTimestamp(query.fromTimestamp);
      const toTs = this.normalizeTimestamp(query.toTimestamp);

      filtered = filtered.filter((event) => {
        const eventTs = this.getEventTimestamp(event);
        if (eventTs === undefined) return false;
        if (fromTs !== undefined && eventTs < fromTs) return false;
        if (toTs !== undefined && eventTs > toTs) return false;
        return true;
      });
    }

    // Filter by ledger range
    if (query.fromLedger !== undefined || query.toLedger !== undefined) {
      filtered = filtered.filter((event) => {
        if (query.fromLedger !== undefined && event.ledger < query.fromLedger) return false;
        if (query.toLedger !== undefined && event.ledger > query.toLedger) return false;
        return true;
      });
    }

    return filtered;
  }

  private applySorting(
    events: ArchivedContractEvent[],
    query: EventArchiveQuery
  ): ArchivedContractEvent[] {
    const orderBy = query.orderBy ?? "timestamp";
    const order = query.order ?? "desc";
    const multiplier = order === "asc" ? 1 : -1;

    return events.sort((a, b) => {
      let aValue: string | number;
      let bValue: string | number;

      switch (orderBy) {
        case "timestamp": {
          const aTs = this.getEventTimestamp(a) ?? 0;
          const bTs = this.getEventTimestamp(b) ?? 0;
          return (aTs - bTs) * multiplier;
        }
        case "ledger":
          return (a.ledger - b.ledger) * multiplier;
        case "contractId":
          aValue = a.contractId;
          bValue = b.contractId;
          break;
        case "eventType":
          aValue = a.eventType;
          bValue = b.eventType;
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return -1 * multiplier;
      if (aValue > bValue) return 1 * multiplier;
      return 0;
    });
  }

  private getEventTimestamp(event: ArchivedContractEvent): number | undefined {
    if (typeof event.timestamp === "number") {
      return event.timestamp;
    }
    if (typeof event.timestamp === "string") {
      const parsed = Date.parse(event.timestamp);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private normalizeTimestamp(timestamp: string | number | undefined): number | undefined {
    if (timestamp === undefined) return undefined;
    if (typeof timestamp === "number") return timestamp;
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
}
