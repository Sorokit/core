/**
 * Contract Event Filter and Aggregation Engine
 *
 * Provides filtering, time-window grouping, and aggregation capabilities
 * for contract event streams with a chainable API.
 */

import type { ContractEvent } from "./subscribeContractEvents";

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
): ContractEvent[] {
  const analytics = new EventAnalytics(events);
  return analytics.filter(predicate).getEvents();
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
