// ── Types ─────────────────────────────────────────────────────────────────────

/** Normalized representation of an indexed Soroban contract event. */
export interface IndexedContractEvent {
  /** Globally unique event identifier (contractId + ledger + topic hash). */
  id: string;
  /** Contract address that emitted the event. */
  contractId: string;
  /** Account address of the transaction source that produced the event. */
  emitter: string;
  /** Decoded topic strings from the event envelope. */
  topics: string[];
  /** Ledger sequence number when the event was emitted. */
  ledger: number;
  /** ISO-8601 timestamp of the ledger close. */
  timestamp: string;
  /** Event type / name (e.g. "transfer", "mint"). */
  eventType: string;
  /** Raw value payload — storage-agnostic, left as received. */
  value: unknown;
}

/** Filtering options for queryIndexedEvents(). */
export interface IndexedEventFilter {
  /** Restrict to events from this contract address. */
  contractId?: string;
  /** Restrict to events of this type. */
  eventType?: string;
  /** Restrict to events emitted by this account. */
  emitter?: string;
  /** Restrict to a topic string or pattern. Matches any topic in the topics array. */
  topic?: string | RegExp;
  /** ISO-8601 start of time range (inclusive). */
  since?: string;
  /** ISO-8601 end of time range (inclusive). */
  until?: string;
}

/** Pagination options for queryIndexedEvents(). */
export interface IndexedEventPage {
  /** Opaque cursor from a previous page response. Omit for the first page. */
  cursor?: string;
  /** Maximum events per page. Defaults to 100. */
  limit?: number;
}

/** Paginated result returned by queryIndexedEvents(). */
export interface IndexedEventQueryResult {
  events: IndexedContractEvent[];
  /** Cursor for the next page. Undefined when no further results exist. */
  nextCursor?: string;
  total: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesTopic(topics: string[], pattern: string | RegExp): boolean {
  return topics.some((t) =>
    pattern instanceof RegExp ? pattern.test(t) : t === pattern,
  );
}

function inTimeRange(timestamp: string, since?: string, until?: string): boolean {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return false;
  if (since && ts < Date.parse(since)) return false;
  if (until && ts > Date.parse(until)) return false;
  return true;
}

function deriveSyntheticId(event: Omit<IndexedContractEvent, "id">): string {
  return `${event.contractId}:${event.ledger}:${event.eventType}:${event.topics.join("|")}`;
}

// ── In-memory index ───────────────────────────────────────────────────────────

/**
 * Storage-agnostic in-memory event index.
 *
 * The SDK defines the indexing/query contract without forcing consumers into a
 * specific database. To persist events, wrap this class or implement the same
 * interface backed by your storage layer.
 */
export class InMemoryEventIndex {
  private readonly events: Map<string, IndexedContractEvent> = new Map();

  /**
   * Index a single contract event. Duplicate ingestion is handled safely —
   * events with the same id are silently ignored.
   *
   * @returns true when the event was stored, false when it was a duplicate.
   */
  index(event: IndexedContractEvent): boolean {
    if (this.events.has(event.id)) return false;
    this.events.set(event.id, event);
    return true;
  }

  /**
   * Query indexed events with optional filters and pagination.
   *
   * Results are returned in ascending ledger order.
   * Default page size: 100.
   */
  query(filter?: IndexedEventFilter, page?: IndexedEventPage): IndexedEventQueryResult {
    const limit = Math.min(Math.max(1, page?.limit ?? 100), 1000);

    let all = Array.from(this.events.values()).sort((a, b) => a.ledger - b.ledger);

    if (filter) {
      if (filter.contractId) {
        all = all.filter((e) => e.contractId === filter.contractId);
      }
      if (filter.eventType) {
        all = all.filter((e) => e.eventType === filter.eventType);
      }
      if (filter.emitter) {
        all = all.filter((e) => e.emitter === filter.emitter);
      }
      if (filter.topic !== undefined) {
        all = all.filter((e) => matchesTopic(e.topics, filter.topic!));
      }
      if (filter.since || filter.until) {
        all = all.filter((e) => inTimeRange(e.timestamp, filter.since, filter.until));
      }
    }

    const total = all.length;

    // Cursor-based pagination: cursor is the id of the last event on the previous page
    let startIdx = 0;
    if (page?.cursor) {
      const cursorIdx = all.findIndex((e) => e.id === page.cursor);
      if (cursorIdx !== -1) startIdx = cursorIdx + 1;
    }

    const slice = all.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < total ? slice[slice.length - 1]?.id : undefined;
    const result: IndexedEventQueryResult = { events: slice, total };
    if (nextCursor !== undefined) {
      result.nextCursor = nextCursor;
    }
    return result;
  }

  /** Total number of events currently held in the index. */
  size(): number {
    return this.events.size;
  }

  /** Remove all events from the index. */
  clear(): void {
    this.events.clear();
  }
}

// ── Factory / normalizer ──────────────────────────────────────────────────────

/**
 * Normalize a raw event object into an IndexedContractEvent and index it.
 *
 * @param index - The target InMemoryEventIndex (or compatible implementation).
 * @param raw   - Raw event from the Horizon/RPC response.
 * @returns true if the event was newly indexed, false if it was a duplicate.
 */
export function indexContractEvent(
  index: InMemoryEventIndex,
  raw: {
    contractId?: string;
    emitter?: string;
    topics?: string[];
    ledger?: number;
    timestamp?: string;
    eventType?: string;
    type?: string;
    value?: unknown;
    id?: string;
  },
): boolean {
  const contractId = raw.contractId ?? "";
  const emitter = raw.emitter ?? "";
  const topics = raw.topics ?? [];
  const ledger = raw.ledger ?? 0;
  const timestamp = raw.timestamp ?? new Date().toISOString();
  const eventType = raw.eventType ?? raw.type ?? "";
  const value = raw.value;

  const base = { contractId, emitter, topics, ledger, timestamp, eventType, value };
  const id = raw.id ?? deriveSyntheticId(base);

  return index.index({ ...base, id });
}

/**
 * Query events directly from an InMemoryEventIndex without constructing
 * the class externally. Mirrors the acceptance criteria's `queryContractEvents` shape.
 */
export function queryIndexedEvents(
  index: InMemoryEventIndex,
  filter?: IndexedEventFilter,
  page?: IndexedEventPage,
): IndexedEventQueryResult {
  return index.query(filter, page);
}
