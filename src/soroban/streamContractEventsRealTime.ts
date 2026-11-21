/**
 * streamContractEventsRealTime — real-time contract event streaming with
 * automatic reconnection and exponential backoff.
 */

import type { ContractEvent, ContractEventFilter } from "./subscribeContractEvents";
import type { StreamContractEventsOptions } from "./types";

/** Type alias for the options accepted by {@link streamContractEventsRealTime}. */
export type StreamContractEventsRealTimeOptions = StreamContractEventsOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readEventRecord(raw: unknown): ContractEvent | null {
  if (!isRecord(raw)) return null;

  const topics = Array.isArray(raw.topics)
    ? raw.topics.filter((t): t is string => typeof t === "string")
    : Array.isArray(raw.topic)
      ? raw.topic.filter((t): t is string => typeof t === "string")
      : [];

  return {
    ...(raw as Record<string, unknown>),
    id: String(raw.id ?? raw.event_id ?? raw.eventId ?? ""),
    contractId: String(raw.contractId ?? raw.contract_id ?? raw.contractID ?? ""),
    name: String(raw.name ?? raw.event_type ?? raw.eventType ?? ""),
    topics,
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

function matchesFilter(event: ContractEvent, filter?: ContractEventFilter): boolean {
  if (!filter) return true;

  if (filter.name) {
    const eventName = typeof event.name === "string" ? event.name : "";
    if (eventName !== filter.name) return false;
  }

  if (filter.contractId) {
    const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
    if (eventContractId !== filter.contractId) return false;
  }

  if (filter.topicPatterns?.length) {
    const topics = Array.isArray(event.topics) ? event.topics : [];
    const matchesTopic = topics.some((topic) =>
      topic != null &&
      filter.topicPatterns!.some((pattern) =>
        pattern instanceof RegExp ? pattern.test(topic) : topic === pattern,
      ),
    );
    if (!matchesTopic) return false;
  }

  return true;
}

/**
 * Start a real-time streaming subscription to contract events.
 *
 * Polls the Horizon `/ledgers` endpoint on a configurable interval and emits
 * new (deduplicated) events via `options.onEvent`. On network failure the
 * interval doubles (capped at `maxBackoffMs`) and `options.onReconnect` is
 * called on every retry after the first.
 *
 * @returns An object with a `stop()` method to cancel the subscription.
 */
export function streamContractEventsRealTime(
  contractId: string,
  filter: ContractEventFilter | undefined,
  options: StreamContractEventsOptions,
): { stop: () => void } {
  const baseInterval = options.intervalMs ?? 1500;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const emptyPollDelay = options.emptyPollDelayMs ?? baseInterval;
  const requestFetch = options.fetch ?? fetch;

  let backoffMs = baseInterval;
  let attempt = 0;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seenEventIds = new Set<string>();

  const scheduleNext = (): void => {
    if (!active) return;
    timer = setTimeout(() => {
      void poll();
    }, backoffMs);
  };

  const poll = async (): Promise<void> => {
    if (!active) return;

    try {
      const endpoint = new URL(`${options.horizonUrl.replace(/\/$/, "")}/ledgers`);
      endpoint.searchParams.set("order", "desc");
      endpoint.searchParams.set("limit", "1");

      const response = await requestFetch(endpoint.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const events = readRecords(payload)
        .filter((event) => {
          const eventContractId = typeof event.contractId === "string" ? event.contractId : "";
          return eventContractId === contractId;
        })
        .filter((event) => matchesFilter(event, filter));

      const newEvents = events.filter((event) => {
        const id = String(event.id ?? `${event.contractId ?? ""}:${event.name ?? ""}`);
        if (!id || seenEventIds.has(id)) return false;
        seenEventIds.add(id);
        return true;
      });

      // Success — reset backoff; use emptyPollDelay when no new events
      attempt = 0;
      if (newEvents.length > 0) {
        backoffMs = baseInterval;
        options.onEvent(newEvents);
      } else {
        backoffMs = emptyPollDelay;
      }
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      options.onError?.(error, attempt);
      if (attempt > 0) {
        options.onReconnect?.(attempt);
      }
      attempt++;
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }

    scheduleNext();
  };
  scheduleNext();
  return { stop: () => { active = false; clearTimeout(timer); } };
}
