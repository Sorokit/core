/**
 * Event deduplication index for real-time contract event streaming (#541).
 *
 * The Soroban RPC `getEvents` cursor only advances per page — overlapping
 * ledger ranges can re-deliver events. `EventIndex` uses a hash of each event's
 * stable identifiers to suppress duplicates while bounding memory usage.
 */

import type { EventIndexFilter } from "./types";
import type { ContractEvent } from "./subscribeContractEvents";

/**
 * FNV-1a hash, returned as a 32-bit unsigned integer.
 * Deterministic and dependency-free, so it runs identically in Node and
 * browsers. The digest is compact, not collision-free;
 * canonicalEventKey is the collision-safe identity.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function topicPart(topic: string | null | undefined): string {
  if (topic == null) return "";
  // Accept either raw strings (Horizon records) or base64-encoded XDR topics.
  return String(topic);
}

/**
 * Build a stable hash for a contract event.
 *
 * Prefers the RPC-provided `id`/`pagingToken` when present — they are unique
 * per event on a given node. As a fallback, hashes the identity-bearing fields
 * (contract id, ledger, transaction hash, paging token, topic) so identical
 * events re-delivered across a cursor boundary still collide.
 */
export function hashEvent(event: ContractEvent): string {
  const id = String(event.id ?? "");
  if (id && id !== "undefined") {
    const pagingToken = String(event.pagingToken ?? event.txHash ?? "");
    return `id:${pagingToken}${id}`;
  }

  const contractId = String(event.contractId ?? event.contract_id ?? "");
  const ledger = String(event.ledger ?? "");
  const txHash = String(event.txHash ?? event.tx_hash ?? "");
  const pagingToken = String(event.pagingToken ?? event.paging_token ?? "");
  const topics = (event.topics ?? event.topic ?? [])
    .map(topicPart)
    .join("|");
  const value = String(event.value ?? "");

  const canonical = [
    contractId,
    ledger,
    txHash,
    pagingToken,
    topics,
    value,
  ].join("::");
  return `hash:${hashString(canonical).toString(36)}`;
}

/**
 * Bounded in-memory index of recently-seen events.
 *
 * Purely uses sampling of the insertion order (`Set` iteration order) to evict
 * the oldest entries once the capacity is reached, bounding memory use while
 * keeping the stream deduplicated.
 */
export class EventIndex {
  private readonly seen = new Set<string>();
  private readonly entries: ContractEvent[] = [];
  private readonly maxSize: number;

  /**
   * @param maxSize - Maximum number of event hashes to retain. Defaults to 10000.
   */
  constructor(maxSize = 10_000) {
    this.maxSize = maxSize > 0 ? Math.floor(maxSize) : 10_000;
  }

  /** Whether this event has already been seen (without marking it). */
  has(event: ContractEvent): boolean {
    return this.seen.has(canonicalEventKey(event));
  }

  /**
   * Mark the event as seen. Returns `true` when it was a duplicate
   * (already present), `false` on first sight.
   */
  add(event: ContractEvent): boolean {
    const key = canonicalEventKey(event);
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.entries.push(event);
    this.evictIfNeeded();
    return false;
  }

  /** Order-independent clear — used for test isolation. */
  clear(): void {
    this.seen.clear();
    this.entries.length = 0;
  }

  /** Number of events currently retained. */
  /** Snapshot of every retained event, in insertion order. */
  allEvents(): ContractEvent[] {
    return [...this.entries];
  }

  query(filter?: EventIndexFilter): ContractEvent[] {
    let events = this.allEvents();

    if (!filter) return events;

    if (filter.contractId !== undefined) {
      const cid = filter.contractId;
      events = events.filter((e) => String(e.contractId ?? "") === cid);
    }

    if (filter.name !== undefined) {
      const name = filter.name;
      events = events.filter((e) => String(e.name ?? "") === name);
    }

    if (filter.topics !== undefined && filter.topics.length > 0) {
      const filterTopics = filter.topics;
      events = events.filter((e) => {
        const eventTopics = Array.isArray(e.topics) ? e.topics : [];
        return filterTopics.some((ft) => eventTopics.includes(ft));
      });
    }

    if (filter.minLedger !== undefined) {
      const min = filter.minLedger;
      events = events.filter((e) => {
        const ledger = (e as any).ledger;
        return typeof ledger === "number" && ledger >= min;
      });
    }

    if (filter.maxLedger !== undefined) {
      const max = filter.maxLedger;
      events = events.filter((e) => {
        const ledger = (e as any).ledger;
        return typeof ledger === "number" && ledger <= max;
      });
    }

    if (filter.predicate !== undefined) {
      const predicate = filter.predicate;
      events = events.filter((e) => predicate(e));
    }

    return events;
  }

  /**
   * Remove exact duplicate events.
   *
   * @returns The number of duplicate events removed.
   */
  deduplicate(): number {
    const seen = new Set<string>();
    const unique: ContractEvent[] = [];

    for (const event of this.entries) {
      const key = canonicalEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(event);
    }

    const removed = this.entries.length - unique.length;

    this.entries.length = 0;
    this.seen.clear();

    for (const event of unique) {
      this.entries.push(event);
      this.seen.add(canonicalEventKey(event));
    }

    return removed;
  }

  /** Total number of stored events. */
  get size(): number {
    return this.seen.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.length > this.maxSize) {
      const oldest = this.entries.shift();
      if (oldest === undefined) break;
      this.seen.delete(canonicalEventKey(oldest));
    }
  }
}

/**
 * Convenience filter: `events.filter((event) => index.isNew(event))` marks
 * new events as seen and drops anything already indexed.
 */
export function filterNewEvents<T extends ContractEvent>(
  index: EventIndex,
  events: T[],
): T[] {
  const fresh: T[] = [];
  for (const event of events) {
    if (index.add(event)) continue;
    fresh.push(event);
  }
  return fresh;
}

/** Length-framed tuple: unambiguous boundaries for concatenated parts. */
function frame(parts: readonly (string | number)[]): string {
  return parts.map((p) => `${String(p).length}:${String(p)}`).join("|");
}

/** Deterministic structural serialization of nested payload values. */
function canon(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === "string") return `s${frame([v as string])}`;
  if (t !== "object") return `${t}:${String(v)}`;
  if (Array.isArray(v)) return `a[${v.map(canon).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const ks = Object.keys(rec).sort();
  return `o{${ks.map((k) => `${frame([k])}=${canon(rec[k])}`).join(",")}}`;
}

/** Collision-safe canonical identity (framed parts, structural payload). */
export function canonicalEventKey(event: ContractEvent): string {
  const id = typeof event.id === "string" ? event.id : "";
  const tok = typeof event.pagingToken === "string" ? event.pagingToken : "";
  const txh = typeof event.txHash === "string" ? event.txHash : "";
  if (id !== "") return `id|${frame([tok || txh, id])}`;
  const cid =
    typeof event.contractId === "string" && event.contractId !== ""
      ? event.contractId
      : typeof event.contract_id === "string"
        ? event.contract_id
        : "";
  return `ev|${frame([
    cid,
    String(event.ledger ?? ""),
    txh,
    tok,
    canon(event.topics ?? event.topic ?? null),
    canon(event.value ?? null),
  ])}`;
}
