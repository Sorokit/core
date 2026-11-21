import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetContractEventSubscriptionTracking,
  subscribeContractEvents,
  type ContractEvent,
} from "./subscribeContractEvents";

const CONTRACT_ID = "CABC000000000000000000000000000000000000000000000000000000";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

/** A /ledgers-shaped response that also embeds event records in the same
 * payload, matching how `poll()` reads both the latest sequence and the
 * current-ledger events from one `readRecords(payload)` call on the same
 * response body. */
function ledgersResponseWithEvents(
  sequence: number,
  events: Array<{ id: string; ledger: number }>,
) {
  return {
    ok: true,
    json: async () => ({
      records: [
        { sequence },
        ...events.map((event) => ({
          id: event.id,
          contract_id: CONTRACT_ID,
          ledger: event.ledger,
          name: "transfer",
        })),
      ],
    }),
  } as Response;
}

afterEach(() => {
  resetContractEventSubscriptionTracking();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeContractEvents deduplication (#863)", () => {
  it("delivers a real event once and suppresses it on a later poll that re-reports the same id", async () => {
    vi.useFakeTimers();

    let pollCount = 0;
    const fetchMock = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        // First poll: ledger 100, event "100-0" is new.
        return ledgersResponseWithEvents(100, [{ id: "100-0", ledger: 100 }]);
      }
      // Second poll: same ledger, same event id redelivered (simulating a
      // reconnect/retry that re-reports an already-seen event) plus one
      // genuinely new event at ledger 101.
      return ledgersResponseWithEvents(100, [
        { id: "100-0", ledger: 100 },
        { id: "101-0", ledger: 101 },
      ]);
    });

    const delivered: ContractEvent[] = [];
    const unsubscribe = subscribeContractEvents(
      CONTRACT_ID,
      undefined,
      (events) => delivered.push(...events),
      { horizonUrl: HORIZON_URL, intervalMs: 1000, fetch: fetchMock },
    );

    // scheduleNextPoll() always delays the first poll by intervalMs (no
    // immediate poll on subscribe), so two poll cycles need 2 * intervalMs.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    unsubscribe();

    const deliveredIds = delivered.map((event) => event.id);
    expect(deliveredIds).toEqual(["100-0", "101-0"]);
    expect(deliveredIds.filter((id) => id === "100-0")).toHaveLength(1);
  });

  it("does not redeliver a recovered event that the current-ledger poll also reports", async () => {
    vi.useFakeTimers();

    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ledgers/")) {
        // Gap-recovery fetch for an individual ledger: report the same
        // event the next regular poll will also report.
        return ledgersResponseWithEvents(103, [{ id: "103-0", ledger: 103 }]);
      }

      pollCount += 1;
      if (pollCount === 1) {
        return ledgersResponseWithEvents(100, []);
      }
      // Jump straight from ledger 100 to 104, triggering gap recovery for
      // 101-103, while the "current" poll also reports event 103-0 (as a
      // real Horizon poll legitimately could, since the gap-recovery fetch
      // and the live tip can overlap).
      return ledgersResponseWithEvents(104, [{ id: "103-0", ledger: 103 }]);
    });

    const delivered: ContractEvent[] = [];
    const unsubscribe = subscribeContractEvents(
      CONTRACT_ID,
      undefined,
      (events) => delivered.push(...events),
      { horizonUrl: HORIZON_URL, intervalMs: 1000, fetch: fetchMock },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    unsubscribe();

    const occurrences = delivered.filter((event) => event.id === "103-0");
    expect(occurrences).toHaveLength(1);
  });
});
