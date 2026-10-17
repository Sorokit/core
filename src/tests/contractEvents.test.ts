/**
 * contractEvents.test.ts
 *
 * Unit tests for:
 *   - streamContractEventsRealTime
 *   - decodeContractEventWithAbi
 *   - EventIndex
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { streamContractEventsRealTime } from "../soroban/streamContractEventsRealTime";
import { decodeContractEventWithAbi } from "../soroban/decodeContractEvent";
import { EventIndex } from "../soroban/eventIndex";
import { SorokitErrorCode } from "../shared/response";
import { createMockContractEventGenerator } from "../testing/mockEventStream";
import type { ContractEvent } from "../soroban/subscribeContractEvents";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResponse(events: ContractEvent[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ _embedded: { records: events } }),
  } as unknown as Response;
}

// ─── streamContractEventsRealTime ─────────────────────────────────────────────

describe("streamContractEventsRealTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop() before first tick does not call fetch", async () => {
    const fetchMock = vi.fn();
    const onEvent = vi.fn();

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
    });

    sub.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("onEvent receives events on successful poll", async () => {
    const event: ContractEvent = {
      id: "evt-1",
      contractId: "CTEST",
      name: "transfer",
      topics: ["topic-a"],
      value: { amount: 100 },
      ledger: 1,
    };

    const fetchMock = vi.fn().mockResolvedValue(makeResponse([event]));
    const onEvent = vi.fn();

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
    });

    await vi.advanceTimersByTimeAsync(1600);

    expect(onEvent).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "evt-1" }),
    ]));

    sub.stop();
  });

  it("deduplication: same event ID not delivered twice", async () => {
    const event: ContractEvent = {
      id: "evt-dup",
      contractId: "CTEST",
      name: "transfer",
      topics: [],
      value: null,
      ledger: 1,
    };

    const fetchMock = vi.fn().mockResolvedValue(makeResponse([event]));
    const onEvent = vi.fn();

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
    });

    // Advance enough for two polls
    await vi.advanceTimersByTimeAsync(3200);

    // onEvent should only have been called once (event deduped on second poll)
    const totalEvents = onEvent.mock.calls.flatMap((call) => call[0] as ContractEvent[]);
    const ids = totalEvents.map((e) => e.id);
    expect(ids.filter((id) => id === "evt-dup")).toHaveLength(1);

    sub.stop();
  });

  it("onError called when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    const onError = vi.fn();
    const onEvent = vi.fn();

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
      onError,
    });

    await vi.advanceTimersByTimeAsync(1600);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Number));

    sub.stop();
  });

  it("backoff doubles on consecutive failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fail"));
    const onEvent = vi.fn();
    const delays: number[] = [];

    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === "number" && delay > 0) {
          delays.push(delay);
        }
        return origSetTimeout(fn as any, delay, ...args);
      });

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
    });

    // Advance through 3 backoff cycles: 1500 → 3000 → 6000
    await vi.advanceTimersByTimeAsync(1600);  // first poll fires, fails, schedules 3000ms
    await vi.advanceTimersByTimeAsync(3100);  // second poll fires, fails, schedules 6000ms
    await vi.advanceTimersByTimeAsync(6100);  // third poll fires, fails, schedules 12000ms

    sub.stop();
    setTimeoutSpy.mockRestore();

    // Filter out the initial schedule (1500ms) and subsequent doubles
    // delays captured: [1500, 3000, 6000, ...]
    const relevant = delays.filter((d) => d >= 1500);
    expect(relevant[0]).toBe(1500);
    expect(relevant[1]).toBe(3000);
    expect(relevant[2]).toBe(6000);
  });

  it("onReconnect called on attempt > 0 after failure", async () => {
    const onReconnect = vi.fn();
    const onEvent = vi.fn();

    // Reject first two calls (onReconnect fires on 2nd failure since attempt > 0),
    // then resolve on the third call.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail again"))
      .mockResolvedValue(makeResponse([]));

    const sub = streamContractEventsRealTime("CTEST", undefined, {
      horizonUrl: "https://horizon.example.com",
      intervalMs: 1500,
      fetch: fetchMock,
      onEvent,
      onReconnect,
    });

    // First poll fires at 1500ms → fails → attempt=0, no onReconnect → backoff=3000ms
    await vi.advanceTimersByTimeAsync(1600);
    // Second poll fires at 1500+3000=4500ms → fails → attempt=1 > 0, onReconnect fires
    await vi.advanceTimersByTimeAsync(3100);

    expect(onReconnect).toHaveBeenCalledWith(expect.any(Number));

    sub.stop();
  });
});

// ─── decodeContractEvent ─────────────────────────────────────────────────────

describe("decodeContractEventWithAbi", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "string-input"],
    ["array", []],
    ["boolean", true],
  ])(
    "malformed input (%s) returns error with CONTRACT_READ_FAILED",
    (_label, input) => {
      const result = decodeContractEventWithAbi(input);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
    },
  );

  it("unknown event type (no ABI) returns status ok with type=unknown", () => {
    const result = decodeContractEventWithAbi({
      contractId: "CTEST",
      name: "unknownEvent",
      topics: ["t1"],
      value: null,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.type).toBe("unknown");
  });

  it("known event type with ABI returns status ok with type=known", () => {
    const abi = { methods: [{ name: "transfer", args: [] }] };
    const result = decodeContractEventWithAbi(
      { contractId: "CTEST", name: "transfer", topics: [], value: null },
      abi,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.type).toBe("known");
  });

  it("valid event without ABI returns ok with correct contractId and name", () => {
    const result = decodeContractEventWithAbi({
      contractId: "C123",
      name: "mint",
      topics: ["t1", "t2"],
      value: { amount: 500 },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.contractId).toBe("C123");
    expect(result.data.name).toBe("mint");
  });

  it("missing value field returns ok with undefined or null value", () => {
    const result = decodeContractEventWithAbi({ contractId: "CTEST", name: "burn" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // value should be undefined (no 'value' key present)
    expect(result.data.value == null).toBe(true);
  });

  it("event with all undefined fields returns ok with empty strings", () => {
    const result = decodeContractEventWithAbi({});
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.name).toBe("");
    expect(result.data.contractId).toBe("");
  });
});

// ─── EventIndex ───────────────────────────────────────────────────────────────

describe("EventIndex", () => {
  const gen = createMockContractEventGenerator({ contractId: "CMOCK" });

  it("add and size: adding 3 distinct events gives size() === 3", () => {
    const index = new EventIndex();
    index.add(gen.next());
    index.add(gen.next());
    index.add(gen.next());
    expect(index.size).toBe(3);
  });

  it("query by contractId returns only matching events", () => {
    const index = new EventIndex();

    const genC1 = createMockContractEventGenerator({ contractId: "C1" });
    const genC2 = createMockContractEventGenerator({ contractId: "C2" });

    index.add(genC1.next());
    index.add(genC1.next());
    index.add(genC2.next());

    const results = index.query({ contractId: "C1" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.contractId === "C1")).toBe(true);
  });

  it("query by ledger range returns correct events", () => {
    const index = new EventIndex();
    // Generate 10 events at ledgers 1..10
    const genL = createMockContractEventGenerator({
      seed: 1,
      contractId: "LEDGER",
    });
    for (let i = 0; i < 10; i++) {
      index.add(genL.next());
    }

    const results = index.query({ minLedger: 3, maxLedger: 7 });
    expect(results).toHaveLength(5);
    results.forEach((e) => expect((e as any).ledger).toBeGreaterThanOrEqual(3));
    results.forEach((e) => expect((e as any).ledger).toBeLessThanOrEqual(7));
  });

  it("query by name returns only matching events", () => {
    const index = new EventIndex();
    // eventTypes cycles: transfer, mint, burn
    const genN = createMockContractEventGenerator({ seed: 1 });
    for (let i = 0; i < 9; i++) {
      index.add(genN.next());
    }

    const mints = index.query({ name: "mint" });
    expect(mints.length).toBeGreaterThan(0);
    expect(mints.every((e) => e.name === "mint")).toBe(true);
  });

  it("query with custom predicate returns correct events", () => {
    const index = new EventIndex();
    const genP = createMockContractEventGenerator({ seed: 1 });
    for (let i = 0; i < 9; i++) {
      index.add(genP.next());
    }

    const transfers = index.query({ predicate: (e) => e.name === "transfer" });
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers.every((e) => e.name === "transfer")).toBe(true);
  });

  it("deduplicate removes exact duplicates", () => {
    const index = new EventIndex();
    const event: ContractEvent = {
      id: "dup-1",
      contractId: "CDUP",
      name: "transfer",
      topics: [],
      ledger: 1,
    };
    index.add(event);
    index.add(event); // Same object reference — same fullKey
    // EventIndex.add already deduplicates same fullKey, so size stays 1
    expect(index.size).toBe(1);
    const removed = index.deduplicate();
    expect(removed).toBe(0);
    expect(index.size).toBe(1);
  });

  it("hash collision: distinct events with same hash bucket are both kept", () => {
    const index = new EventIndex();

    // Two events with different ids — distinct events that might share a hash bucket.
    // We force a collision by manually injecting two distinct events and relying on
    // the EventIndex collision map to keep both.
    const e1: ContractEvent = {
      id: "coll-1",
      contractId: "CCOLL",
      name: "mint",
      topics: [],
      ledger: 1,
    };
    const e2: ContractEvent = {
      id: "coll-2",
      contractId: "CCOLL",
      name: "mint",
      topics: [],
      ledger: 1,
    };

    // e1 and e2 share the same hashKey (same contractId, name, ledger)
    // but differ in id → they are distinct in fullKey → both should be kept
    index.add(e1);
    index.add(e2);

    expect(index.size).toBe(2);
  });

  it("clear empties the index", () => {
    const index = new EventIndex();
    const genClear = createMockContractEventGenerator();
    index.add(genClear.next());
    index.add(genClear.next());
    index.clear();
    expect(index.size).toBe(0);
  });
});
