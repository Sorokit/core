/**
 * Network-aware cursor store for Horizon SSE streaming (#931)
 *
 * Integrates cursor persistence and event deduplication for reliable streaming
 * with automatic resume from last known position and duplicate detection.
 *
 * Related: Issue #25 (streaming reliability), ADR-003 (streaming architecture)
 */

import type { CursorStore } from "../streaming/cursorStore";
import { createCursorStore, PersistentEventDeduplicationStore } from "../streaming/cursorStore";
import type { EventDeduplicationStore } from "../streaming/cursorStore";

/**
 * Cursor format for Horizon SSE streams.
 *
 * Stellar Horizon uses `paging_token` as the cursor format:
 * - String-encoded ledger sequence + operation/transaction index
 * - Example: "12345678-0" (ledger 12345678, operation 0)
 * - Special value "now" starts from the latest ledger
 *
 * Storage format: `sorokit:cursor:{streamKey}` → cursor value
 */
export type HorizonCursor = string;

/**
 * Event identifier for deduplication.
 *
 * Stellar event IDs are unique across the network:
 * - Format: ledger-sequence-operation-index
 * - Example: "12345678-0-0"
 */
export type EventId = string;

/**
 * Network-aware cursor store for streaming operations.
 *
 * Provides automatic cursor persistence and event deduplication for Horizon SSE
 * streams to prevent missed events and duplicates during reconnections.
 */
export class NetworkCursorStore {
  private readonly cursorStore: CursorStore;
  private readonly deduplicationStore: EventDeduplicationStore;

  constructor(
    cursorStore?: CursorStore,
    deduplicationStore?: EventDeduplicationStore,
  ) {
    this.cursorStore = cursorStore ?? createCursorStore();
    this.deduplicationStore =
      deduplicationStore ?? new PersistentEventDeduplicationStore();
  }

  /**
   * Save a cursor for the given stream.
   *
   * @param streamKey - Unique identifier for the stream (e.g., "account:GABC...")
   * @param cursor - Horizon paging_token to save
   *
   * @example
   * ```ts
   * await store.saveCursor("account:GABC123", "12345678-0");
   * ```
   */
  async saveCursor(streamKey: string, cursor: HorizonCursor): Promise<void> {
    await this.cursorStore.save(streamKey, cursor);
  }

  /**
   * Load the last saved cursor for the given stream.
   *
   * @param streamKey - Unique identifier for the stream
   * @returns The saved cursor, or undefined if none exists
   *
   * @example
   * ```ts
   * const cursor = await store.loadCursor("account:GABC123");
   * // cursor might be "12345678-0" or undefined
   * ```
   */
  async loadCursor(streamKey: string): Promise<HorizonCursor | undefined> {
    return await this.cursorStore.load(streamKey);
  }

  /**
   * Clear the saved cursor for a stream (or all streams if no key provided).
   *
   * @param streamKey - Optional stream identifier; if omitted, clears all cursors
   */
  async clearCursor(streamKey?: string): Promise<void> {
    await this.cursorStore.clear(streamKey);
  }

  /**
   * Mark an event as processed to enable duplicate detection.
   *
   * @param eventId - Unique event identifier (typically event.id or event.pagingToken)
   *
   * @example
   * ```ts
   * await store.markProcessed(event.id);
   * ```
   */
  async markProcessed(eventId: EventId): Promise<void> {
    await this.deduplicationStore.add(eventId);
  }

  /**
   * Check if an event has already been processed.
   *
   * @param eventId - Unique event identifier to check
   * @returns true if the event was already processed, false otherwise
   *
   * @example
   * ```ts
   * if (await store.isProcessed(event.id)) {
   *   console.log("Skipping duplicate event");
   *   return;
   * }
   * await store.markProcessed(event.id);
   * // ... process event
   * ```
   */
  async isProcessed(eventId: EventId): Promise<boolean> {
    return await this.deduplicationStore.has(eventId);
  }

  /**
   * Clear all processed event IDs from the deduplication store.
   *
   * Useful for testing or when you want to reprocess events.
   */
  async clearProcessed(): Promise<void> {
    await this.deduplicationStore.clear();
  }

  /**
   * Clear all stored state (cursors and processed events).
   */
  async clearAll(): Promise<void> {
    await this.cursorStore.clear();
    await this.deduplicationStore.clear();
  }
}

/**
 * Create a network cursor store with default implementations.
 *
 * Uses localStorage in browsers, memory storage elsewhere.
 *
 * @example
 * ```ts
 * const store = createNetworkCursorStore();
 *
 * // Save cursor during streaming
 * subscription.onEvent = async (event) => {
 *   if (await store.isProcessed(event.id)) return; // Skip duplicate
 *   await store.markProcessed(event.id);
 *   await store.saveCursor(streamKey, event.pagingToken);
 *   // ... process event
 * };
 *
 * // Resume from saved cursor
 * const savedCursor = await store.loadCursor(streamKey);
 * const sub = streamAccountUpdates(publicKey, {
 *   cursor: savedCursor ?? "now",
 *   onEvent: async (event) => { ... }
 * });
 * ```
 */
export function createNetworkCursorStore(
  cursorStore?: CursorStore,
  deduplicationStore?: EventDeduplicationStore,
): NetworkCursorStore {
  return new NetworkCursorStore(cursorStore, deduplicationStore);
}
