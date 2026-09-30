export interface ContractEvent {
  id?: string;
  contractId?: string;
  contract_id?: string;
  emitter?: string;
  eventType?: string;
  name?: string;
  topics?: Array<string | null | undefined>;
  topic?: Array<string | null | undefined>;
  timestamp?: string | number;
  ledger?: number;
  value?: unknown;
  [key: string]: unknown;
}

export interface ContractEventFilter {
  name?: string;
  eventType?: string;
  emitter?: string;
  topics?: Array<string | RegExp>;
  topicPatterns?: Array<string | RegExp>;
  contractId?: string;
  and?: ContractEventFilter[];
  or?: ContractEventFilter[];
}

export type EventFilterPredicate = (event: ContractEvent) => boolean;

export interface ContractEventSubscriptionOptions {
  horizonUrl: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  limit?: number;
  /** Maximum age (ms) before a seen-event entry is evicted. Default: 1 hour. */
  deduplicationTtlMs?: number;
  /** Maximum number of entries in the seen-event deduplication set. Default: 10000. */
  deduplicationMaxSize?: number;
  /** Maximum age (ms) of missed ledgers to recover after reconnection. Default: 60000 (1 minute). */
  recoveryWindowMs?: number;
}

/** Default TTL for deduplication entries: 1 hour (3,600,000 ms). */
export const DEFAULT_DEDUPLICATION_TTL_MS = 60 * 60 * 1000;

/** Default maximum number of entries in the deduplication set. */
export const DEFAULT_DEDUPLICATION_MAX_SIZE = 10_000;

/** Default recovery window: 1 minute (60,000 ms). */
export const DEFAULT_RECOVERY_WINDOW_MS = 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTimestamp(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function readEventRecord(raw: unknown): ContractEvent | null {
  if (!isRecord(raw)) return null;

  const topics = Array.isArray(raw.topics)
    ? raw.topics.filter((topic): topic is string => typeof topic === "string")
    : Array.isArray(raw.topic)
      ? raw.topic.filter((topic): topic is string => typeof topic === "string")
      : [];
  const timestamp = readTimestamp(raw.timestamp ?? raw.closed_at ?? raw.closedAt);

  return {
    ...(raw as Record<string, unknown>),
    id: String(raw.id ?? raw.event_id ?? raw.eventId ?? raw.paging_token ?? ""),
    contractId: String(raw.contractId ?? raw.contract_id ?? raw.contractID ?? ""),
    emitter: String(raw.emitter ?? raw.source_account ?? raw.sourceAccount ?? ""),
    eventType: String(raw.eventType ?? raw.event_type ?? raw.name ?? ""),
    name: String(raw.name ?? raw.event_type ?? raw.eventType ?? ""),
    topics,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(typeof raw.ledger === "number" ? { ledger: raw.ledger } : {}),
  };
}

function readRecords(payload: unknown): ContractEvent[] {
  if (Array.isArray(payload)) return payload.map(readEventRecord).filter(Boolean) as ContractEvent[];

  if (!isRecord(payload)) return [];

  const embedded = payload._embedded;
  const records = Array.isArray(payload.records)
    ? payload.records
    : isRecord(embedded) && Array.isArray(embedded.records)
      ? embedded.records
      : [];

  return records.map(readEventRecord).filter(Boolean) as ContractEvent[];
}

function matchesTopicPattern(topic: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(topic);
  }
  return topic === pattern;
}

/**
 * Evict entries from the seen-event map that are older than `ttlMs` or that
 * exceed `maxSize` (FIFO removal when cap is reached).
 */
function evictSeenEvents(
  seen: Map<string, number>,
  ttlMs: number,
  maxSize: number,
): void {
  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > ttlMs) {
      seen.delete(id);
    }
  }
  if (seen.size > maxSize) {
    // FIFO: delete oldest entries first
    const entries = [...seen.entries()].sort((a, b) => a[1] - b[1]);
    const excess = seen.size - maxSize;
    for (let i = 0; i < excess; i++) {
      const entry = entries[i];
      if (entry) {
        seen.delete(entry[0]);
      }
    }
  }
}

function matchesFilter(event: ContractEvent, filter?: ContractEventFilter): boolean {
  if (!filter) return true;

  if (filter.name || filter.eventType) {
    const eventName = typeof event.name === "string" ? event.name : "";
    const eventType = typeof event.eventType === "string" ? event.eventType : eventName;
    if (filter.name && eventName !== filter.name) return false;
    if (filter.eventType && eventType !== filter.eventType) return false;
  }

  if (filter.contractId) {
    const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
    if (eventContractId !== filter.contractId) return false;
  }

  if (filter.emitter) {
    const eventEmitter = typeof event.emitter === "string" ? event.emitter : "";
    if (eventEmitter !== filter.emitter) return false;
  }

  const topicPatterns = filter.topics ?? filter.topicPatterns;
  if (topicPatterns?.length) {
    const topics = Array.isArray(event.topics) ? event.topics : [];
    const matchesTopic = topics.some((topic) =>
      topic != null && topicPatterns.some((pattern) => matchesTopicPattern(topic, pattern)),
    );
    if (!matchesTopic) return false;
  }

  if (filter.and && !filter.and.every((nestedFilter) => matchesFilter(event, nestedFilter))) {
    return false;
  }
  if (filter.or && filter.or.length > 0 && !filter.or.some((nestedFilter) => matchesFilter(event, nestedFilter))) {
    return false;
  }

  return true;
}

function matchesEventFilter(
  event: ContractEvent,
  filter?: ContractEventFilter | EventFilterPredicate,
): boolean {
  return typeof filter === "function" ? filter(event) : matchesFilter(event, filter);
}

export function filterContractEvents(
  events: readonly ContractEvent[],
  filter?: ContractEventFilter | EventFilterPredicate,
): ContractEvent[] {
  if (!filter) return events.slice();
  const predicate = typeof filter === "function" ? filter : (event: ContractEvent) => matchesFilter(event, filter);
  return events.filter(predicate);
}

export function andEventFilters(...filters: Array<ContractEventFilter | EventFilterPredicate>): EventFilterPredicate {
  return (event) => filters.every((filter) =>
    typeof filter === "function" ? filter(event) : matchesFilter(event, filter),
  );
}

export function orEventFilters(...filters: Array<ContractEventFilter | EventFilterPredicate>): EventFilterPredicate {
  return (event) => filters.some((filter) =>
    typeof filter === "function" ? filter(event) : matchesFilter(event, filter),
  );
}

function eventTimestamp(event: ContractEvent): number | undefined {
  if (typeof event.timestamp === "number") return event.timestamp;
  if (typeof event.timestamp === "string") {
    const parsed = Date.parse(event.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Fetch events from a range of ledger sequences for a specific contract.
 * Used to recover events missed during a disconnection.
 */
async function recoverMissedEvents(
  horizonUrl: string,
  contractId: string,
  fromLedger: number,
  toLedger: number,
  requestFetch: typeof fetch,
  filter?: ContractEventFilter | EventFilterPredicate,
): Promise<ContractEvent[]> {
  const recoveredEvents: ContractEvent[] = [];
  const base = horizonUrl.replace(/\/$/, "");

  // Batch into chunks of 100 ledgers to avoid too many requests
  const batchSize = 100;
  const fromSeq = fromLedger + 1; // start after the last processed ledger

  for (let seq = fromSeq; seq <= toLedger; seq += batchSize) {
    const batchEnd = Math.min(seq + batchSize - 1, toLedger);
    const ledgerPromises: Promise<ContractEvent[]>[] = [];

    for (let ledgerSeq = seq; ledgerSeq <= batchEnd; ledgerSeq++) {
      ledgerPromises.push(
        (async () => {
          try {
            const endpoint = new URL(`${base}/ledgers/${ledgerSeq}`);
            const response = await requestFetch(endpoint.toString());
            if (!response.ok) return [];

            const payload = await response.json();
            const records = readRecords(payload);
            return records.filter((event) => {
              const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
              return eventContractId === contractId;
            }).filter((event) => matchesEventFilter(event, filter));
          } catch {
            return [];
          }
        })(),
      );
    }

    const batchResults = await Promise.all(ledgerPromises);
    for (const events of batchResults) {
      recoveredEvents.push(...events);
    }
  }

  // Sort by ledger sequence to preserve ordering
  recoveredEvents.sort((a, b) => {
    const ledgerA = typeof a.ledger === "number" ? a.ledger : 0;
    const ledgerB = typeof b.ledger === "number" ? b.ledger : 0;
    return ledgerA - ledgerB;
  });

  return recoveredEvents;
}

export function countByType(events: readonly ContractEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const type = typeof event.eventType === "string" && event.eventType
      ? event.eventType
      : typeof event.name === "string" ? event.name : "";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

export function groupByTime(
  events: readonly ContractEvent[],
  intervalMs: number,
): Map<number, ContractEvent[]> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be greater than zero");
  }
  const groups = new Map<number, ContractEvent[]>();
  for (const event of events) {
    const timestamp = eventTimestamp(event);
    if (timestamp === undefined) continue;
    const bucket = Math.floor(timestamp / intervalMs) * intervalMs;
    const group = groups.get(bucket);
    if (group) group.push(event);
    else groups.set(bucket, [event]);
  }
  return groups;
}

export function calculateRate(events: readonly ContractEvent[], windowMs?: number): number {
  if (events.length === 0) return 0;
  if (windowMs !== undefined) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be greater than zero");
    return events.length / (windowMs / 1000);
  }
  const timestamps = events.map(eventTimestamp).filter((timestamp): timestamp is number => timestamp !== undefined);
  if (timestamps.length < 2) return 0;
  const elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);
  return elapsedMs > 0 ? events.length / (elapsedMs / 1000) : 0;
}

export function subscribeContractEvents(
  contractId: string,
  eventFilter: ContractEventFilter | EventFilterPredicate | undefined,
  callback: (events: ContractEvent[]) => void,
  options: ContractEventSubscriptionOptions,
): () => void {
  const intervalMs = options.intervalMs ?? 1500;
  const requestFetch = options.fetch ?? fetch;
  const seenEventIds = new Map<string, number>();
  const deduplicationTtlMs = options.deduplicationTtlMs ?? DEFAULT_DEDUPLICATION_TTL_MS;
  const deduplicationMaxSize = options.deduplicationMaxSize ?? DEFAULT_DEDUPLICATION_MAX_SIZE;
  const recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
  let lastProcessedLedger: number | undefined;
  let polling = false;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  /**
   * Deduplicate a batch of events against the seen set, returning only
   * events not yet delivered and marking them as seen.
   */
  const deduplicateEvents = (events: ContractEvent[]): ContractEvent[] => {
    return events.filter((event) => {
      const id = String(event.id ?? `${event.contractId ?? ""}:${event.name ?? ""}`);
      if (!id || seenEventIds.has(id)) return false;
      seenEventIds.set(id, Date.now());
      return true;
    });
  };

  const scheduleNextPoll = (): void => {
    if (!active) return;

    timer = setTimeout(() => {
      void poll();
    }, intervalMs);
  };

  const poll = async (): Promise<void> => {
    if (!active || polling) return;
    polling = true;

    try {
      const endpoint = new URL(`${options.horizonUrl.replace(/\/$/, "")}/ledgers`);
      endpoint.searchParams.set("order", "desc");
      endpoint.searchParams.set("limit", "1");

      const response = await requestFetch(endpoint.toString());
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      // Extract the latest ledger sequence from either `records` or `_embedded.records`
      const rawRecords: unknown[] = Array.isArray(payload.records)
        ? payload.records
        : isRecord(payload._embedded) && Array.isArray((payload._embedded as Record<string, unknown>).records)
          ? (payload._embedded as Record<string, unknown>).records as unknown[]
          : [];
      const latestLedgerRecord = rawRecords[0];
      const latestSequence = typeof (latestLedgerRecord as Record<string, unknown> | undefined)?.sequence === "number"
        ? ((latestLedgerRecord as Record<string, unknown>).sequence as number)
        : undefined;

      // Recover missed events if we detect a gap (skip consecutive ledgers)
      let recoveredEvents: ContractEvent[] = [];
      if (
        lastProcessedLedger !== undefined &&
        latestSequence !== undefined &&
        latestSequence > lastProcessedLedger + 1
      ) {
        const recoveryLedgerStart = lastProcessedLedger;
        const estimatedLedgerAgeMs = 5500; // ~5.5s per ledger on Stellar
        const maxRecoveryLedgers = Math.ceil(recoveryWindowMs / estimatedLedgerAgeMs);
        const fromLedger = Math.max(recoveryLedgerStart, latestSequence - maxRecoveryLedgers);

        if (fromLedger < latestSequence) {
          try {
            recoveredEvents = await recoverMissedEvents(
              options.horizonUrl,
              contractId,
              fromLedger,
              latestSequence,
              requestFetch,
              eventFilter,
            );
          } catch {
            // Recovery failure is non-fatal; continue polling
          }
        }
      }

      // Process current ledger events
      const events = readRecords(payload)
        .filter((event) => {
          const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
          return eventContractId === contractId;
        })
        .filter((event) => matchesEventFilter(event, eventFilter));

      evictSeenEvents(seenEventIds, deduplicationTtlMs, deduplicationMaxSize);

      const currentNewEvents = deduplicateEvents(events);

      // Deliver recovered events first (preserves ordering: recovered → current)
      if (recoveredEvents.length > 0) {
        const dedupedRecovered = deduplicateEvents(recoveredEvents);
        if (dedupedRecovered.length > 0) {
          callback(dedupedRecovered);
        }
      }

      if (currentNewEvents.length > 0) {
        callback(currentNewEvents);
      }

      if (latestSequence !== undefined) {
        lastProcessedLedger = latestSequence;
      }
    } catch {
      // Ignore polling failures and keep the subscription alive.
    } finally {
      polling = false;
    }

    if (active) {
      scheduleNextPoll();
    }
  };

  scheduleNextPoll();

  const unsubscribe = (): void => {
    // Idempotent teardown (#707): stop scheduling, drop the pending timer,
    // release the deduplication map and deregister so SPAs don't leak.
    if (settled) return;
    settled = true;
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    seenEventIds.clear();
    activeSubscriptions.delete(unsubscribe as () => void);
  };
  activeSubscriptions.add(unsubscribe as () => void);
  maybeWarnSubscriptions();
  return unsubscribe;
}

/** Registry of live callback subscriptions (#707 — leak detection). */
const activeSubscriptions = new Set<() => void>();
let subscriptionWarned = false;

/** Number of currently active `subscribeContractEvents` subscriptions. */
export function getActiveContractEventSubscriptionCount(): number {
  return activeSubscriptions.size;
}

/** Unsubscribe every active contract-event subscription. Returns count removed. */
export function unsubscribeAllContractEvents(): number {
  const subs = [...activeSubscriptions];
  for (const unsub of subs) {
    try {
      unsub();
    } catch {
      activeSubscriptions.delete(unsub);
    }
  }
  return subs.length;
}

function maybeWarnSubscriptions(): void {
  if (subscriptionWarned) return;
  if (activeSubscriptions.size > 50 && typeof console !== "undefined") {
    subscriptionWarned = true;
    console.warn(
      `[sorokit] ${activeSubscriptions.size} active contract-event subscriptions; ` +
      "ensure unsubscribe() is called on unmount to avoid leaks (see unsubscribeAllContractEvents).",
    );
  }
}

/** Reset subscription leak tracking (tests / dev). */
export function resetContractEventSubscriptionTracking(): void {
  activeSubscriptions.clear();
  subscriptionWarned = false;
}

/**
 * Sleep that resolves early on abort without leaking listeners (#707).
 * The abort listener is always removed exactly once, whether the timer
 * fires, the signal aborts, or the signal was already aborted.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stream Soroban contract events as an async generator.
 *
 * Polls the Horizon endpoint at a configurable interval and yields new events
 * as they arrive. Deduplicates by event ID so the same event is never yielded
 * twice. The generator runs until the provided `AbortSignal` is aborted or the
 * caller breaks out of the `for await` loop.
 *
 * This is the generator-based counterpart of `subscribeContractEvents()` and
 * is more ergonomic when using `for await...of` loops.
 *
 * @param contractId - Soroban contract address to monitor.
 * @param filter     - Optional filter criteria (name, topicPatterns, contractId).
 * @param options    - Horizon URL, polling interval, and optional fetch override.
 * @param signal     - Optional AbortSignal to stop the stream externally.
 * @yields Arrays of new `ContractEvent` objects as they are detected.
 *
 * @example
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 30_000);
 * for await (const events of streamContractEvents("C123", undefined, { horizonUrl }, ac.signal)) {
 *   console.log("new events:", events);
 * }
 */
export async function* streamContractEvents(
  contractId: string,
  filter: ContractEventFilter | EventFilterPredicate | undefined,
  options: ContractEventSubscriptionOptions,
  signal?: AbortSignal,
): AsyncGenerator<ContractEvent[]> {
  const intervalMs = options.intervalMs ?? 1500;
  const requestFetch = options.fetch ?? fetch;
  const seenEventIds = new Map<string, number>();
  const deduplicationTtlMs = options.deduplicationTtlMs ?? DEFAULT_DEDUPLICATION_TTL_MS;
  const deduplicationMaxSize = options.deduplicationMaxSize ?? DEFAULT_DEDUPLICATION_MAX_SIZE;
  const recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
  let lastProcessedLedger: number | undefined;

  /**
   * Deduplicate a batch of events against the seen set, returning only
   * events not yet delivered and marking them as seen.
   */
  const deduplicateEvents = (events: ContractEvent[]): ContractEvent[] => {
    return events.filter((event) => {
      const id = String(event.id ?? `${event.contractId ?? ""}:${event.name ?? ""}`);
      if (!id || seenEventIds.has(id)) return false;
      seenEventIds.set(id, Date.now());
      return true;
    });
  };

  while (!signal?.aborted) {
    try {
      const endpoint = new URL(`${options.horizonUrl.replace(/\/$/, "")}/ledgers`);
      endpoint.searchParams.set("order", "desc");
      endpoint.searchParams.set("limit", "1");

      const response = await requestFetch(endpoint.toString());
      if (response.ok) {
        const payload = await response.json();
        // Extract the latest ledger sequence from either `records` or `_embedded.records`
        const rawRecords: unknown[] = Array.isArray(payload.records)
          ? payload.records
          : isRecord(payload._embedded) && Array.isArray((payload._embedded as Record<string, unknown>).records)
            ? (payload._embedded as Record<string, unknown>).records as unknown[]
            : [];
        const latestLedgerRecord = rawRecords[0];
        const latestSequence = typeof (latestLedgerRecord as Record<string, unknown> | undefined)?.sequence === "number"
          ? ((latestLedgerRecord as Record<string, unknown>).sequence as number)
          : undefined;

        // Recover missed events if we detect a gap (skip consecutive ledgers)
        let recoveredEvents: ContractEvent[] = [];
        if (
          lastProcessedLedger !== undefined &&
          latestSequence !== undefined &&
          latestSequence > lastProcessedLedger + 1
        ) {
          const estimatedLedgerAgeMs = 5500;
          const maxRecoveryLedgers = Math.ceil(recoveryWindowMs / estimatedLedgerAgeMs);
          const fromLedger = Math.max(lastProcessedLedger, latestSequence - maxRecoveryLedgers);

          if (fromLedger < latestSequence) {
            try {
              recoveredEvents = await recoverMissedEvents(
                options.horizonUrl,
                contractId,
                fromLedger,
                latestSequence,
                requestFetch,
                filter,
              );
            } catch {
              // Recovery failure is non-fatal; continue stream
            }
          }
        }

        const events = readRecords(payload)
          .filter((event) => {
            const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
            return eventContractId === contractId;
          })
          .filter((event) => matchesEventFilter(event, filter));

        evictSeenEvents(seenEventIds, deduplicationTtlMs, deduplicationMaxSize);

        const currentNewEvents = deduplicateEvents(events);

        // Combine recovered + current events into a single yield (preserves ordering)
        const dedupedRecovered = deduplicateEvents(recoveredEvents);
        const combined = [...dedupedRecovered, ...currentNewEvents];
        if (combined.length > 0) {
          yield combined;
        }

        if (latestSequence !== undefined) {
          lastProcessedLedger = latestSequence;
        }
      }
    } catch {
      // Ignore transient polling failures and continue the stream.
    }

    if (signal?.aborted) return;

    await sleepWithAbort(intervalMs, signal);
  };
  // Release deduplication memory when the generator terminates (#707).
  seenEventIds.clear();
}

export async function queryContractEvents(
  contractId: string,
  filter?: ContractEventFilter | EventFilterPredicate,
  options?: ContractEventSubscriptionOptions,
): Promise<ContractEvent[]> {
  const requestFetch = options?.fetch ?? globalThis.fetch;

  try {
    const horizonUrl = options?.horizonUrl ?? "https://horizon-testnet.stellar.org";
    const endpoint = new URL(`${horizonUrl.replace(/\/$/, "")}/events`);
    endpoint.searchParams.set("contractId", contractId);
    endpoint.searchParams.set("order", "desc");
    if (options?.limit !== undefined) {
      endpoint.searchParams.set("limit", String(options.limit));
    }

    const response = await requestFetch(endpoint.toString());
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const events = readRecords(payload)
      .filter((event) => matchesEventFilter(event, filter));

    return events;
  } catch {
    return [];
  }
}
