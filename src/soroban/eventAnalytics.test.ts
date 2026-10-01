import { describe, expect, it, vi } from "vitest";
import type { ContractEvent } from "./subscribeContractEvents";
import { aggregateEvents, filterEvents } from "./eventAnalytics";

const events: ContractEvent[] = [
  {
    id: "one",
    contractId: "C123",
    eventType: "transfer",
    topics: ["transfer"],
    ledger: 100,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { from: "GUSER", amount: 5 },
  },
  {
    id: "two",
    contractId: "C123",
    eventType: "transfer",
    topics: ["transfer"],
    ledger: 150,
    timestamp: "2026-01-02T00:00:00.000Z",
    data: { from: "GOTHER", amount: 7 },
  },
  {
    id: "three",
    contractId: "C123",
    eventType: "mint",
    topics: ["mint"],
    ledger: 200,
    timestamp: "2026-01-03T00:00:00.000Z",
    data: { from: "GUSER", amount: 11 },
  },
];

describe("contract event analytics API", () => {
  it("filters by topic, data, ledger, and timestamp", async () => {
    const loadEvents = vi.fn(async () => events);
    const result = await filterEvents(
      "C123",
      {
        topic: "transfer",
        data: { from: "GUSER" },
        ledgerRange: [100, 150],
        timestampRange: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
      },
      { loadEvents },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.map((event) => event.id)).toEqual(["one"]);
    expect(loadEvents).toHaveBeenCalledWith("C123", expect.objectContaining({ ledgerRange: [100, 150] }));
  });

  it("aggregates event counts and numeric amounts by type", async () => {
    const result = await aggregateEvents("C123", "eventType", {
      loadEvents: async () => events,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transfer).toEqual({ count: 2, sum: 12, average: 6 });
      expect(result.data.mint).toEqual({ count: 1, sum: 11, average: 11 });
    }
  });

  it("rejects invalid ledger ranges without calling the source", async () => {
    const loadEvents = vi.fn(async () => events);
    const result = await filterEvents("C123", { ledgerRange: [200, 100] }, { loadEvents });

    expect(result.status).toBe("error");
    expect(loadEvents).not.toHaveBeenCalled();
  });
});