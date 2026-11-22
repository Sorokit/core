import { describe, it, expect, beforeEach } from "vitest";
import {
  NetworkCursorStore,
  createNetworkCursorStore,
  type HorizonCursor,
  type EventId,
} from "./cursorStore";
import { MemoryCursorStore, PersistentEventDeduplicationStore } from "../streaming/cursorStore";

describe("NetworkCursorStore", () => {
  let store: NetworkCursorStore;

  beforeEach(() => {
    store = new NetworkCursorStore();
  });

  describe("cursor persistence", () => {
    it("saves and loads a cursor for a stream", async () => {
      const streamKey = "account:GABC123";
      const cursor: HorizonCursor = "12345678-0";

      await store.saveCursor(streamKey, cursor);
      const loaded = await store.loadCursor(streamKey);

      expect(loaded).toBe(cursor);
    });

    it("returns undefined for a stream with no saved cursor", async () => {
      const loaded = await store.loadCursor("nonexistent-stream");
      expect(loaded).toBeUndefined();
    });

    it("overwrites an existing cursor when saving again", async () => {
      const streamKey = "account:GABC123";

      await store.saveCursor(streamKey, "12345678-0");
      await store.saveCursor(streamKey, "12345679-0");

      const loaded = await store.loadCursor(streamKey);
      expect(loaded).toBe("12345679-0");
    });

    it("clears a specific cursor", async () => {
      const streamKey = "account:GABC123";
      await store.saveCursor(streamKey, "12345678-0");

      await store.clearCursor(streamKey);

      const loaded = await store.loadCursor(streamKey);
      expect(loaded).toBeUndefined();
    });

    it("clears all cursors when no key is provided", async () => {
      await store.saveCursor("stream1", "cursor1");
      await store.saveCursor("stream2", "cursor2");

      await store.clearCursor();

      expect(await store.loadCursor("stream1")).toBeUndefined();
      expect(await store.loadCursor("stream2")).toBeUndefined();
    });

    it("handles multiple independent streams", async () => {
      await store.saveCursor("account:GABC123", "12345678-0");
      await store.saveCursor("account:GDEF456", "98765432-1");

      expect(await store.loadCursor("account:GABC123")).toBe("12345678-0");
      expect(await store.loadCursor("account:GDEF456")).toBe("98765432-1");
    });
  });

  describe("event deduplication", () => {
    it("marks an event as processed", async () => {
      const eventId: EventId = "12345678-0-0";

      await store.markProcessed(eventId);

      expect(await store.isProcessed(eventId)).toBe(true);
    });

    it("returns false for unprocessed events", async () => {
      expect(await store.isProcessed("unprocessed-event")).toBe(false);
    });

    it("detects duplicates after marking as processed", async () => {
      const eventId: EventId = "12345678-0-0";

      expect(await store.isProcessed(eventId)).toBe(false);
      await store.markProcessed(eventId);
      expect(await store.isProcessed(eventId)).toBe(true);
    });

    it("tracks multiple processed events independently", async () => {
      await store.markProcessed("event1");
      await store.markProcessed("event2");

      expect(await store.isProcessed("event1")).toBe(true);
      expect(await store.isProcessed("event2")).toBe(true);
      expect(await store.isProcessed("event3")).toBe(false);
    });

    it("clears all processed events", async () => {
      await store.markProcessed("event1");
      await store.markProcessed("event2");

      await store.clearProcessed();

      expect(await store.isProcessed("event1")).toBe(false);
      expect(await store.isProcessed("event2")).toBe(false);
    });

    it("allows reprocessing after clearing processed events", async () => {
      const eventId = "12345678-0-0";

      await store.markProcessed(eventId);
      expect(await store.isProcessed(eventId)).toBe(true);

      await store.clearProcessed();
      expect(await store.isProcessed(eventId)).toBe(false);

      await store.markProcessed(eventId);
      expect(await store.isProcessed(eventId)).toBe(true);
    });
  });

  describe("combined cursor and deduplication", () => {
    it("manages cursors and deduplication independently", async () => {
      const streamKey = "account:GABC123";
      const cursor = "12345678-0";
      const eventId = "12345678-0-0";

      await store.saveCursor(streamKey, cursor);
      await store.markProcessed(eventId);

      expect(await store.loadCursor(streamKey)).toBe(cursor);
      expect(await store.isProcessed(eventId)).toBe(true);

      await store.clearCursor(streamKey);

      expect(await store.loadCursor(streamKey)).toBeUndefined();
      expect(await store.isProcessed(eventId)).toBe(true);
    });

    it("clears all state with clearAll", async () => {
      await store.saveCursor("stream1", "cursor1");
      await store.markProcessed("event1");

      await store.clearAll();

      expect(await store.loadCursor("stream1")).toBeUndefined();
      expect(await store.isProcessed("event1")).toBe(false);
    });
  });

  describe("resume from cursor", () => {
    it("allows resuming a stream from a saved cursor", async () => {
      const streamKey = "account:GABC123";

      // Simulate initial streaming session
      await store.saveCursor(streamKey, "12345678-0");
      await store.markProcessed("12345678-0-0");
      await store.markProcessed("12345678-0-1");

      // Simulate stream disconnect and reconnect
      const savedCursor = await store.loadCursor(streamKey);
      expect(savedCursor).toBe("12345678-0");

      // New events after reconnect
      await store.saveCursor(streamKey, "12345679-0");
      await store.markProcessed("12345679-0-0");

      // Verify all events are marked
      expect(await store.isProcessed("12345678-0-0")).toBe(true);
      expect(await store.isProcessed("12345678-0-1")).toBe(true);
      expect(await store.isProcessed("12345679-0-0")).toBe(true);
    });

    it("starts from 'now' when no cursor is saved", async () => {
      const savedCursor = await store.loadCursor("new-stream");
      const effectiveCursor = savedCursor ?? "now";

      expect(effectiveCursor).toBe("now");
    });
  });

  describe("duplicate detection scenario", () => {
    it("skips duplicate events during reconnection", async () => {
      const streamKey = "account:GABC123";
      const processedEvents: string[] = [];

      // First streaming session
      const events1 = [
        { id: "12345678-0-0", pagingToken: "12345678-0" },
        { id: "12345678-0-1", pagingToken: "12345678-0" },
      ];

      for (const event of events1) {
        if (!(await store.isProcessed(event.id))) {
          await store.markProcessed(event.id);
          processedEvents.push(event.id);
          await store.saveCursor(streamKey, event.pagingToken);
        }
      }

      expect(processedEvents).toEqual(["12345678-0-0", "12345678-0-1"]);

      // Simulate disconnect and reconnect with overlapping events
      const savedCursor = await store.loadCursor(streamKey);
      expect(savedCursor).toBe("12345678-0");

      // New session receives some duplicates + new events
      const events2 = [
        { id: "12345678-0-1", pagingToken: "12345678-0" }, // Duplicate
        { id: "12345679-0-0", pagingToken: "12345679-0" }, // New
        { id: "12345679-0-1", pagingToken: "12345679-0" }, // New
      ];

      for (const event of events2) {
        if (!(await store.isProcessed(event.id))) {
          await store.markProcessed(event.id);
          processedEvents.push(event.id);
          await store.saveCursor(streamKey, event.pagingToken);
        }
      }

      // Should have skipped the duplicate
      expect(processedEvents).toEqual([
        "12345678-0-0",
        "12345678-0-1",
        "12345679-0-0",
        "12345679-0-1",
      ]);
    });
  });

  describe("custom implementations", () => {
    it("accepts a custom cursor store", async () => {
      const customCursorStore = new MemoryCursorStore();
      const customStore = new NetworkCursorStore(customCursorStore);

      await customStore.saveCursor("stream", "cursor");
      expect(await customStore.loadCursor("stream")).toBe("cursor");
    });

    it("accepts a custom deduplication store", async () => {
      const customDeduplicationStore = new PersistentEventDeduplicationStore();
      const customStore = new NetworkCursorStore(undefined, customDeduplicationStore);

      await customStore.markProcessed("event");
      expect(await customStore.isProcessed("event")).toBe(true);
    });

    it("accepts both custom stores", async () => {
      const customCursorStore = new MemoryCursorStore();
      const customDeduplicationStore = new PersistentEventDeduplicationStore();
      const customStore = new NetworkCursorStore(
        customCursorStore,
        customDeduplicationStore,
      );

      await customStore.saveCursor("stream", "cursor");
      await customStore.markProcessed("event");

      expect(await customStore.loadCursor("stream")).toBe("cursor");
      expect(await customStore.isProcessed("event")).toBe(true);
    });
  });
});

describe("createNetworkCursorStore", () => {
  it("creates a working store with default implementations", async () => {
    const store = createNetworkCursorStore();

    await store.saveCursor("stream", "cursor");
    await store.markProcessed("event");

    expect(await store.loadCursor("stream")).toBe("cursor");
    expect(await store.isProcessed("event")).toBe(true);
  });

  it("creates a store with custom cursor store", async () => {
    const customCursorStore = new MemoryCursorStore();
    const store = createNetworkCursorStore(customCursorStore);

    await store.saveCursor("stream", "cursor");
    expect(await customCursorStore.load("stream")).toBe("cursor");
  });

  it("creates a store with custom deduplication store", async () => {
    const customDeduplicationStore = new PersistentEventDeduplicationStore();
    const store = createNetworkCursorStore(undefined, customDeduplicationStore);

    await store.markProcessed("event");
    expect(await customDeduplicationStore.has("event")).toBe(true);
  });
});

describe("edge cases", () => {
  let store: NetworkCursorStore;

  beforeEach(() => {
    store = new NetworkCursorStore();
  });

  it("handles empty string cursor", async () => {
    await store.saveCursor("stream", "");
    expect(await store.loadCursor("stream")).toBe("");
  });

  it("handles empty string event ID", async () => {
    await store.markProcessed("");
    expect(await store.isProcessed("")).toBe(true);
  });

  it("handles special cursor value 'now'", async () => {
    await store.saveCursor("stream", "now");
    expect(await store.loadCursor("stream")).toBe("now");
  });

  it("handles long cursor values", async () => {
    const longCursor = "12345678901234567890-123456789";
    await store.saveCursor("stream", longCursor);
    expect(await store.loadCursor("stream")).toBe(longCursor);
  });

  it("handles stream keys with special characters", async () => {
    const complexKey = "account:GABC123/payments?cursor=now&limit=100";
    await store.saveCursor(complexKey, "cursor");
    expect(await store.loadCursor(complexKey)).toBe("cursor");
  });

  it("handles rapid cursor updates", async () => {
    const streamKey = "stream";
    for (let i = 0; i < 100; i++) {
      await store.saveCursor(streamKey, `cursor-${i}`);
    }
    expect(await store.loadCursor(streamKey)).toBe("cursor-99");
  });

  it("handles rapid event marking", async () => {
    const eventIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const eventId = `event-${i}`;
      eventIds.push(eventId);
      await store.markProcessed(eventId);
    }

    for (const eventId of eventIds) {
      expect(await store.isProcessed(eventId)).toBe(true);
    }
  });
});
