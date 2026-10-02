/**
 * Contract Event Filter and Aggregation Engine
 *
 * Provides filtering, time-window grouping, and aggregation capabilities
 * for contract event streams with a chainable API.
 */

import type { ContractEvent } from "./subscribeContractEvents";
import { xdr } from "@stellar/stellar-sdk";
import { createSorobanServer } from "../shared/serverFactory";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { decodeContractValue } from "./contractEncoding";
import { streamContractEventsRealTime } from "./streamContractEventsRealTime";
import type { StreamContractEventsRealTimeOptions } from "./streamContractEventsRealTime";

/**
 * Time interval for grouping.
 */
export type TimeInterval = "minute" | "hour" | "day" | "week" | "month";

/**
 * Event filter predicate.
 */
export type EventPredicate = (event: ContractEvent) => boolean;

/**
 * Aggregated metrics for events.
 */
export interface EventMetrics {
  /** Total count */
  count: number;
  /** Sum of numeric values */
  sum?: number;
  /** Average of numeric values */
  avg?: number;
  /** Minimum numeric value */
  min?: number;
  /** Maximum numeric value */
  max?: number;
}

/**
 * Event type distribution.
 */
export interface EventTypeDistribution {
  [eventType: string]: number;
}

/**
 * Time-grouped events.
 */
export interface TimeGroupedEvents {
  [timeKey: string]: ContractEvent[];
}

/**
 * Time-grouped metrics.
 */
export interface TimeGroupedMetrics {
  [timeKey: string]: EventMetrics;
}

export interface ContractEventAnalyticsFilter {
  topic?: string | string[];
  data?: Record<string, unknown>;
  ledgerRange?: [number, number];
  timestampRange?: [number | string, number | string];
}

export type ContractEventLoader = (
  contractId: string,
  filter: ContractEventAnalyticsFilter,
) => Promise<ContractEvent[]>;

export interface EventAnalyticsOptions {
  rpcUrl?: string;
  loadEvents?: ContractEventLoader;
  streamOptions?: Omit<StreamContractEventsRealTimeOptions, "rpcUrl">;
}

export interface EventAggregate {
  count: number;
  sum?: number;
  average?: number;
}

export type EventGroupBy = string | ((event: ContractEvent) => string);

/**
 * Contract Event Analytics Engine
 *
 * Provides chainable API for filtering, grouping, and aggregating events.
 */
export class EventAnalytics {
  private events: ContractEvent[] = [];
  private filters: EventPredicate[] = [];

  /**
   * Create a new EventAnalytics instance.
   *
   * @param events - Initial events to analyze
   */
  constructor(events: ContractEvent[] = []) {
    this.events = [...events];
  }

  /**
   * Add events to the analytics engine.
   *
   * @param events - Events to add
   * @returns The analytics instance for chaining
   */
  addEvents(events: ContractEvent[]): EventAnalytics {
    this.events.push(...events);
    return this;
  }

  /**
   * Set the events to analyze (replaces existing events).
   *
   * @param events - Events to set
   * @returns The analytics instance for chaining
   */
  setEvents(events: ContractEvent[]): EventAnalytics {
    this.events = [...events];
    this.filters = [];
    return this;
  }

  /**
   * Filter events by a predicate.
   *
   * @param predicate - Filter function
   * @returns The analytics instance for chaining
   */
  filter(predicate: EventPredicate): EventAnalytics {
    this.filters.push(predicate);
    return this;
  }

  /**
   * Filter events by type.
   *
   * @param eventType - Event type to filter by
   * @returns The analytics instance for chaining
   */
  filterByType(eventType: string): EventAnalytics {
    return this.filter((event) => 
      event.eventType === eventType || event.name === eventType
    );
  }

  /**
   * Filter events by contract ID.
   *
   * @param contractId - Contract ID to filter by
   * @returns The analytics instance for chaining
   */
  filterByContract(contractId: string): EventAnalytics {
    return this.filter((event) => 
      event.contractId === contractId || event.contract_id === contractId
    );
  }

  /**
   * Filter events by emitter account.
   *
   * @param emitter - Emitter address to filter by
   * @returns The analytics instance for chaining
   */
  filterByEmitter(emitter: string): EventAnalytics {
    return this.filter((event) => event.emitter === emitter);
  }

  /**
   * Filter events by amount range (if event has a numeric value).
   *
   * @param min - Minimum value (inclusive)
   * @param max - Maximum value (inclusive)
   * @returns The analytics instance for chaining
   */
  filterByAmountRange(min: number, max: number): EventAnalytics {
    return this.filter((event) => {
      const value = this.extractNumericValue(event);
      return value !== undefined && value >= min && value <= max;
    });
  }

  /**
   * Filter events by time range.
   *
   * @param startTime - Start timestamp (ISO string or number)
   * @param endTime - End timestamp (ISO string or number)
   * @returns The analytics instance for chaining
   */
  filterByTimeRange(startTime: string | number, endTime: string | number): EventAnalytics {
    const start = typeof startTime === "string" ? new Date(startTime).getTime() : startTime;
    const end = typeof endTime === "string" ? new Date(endTime).getTime() : endTime;

    return this.filter((event) => {
      const timestamp = this.extractTimestamp(event);
      return timestamp !== undefined && timestamp >= start && timestamp <= end;
    });
  }

  /**
   * Filter events by ledger range.
   *
   * @param minLedger - Minimum ledger number
   * @param maxLedger - Maximum ledger number
   * @returns The analytics instance for chaining
   */
  filterByLedgerRange(minLedger: number, maxLedger: number): EventAnalytics {
    return this.filter((event) => 
      event.ledger !== undefined && event.ledger >= minLedger && event.ledger <= maxLedger
    );
  }

  /**
   * Group events by time interval.
   *
   * @param interval - Time interval for grouping
   * @returns Object with time keys and event arrays
   */
  groupByTime(interval: TimeInterval): TimeGroupedEvents {
    const filtered = this.applyFilters();
    const grouped: TimeGroupedEvents = {};

    for (const event of filtered) {
      const timestamp = this.extractTimestamp(event);
      if (timestamp === undefined) continue;

      const timeKey = this.getTimeKey(timestamp, interval);
      if (!grouped[timeKey]) {
        grouped[timeKey] = [];
      }
      grouped[timeKey].push(event);
    }

    return grouped;
  }

  /**
   * Group events by time interval and count.
   *
   * @param interval - Time interval for grouping
   * @returns Object with time keys and event counts
   */
  groupByTimeAndCount(interval: TimeInterval): Record<string, number> {
    const grouped = this.groupByTime(interval);
    const counts: Record<string, number> = {};

    for (const [key, events] of Object.entries(grouped)) {
      counts[key] = events.length;
    }

    return counts;
  }

  /**
   * Count events by type.
   *
   * @returns Object with event types as keys and counts as values
   */
  countByType(): EventTypeDistribution {
    const filtered = this.applyFilters();
    const distribution: EventTypeDistribution = {};

    for (const event of filtered) {
      const type = event.eventType || event.name || "unknown";
      distribution[type] = (distribution[type] || 0) + 1;
    }

    return distribution;
  }

  /**
   * Count events by contract.
   *
   * @returns Object with contract IDs as keys and counts as values
   */
  countByContract(): Record<string, number> {
    const filtered = this.applyFilters();
    const counts: Record<string, number> = {};

    for (const event of filtered) {
      const contractId = event.contractId || event.contract_id || "unknown";
      counts[contractId] = (counts[contractId] || 0) + 1;
    }

    return counts;
  }

  /**
   * Count events by emitter.
   *
   * @returns Object with emitter addresses as keys and counts as values
   */
  countByEmitter(): Record<string, number> {
    const filtered = this.applyFilters();
    const counts: Record<string, number> = {};

    for (const event of filtered) {
      const emitter = event.emitter || "unknown";
      counts[emitter] = (counts[emitter] || 0) + 1;
    }

    return counts;
  }

  /**
   * Aggregate metrics for events.
   *
   * @param valueField - Field name to extract numeric value from (default: "value")
   * @returns Aggregated metrics
   */
  aggregateMetrics(valueField: string = "value"): EventMetrics {
    const filtered = this.applyFilters();
    const values: number[] = [];

    for (const event of filtered) {
      const value = this.extractNumericValue(event, valueField);
      if (value !== undefined) {
        values.push(value);
      }
    }

    if (values.length === 0) {
      return { count: filtered.length };
    }

    const sum = values.reduce((acc, val) => acc + val, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    return {
      count: filtered.length,
      sum,
      avg,
      min,
      max,
    };
  }

  /**
   * Aggregate metrics grouped by time interval.
   *
   * @param interval - Time interval for grouping
   * @param valueField - Field name to extract numeric value from (default: "value")
   * @returns Object with time keys and aggregated metrics
   */
  aggregateMetricsByTime(
    interval: TimeInterval,
    valueField: string = "value",
  ): TimeGroupedMetrics {
    const grouped = this.groupByTime(interval);
    const metrics: TimeGroupedMetrics = {};

    for (const [timeKey, events] of Object.entries(grouped)) {
      const values: number[] = [];

      for (const event of events) {
        const value = this.extractNumericValue(event, valueField);
        if (value !== undefined) {
          values.push(value);
        }
      }

      if (values.length === 0) {
        metrics[timeKey] = { count: events.length };
        continue;
      }

      const sum = values.reduce((acc, val) => acc + val, 0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);

      metrics[timeKey] = {
        count: events.length,
        sum,
        avg,
        min,
        max,
      };
    }

    return metrics;
  }

  /**
   * Get the filtered events.
   *
   * @returns Filtered events array
   */
  getEvents(): ContractEvent[] {
    return this.applyFilters();
  }

  /**
   * Get the count of filtered events.
   *
   * @returns Number of filtered events
   */
  count(): number {
    return this.applyFilters().length;
  }

  /**
   * Reset all filters.
   *
   * @returns The analytics instance for chaining
   */
  resetFilters(): EventAnalytics {
    this.filters = [];
    return this;
  }

  /**
   * Clear all events and filters.
   *
   * @returns The analytics instance for chaining
   */
  clear(): EventAnalytics {
    this.events = [];
    this.filters = [];
    return this;
  }

  /**
   * Apply all filters to the events.
   *
   * @returns Filtered events
   */
  private applyFilters(): ContractEvent[] {
    return this.events.filter((event) => 
      this.filters.every((filter) => filter(event))
    );
  }

  /**
   * Extract numeric value from an event.
   *
   * @param event - Event to extract value from
   * @param field - Field name to extract
   * @returns Numeric value or undefined
   */
  private extractNumericValue(event: ContractEvent, field: string = "value"): number | undefined {
    const value = event[field];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  /**
   * Extract timestamp from an event.
   *
   * @param event - Event to extract timestamp from
   * @returns Timestamp in milliseconds or undefined
   */
  private extractTimestamp(event: ContractEvent): number | undefined {
    if (typeof event.timestamp === "number") return event.timestamp;
    if (typeof event.timestamp === "string") {
      const parsed = new Date(event.timestamp).getTime();
      return isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  /**
   * Get time key for grouping based on interval.
   *
   * @param timestamp - Timestamp in milliseconds
   * @param interval - Time interval
   * @returns Time key string
   */
  private getTimeKey(timestamp: number, interval: TimeInterval): string {
    const date = new Date(timestamp);

    switch (interval) {
      case "minute":
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      case "hour":
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:00`;
      case "day":
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      case "week":
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
      case "month":
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      default:
        return String(timestamp);
    }
  }
}

/**
 * Convenience function to filter events.
 *
 * @param events - Events to filter
 * @param predicate - Filter predicate
 * @returns Filtered events
 */
export function filterEvents(
  events: ContractEvent[],
  predicate: EventPredicate,
): ContractEvent[];
export function filterEvents(
  contractId: string,
  filters: ContractEventAnalyticsFilter,
  options: EventAnalyticsOptions,
): Promise<SorokitResult<ContractEvent[]>>;
export function filterEvents(
  eventsOrContractId: ContractEvent[] | string,
  predicateOrFilters: EventPredicate | ContractEventAnalyticsFilter,
  options?: EventAnalyticsOptions,
): ContractEvent[] | Promise<SorokitResult<ContractEvent[]>> {
  if (Array.isArray(eventsOrContractId)) {
    const analytics = new EventAnalytics(eventsOrContractId);
    return analytics.filter(predicateOrFilters as EventPredicate).getEvents();
  }
  return loadAndFilterEvents(
    eventsOrContractId,
    predicateOrFilters as ContractEventAnalyticsFilter,
    options ?? {},
  );
}

function normalizedTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function decodeEventValue(value: unknown): unknown {
  if (value instanceof xdr.ScVal) return decodeContractValue(value);
  if (typeof value === "string") {
    try {
      return decodeContractValue(xdr.ScVal.fromXDR(value, "base64"));
    } catch {
      return value;
    }
  }
  return value;
}

function eventTopicValues(event: ContractEvent): string[] {
  return (event.topics ?? event.topic ?? []).filter(
    (topic): topic is string => typeof topic === "string",
  );
}

function matchesAnalyticsFilter(
  event: ContractEvent,
  filter: ContractEventAnalyticsFilter,
): boolean {
  const requestedTopics = filter.topic === undefined
    ? []
    : Array.isArray(filter.topic) ? filter.topic : [filter.topic];
  if (requestedTopics.length > 0) {
    const topics = eventTopicValues(event).map((topic) => {
      try {
        const decoded = decodeContractValue(xdr.ScVal.fromXDR(topic, "base64"));
        return typeof decoded === "string" ? decoded : topic;
      } catch {
        return topic;
      }
    });
    if (!requestedTopics.some((requested) => topics.includes(requested))) return false;
  }

  if (filter.ledgerRange) {
    const [from, to] = filter.ledgerRange;
    if (event.ledger === undefined || event.ledger < from || event.ledger > to) return false;
  }
  if (filter.timestampRange) {
    const [fromValue, toValue] = filter.timestampRange;
    const from = normalizedTimestamp(fromValue);
    const to = normalizedTimestamp(toValue);
    const timestamp = normalizedTimestamp(event.timestamp);
    if (from === undefined || to === undefined || timestamp === undefined || timestamp < from || timestamp > to) {
      return false;
    }
  }
  if (filter.data) {
    const rawData = (event as ContractEvent & { data?: unknown }).data ?? event.value;
    const data = decodeEventValue(rawData);
    if (typeof data !== "object" || data === null) return false;
    for (const [key, expected] of Object.entries(filter.data)) {
      if (!Object.is((data as Record<string, unknown>)[key], expected)) return false;
    }
  }
  return true;
}

async function loadRpcEvents(
  contractId: string,
  filter: ContractEventAnalyticsFilter,
  rpcUrl: string,
): Promise<ContractEvent[]> {
  const server = createSorobanServer(rpcUrl) as unknown as {
    getEvents: (request: Record<string, unknown>) => Promise<{
      events: Array<Record<string, any>>;
      cursor?: string;
    }>;
  };
  const events: ContractEvent[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  do {
    const response = await server.getEvents({
      filters: [{ type: "contract", contractIds: [contractId] }],
      ...(filter.ledgerRange ? { startLedger: filter.ledgerRange[0], endLedger: filter.ledgerRange[1] } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    for (const event of response.events ?? []) {
      const topics = Array.isArray(event.topic)
        ? event.topic.map((topic: unknown) => topic instanceof xdr.ScVal ? topic.toXDR("base64") : String(topic))
        : [];
      const value = event.value instanceof xdr.ScVal ? event.value.toXDR("base64") : event.value;
      events.push({
        id: event.id,
        contractId: String(event.contractId ?? contractId),
        pagingToken: event.pagingToken,
        ledger: event.ledger,
        timestamp: event.ledgerClosedAt,
        txHash: event.txHash,
        eventType: event.type,
        topics,
        topic: topics,
        value,
        data: decodeEventValue(event.value),
      });
    }
    previousCursor = cursor;
    cursor = response.cursor;
    if (!response.events?.length || cursor === previousCursor) break;
  } while (cursor);
  return events;
}

async function loadAndFilterEvents(
  contractId: string,
  filter: ContractEventAnalyticsFilter,
  options: EventAnalyticsOptions,
): Promise<SorokitResult<ContractEvent[]>> {
  if (!contractId.trim()) {
    return err(SorokitErrorCode.INVALID_CONFIG, "contractId is required.");
  }
  if (filter.ledgerRange && (!Number.isInteger(filter.ledgerRange[0]) || !Number.isInteger(filter.ledgerRange[1]) || filter.ledgerRange[0] < 0 || filter.ledgerRange[0] > filter.ledgerRange[1])) {
    return err(SorokitErrorCode.INVALID_CONFIG, "ledgerRange must be an ordered pair of non-negative ledger numbers.");
  }
  try {
    if (!options.loadEvents && !options.rpcUrl) {
      return err(SorokitErrorCode.INVALID_CONFIG, "Provide rpcUrl or loadEvents to query contract events.");
    }
    const events = options.loadEvents
      ? await options.loadEvents(contractId, filter)
      : await loadRpcEvents(contractId, filter, options.rpcUrl!);
    return ok(events.filter((event) => matchesAnalyticsFilter(event, filter)));
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Failed to query contract events.", cause);
  }
}

export async function aggregateEvents(
  contractId: string,
  groupBy: EventGroupBy,
  options: EventAnalyticsOptions,
  filters: ContractEventAnalyticsFilter = {},
): Promise<SorokitResult<Record<string, EventAggregate>>> {
  const result = await loadAndFilterEvents(contractId, filters, options);
  if (result.status === "error") return result;
  const groups: Record<string, EventAggregate> = {};
  const numericCounts = new Map<string, number>();
  for (const event of result.data) {
    const key = typeof groupBy === "function"
      ? groupBy(event)
      : groupBy === "topic"
        ? eventTopicValues(event)[0] ?? "unknown"
        : groupBy.startsWith("data.")
          ? String((decodeEventValue(event.value) as Record<string, unknown> | null)?.[groupBy.slice(5)] ?? "unknown")
          : String(event[groupBy] ?? (groupBy === "type" ? event.eventType : undefined) ?? "unknown");
    const group = groups[key] ?? (groups[key] = { count: 0 });
    group.count += 1;
    const eventData = (event as ContractEvent & { data?: unknown }).data ?? event.value;
    const decodedData = decodeEventValue(eventData);
    const numericValue = Number(
      typeof decodedData === "object" && decodedData !== null
        ? (decodedData as Record<string, unknown>).amount
        : decodedData,
    );
    if (Number.isFinite(numericValue)) {
      group.sum = (group.sum ?? 0) + numericValue;
      const numericCount = (numericCounts.get(key) ?? 0) + 1;
      numericCounts.set(key, numericCount);
      group.average = group.sum / numericCount;
    }
  }
  return ok(groups);
}

export async function* streamEvents(
  contractId: string,
  filters: ContractEventAnalyticsFilter,
  options: EventAnalyticsOptions,
): AsyncGenerator<SorokitResult<ContractEvent[]>> {
  if (!contractId.trim() || !options.rpcUrl) {
    yield err(SorokitErrorCode.INVALID_CONFIG, "contractId and rpcUrl are required to stream events.");
    return;
  }
  try {
    for await (const events of streamContractEventsRealTime(contractId, {
      ...options.streamOptions,
      rpcUrl: options.rpcUrl,
    })) {
      yield ok(events.filter((event) => matchesAnalyticsFilter(event, filters)));
    }
  } catch (cause) {
    yield err(SorokitErrorCode.NETWORK_ERROR, "Contract event stream failed.", cause);
  }
}

/**
 * Convenience function to group events by time.
 *
 * @param events - Events to group
 * @param interval - Time interval
 * @returns Grouped events
 */
export function groupEventsByTime(
  events: ContractEvent[],
  interval: TimeInterval,
): TimeGroupedEvents {
  const analytics = new EventAnalytics(events);
  return analytics.groupByTime(interval);
}

/**
 * Convenience function to count events by type.
 *
 * @param events - Events to count
 * @returns Event type distribution
 */
export function countEventsByType(
  events: ContractEvent[],
): EventTypeDistribution {
  const analytics = new EventAnalytics(events);
  return analytics.countByType();
}

/**
 * Convenience function to aggregate event metrics.
 *
 * @param events - Events to aggregate
 * @param valueField - Field name to extract numeric value from
 * @returns Aggregated metrics
 */
export function aggregateEventMetrics(
  events: ContractEvent[],
  valueField?: string,
): EventMetrics {
  const analytics = new EventAnalytics(events);
  return analytics.aggregateMetrics(valueField);
}
