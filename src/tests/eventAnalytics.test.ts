import { describe, expect, it } from "vitest";
import {
  EventAnalytics, aggregateEventMetrics, countEventsByType, filterEvents, groupEventsByTime,
} from "../soroban/eventAnalytics";
import { EventIndex, filterNewEvents, hashEvent, hashString } from "../soroban/eventIndex";
import type { ContractEvent } from "../soroban/subscribeContractEvents";

const events: ContractEvent[] = [
  { id: "a", eventType: "transfer", contractId: "token", emitter: "alice", value: "10", ledger: 10, timestamp: new Date(2026, 0, 5, 12, 10).getTime() },
  { id: "b", name: "transfer", contract_id: "token", emitter: "bob", value: 30, ledger: 11, timestamp: new Date(2026, 0, 5, 12, 20).toISOString() },
  { id: "c", eventType: "mint", contractId: "other", emitter: "alice", value: "invalid", ledger: 12, timestamp: "invalid" },
  { id: "d" },
];

describe("contract event analytics", () => {
  it("combines filters without changing the input and can reset them", () => {
    const analytics = new EventAnalytics(events)
      .filterByType("transfer").filterByContract("token")
      .filterByEmitter("alice").filterByAmountRange(10, 20)
      .filterByLedgerRange(10, 11)
      .filterByTimeRange(new Date(2026, 0, 5).toISOString(), new Date(2026, 0, 6).getTime());
    expect(analytics.getEvents()).toEqual([events[0]]);
    expect(analytics.count()).toBe(1);
    expect(analytics.resetFilters().count()).toBe(4);
    expect(events).toHaveLength(4);
    expect(filterEvents(events, event => event.ledger === 12)).toEqual([events[2]]);
  });

  it("counts aliases and groups by contract, emitter and event type", () => {
    const analytics = new EventAnalytics(events);
    expect(countEventsByType(events)).toEqual({ transfer: 2, mint: 1, unknown: 1 });
    expect(analytics.countByContract()).toEqual({ token: 2, other: 1, unknown: 1 });
    expect(analytics.countByEmitter()).toEqual({ alice: 2, bob: 1, unknown: 1 });
  });

  it("aggregates only numeric values while retaining the full event count", () => {
    expect(aggregateEventMetrics(events)).toEqual({ count: 4, sum: 40, avg: 20, min: 10, max: 30 });
    expect(aggregateEventMetrics(events, "missing")).toEqual({ count: 4 });
    expect(new EventAnalytics(events).aggregateMetricsByTime("hour")).toEqual({
      "2026-01-05 12:00": { count: 2, sum: 40, avg: 20, min: 10, max: 30 },
    });
    expect(new EventAnalytics(events).aggregateMetricsByTime("day", "missing")).toEqual({
      "2026-01-05": { count: 2 },
    });
  });

  it.each([
    ["minute", ["2026-01-05 12:10", "2026-01-05 12:20"]],
    ["hour", ["2026-01-05 12:00"]],
    ["day", ["2026-01-05"]],
    ["week", ["2026-01-04"]],
    ["month", ["2026-01"]],
  ] as const)("groups valid timestamps by %s", (interval, keys) => {
    const grouped = groupEventsByTime(events, interval);
    expect(Object.keys(grouped)).toEqual(keys);
    expect(Object.values(grouped).flat()).toEqual(events.slice(0, 2));
    expect(Object.values(new EventAnalytics(events).groupByTimeAndCount(interval)).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("replaces or clears datasets without keeping old filters", () => {
    const analytics = new EventAnalytics().addEvents(events).filterByType("mint");
    expect(analytics.count()).toBe(1);
    expect(analytics.setEvents(events.slice(0, 2)).count()).toBe(2);
    expect(analytics.clear().getEvents()).toEqual([]);
  });
});

describe("event deduplication index", () => {
  it("drops repeated events and evicts the oldest entries at capacity", () => {
    const index = new EventIndex(2);
    expect(filterNewEvents(index, [events[0]!, events[0]!, events[1]!])).toEqual(events.slice(0, 2));
    expect(index.has(events[0]!)).toBe(true);
    index.add(events[2]!);
    expect(index.size).toBe(2);
    expect(index.has(events[0]!)).toBe(false);
    expect(index.has(events[1]!)).toBe(true);
    index.clear();
    expect(index.size).toBe(0);
  });

  it("deduplicates records without IDs from their stable fields", () => {
    const a = { contractId: "token", ledger: 1, topics: ["transfer", null, undefined], value: "10" };
    const index = new EventIndex(0);
    expect(index.add(a)).toBe(false);
    expect(index.add({ ...a })).toBe(true);
    expect(index.add({ ...a, ledger: 2 })).toBe(false);
    expect(hashEvent(a)).toBe(hashEvent({ ...a }));
    expect(hashString("transfer")).toBe(hashString("transfer"));
    expect(hashEvent({ id: "a", pagingToken: "1" })).not.toBe(hashEvent({ id: "b", pagingToken: "1" }));
  });
});
