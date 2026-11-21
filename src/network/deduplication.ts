/**
 * Request deduplication (#971).
 *
 * When several parts of an app ask for the same data at the same time, only
 * one underlying request needs to be made. {@link RequestDeduplicator} tracks
 * in-flight requests by URL + params and hands every identical concurrent
 * caller the same promise, so they all receive the same response (or the same
 * error).
 *
 * This is deliberately *not* a cache: an entry lives only while its request is
 * in flight and is removed as soon as it settles (success or failure), so a
 * later call always issues a fresh request.
 *
 * ```ts
 * const dedup = new RequestDeduplicator();
 * const load = () => dedup.dedupe(url, () => fetchJson(url), { account });
 * const [a, b] = await Promise.all([load(), load()]); // one network call
 * ```
 *
 * The shared response is the same object for every caller; treat it as
 * read-only.
 */

/** Counters describing how a {@link RequestDeduplicator} has been used. */
export interface DeduplicationStats {
  /** Requests currently in flight. */
  inFlight: number;
  /** Underlying requests actually executed. */
  executed: number;
  /** Calls that joined an already in-flight request instead of executing. */
  deduplicated: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

/**
 * Build the identity of a request from its URL and params. Param key order
 * does not matter, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are identical.
 */
export function buildRequestKey(url: string, params?: unknown): string {
  return `${url}\u0000${JSON.stringify(stableValue(params ?? null))}`;
}

/** Combines identical concurrent requests into a single in-flight request. */
export class RequestDeduplicator {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private executed = 0;
  private deduplicated = 0;

  /**
   * Run `fetcher` for `url` + `params`, unless an identical request is already
   * in flight, in which case that request's result is shared.
   *
   * A rejected request rejects every caller that joined it, and is forgotten
   * immediately so the next call retries from scratch.
   *
   * @param url     - Request URL (part of the identity).
   * @param fetcher - Performs the real request. Called at most once per
   *                  identical in-flight request.
   * @param params  - Request params (part of the identity); key order is ignored.
   */
  dedupe<T>(
    url: string,
    fetcher: () => Promise<T>,
    params?: unknown,
  ): Promise<T> {
    const key = buildRequestKey(url, params);
    const existing = this.inFlight.get(key);
    if (existing) {
      this.deduplicated += 1;
      return existing as Promise<T>;
    }

    this.executed += 1;
    // `Promise.resolve().then` turns a synchronous throw in `fetcher` into a
    // rejection, so it is cleaned up like any other failed request.
    const pending: Promise<T> = Promise.resolve()
      .then(fetcher)
      .finally(() => {
        // Only remove our own entry; it may already have been replaced.
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Whether an identical request is currently in flight. */
  isInFlight(url: string, params?: unknown): boolean {
    return this.inFlight.has(buildRequestKey(url, params));
  }

  /** Number of requests currently in flight. */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * Forget all in-flight entries. Requests already started keep running and
   * resolve for the callers that hold them; only the sharing is dropped.
   */
  clear(): void {
    this.inFlight.clear();
  }

  /** Usage counters. */
  stats(): DeduplicationStats {
    return {
      inFlight: this.inFlight.size,
      executed: this.executed,
      deduplicated: this.deduplicated,
    };
  }
}

/** Create a {@link RequestDeduplicator}. */
export function createDeduplicator(): RequestDeduplicator {
  return new RequestDeduplicator();
}
