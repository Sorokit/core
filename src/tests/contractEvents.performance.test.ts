/**
 * contractEvents.performance.test.ts
 *
 * Performance tests for contract event processing.
 * Uses performance.now() for timing — no fake timers.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createMockContractEventGenerator, createMockEventStream } from "../testing/mockEventStream";
import { EventIndex } from "../soroban/eventIndex";
import { streamContractEventsRealTime } from "../soroban/streamContractEventsRealTime";
import type { ContractEvent } from "../soroban/subscribeContractEvents";

describe("Performance: EventIndex", () => {
  it("add 10,000 events at >1000 events/sec", () => {
    const gen = createMockContractEventGenerator({ seed: 1 });
    const events = gen.batch(10_000);
    const index = new EventIndex();

    const start = performance.now();
    for (const event of events) {
      index.add(event);
    }
    const elapsed = performance.now() - start;

    // 10,000 events in under 10 seconds implies >1000/sec
    expect(elapsed).toBeLessThan(10_000);
    expect(index.size).toBe(10_000);
  });

  it("query 10,000 events in <200ms", () => {
    const gen = createMockContractEventGenerator({ seed: 1 });
    const events = gen.batch(10_000);
    const index = new EventIndex();
    for (const event of events) {
      index.add(event);
    }

    const start = performance.now();
    const results = index.query({ name: "transfer" });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Performance: Mock stream 1000 events without duplicates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1000 events delivered without duplicates", async () => {
    const gen = createMockContractEventGenerator({ seed: 1, contractId: "CPERF" });
    const events = gen.batch(1_000);
    const mockFetch = createMockEventStream(events);

    const received: ContractEvent[] = [];
    const onEvent = (evts: ContractEvent[]) => {
      received.push(...evts);
    };

    const sub = streamContractEventsRealTime("CPERF", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: mockFetch,
      onEvent,
    });

    // Advance through one poll cycle to get all events delivered
    await vi.advanceTimersByTimeAsync(1600);

    sub.stop();

    // Verify all events were delivered and no duplicates
    const uniqueIds = new Set(received.map((e) => e.id));
    expect(uniqueIds.size).toBe(received.length);
    expect(received.length).toBe(1_000);
  });
});
