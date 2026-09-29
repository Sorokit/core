import { describe, expect, it, vi } from "vitest";
import { createRequestBatcher } from "../network/requestBatching";
import type { BatchFetcher } from "../network/requestBatching";

describe("createRequestBatcher", () => {
  it("batches identical concurrent requests into a single batchFetcher call (10 concurrent -> 1 request)", async () => {
    const impl: BatchFetcher<string, number> = async (keys) => {
      const map = new Map<string, number>();
      for (const key of keys) map.set(key, key.length);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 10 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => batcher.request("GABC1234")),
    );

    expect(results).toEqual(Array(10).fill("GABC1234".length));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(["GABC1234"]);
    expect(batcher.getStats()).toMatchObject({ totalRequests: 10, totalBatches: 1, lastBatchSize: 1 });
  });

  it("collects distinct keys made within the window into one batch call", async () => {
    const impl: BatchFetcher<string, string> = async (keys) => {
      const map = new Map<string, string>();
      for (const key of keys) map.set(key, `value-${key}`);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 20 });

    const [a, b, c] = await Promise.all([
      batcher.request("key-a"),
      batcher.request("key-b"),
      batcher.request("key-c"),
    ]);

    expect([a, b, c]).toEqual(["value-key-a", "value-key-b", "value-key-c"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Set(fetcher.mock.calls[0]?.[0])).toEqual(new Set(["key-a", "key-b", "key-c"]));
  });

  it("splits results back to the correct caller by key", async () => {
    const impl: BatchFetcher<number, string> = async (keys) => {
      const map = new Map<number, string>();
      for (const key of keys) map.set(key, `account-${key}`);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 10 });

    const [r1, r2, r3] = await Promise.all([
      batcher.request(1),
      batcher.request(2),
      batcher.request(3),
    ]);

    expect(r1).toBe("account-1");
    expect(r2).toBe("account-2");
    expect(r3).toBe("account-3");
  });

  it("fires immediately once maxBatch distinct keys are queued, without waiting for the full window", async () => {
    const impl: BatchFetcher<number, number> = async (keys) => {
      const map = new Map<number, number>();
      for (const key of keys) map.set(key, key * 2);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 5000, maxBatch: 3 });

    const start = Date.now();
    const results = await Promise.all([
      batcher.request(1),
      batcher.request(2),
      batcher.request(3),
    ]);
    const elapsedMs = Date.now() - start;

    expect(results).toEqual([2, 4, 6]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Should resolve almost immediately, not after the 5s window.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("starts a fresh batch after the previous window has flushed", async () => {
    const impl: BatchFetcher<string, string> = async (keys) => {
      const map = new Map<string, string>();
      for (const key of keys) map.set(key, key.toUpperCase());
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 5 });

    const first = await batcher.request("one");
    const second = await batcher.request("two");

    expect(first).toBe("ONE");
    expect(second).toBe("TWO");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(batcher.getStats().totalBatches).toBe(2);
  });

  it("rejects every waiter for a key the batchFetcher didn't return a result for", async () => {
    const impl: BatchFetcher<string, string> = async () => new Map();
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 10 });

    await expect(batcher.request("missing")).rejects.toThrow(/did not return a result/);
  });

  it("rejects every pending waiter in a batch when batchFetcher itself throws", async () => {
    const impl: BatchFetcher<string, string> = async () => {
      throw new Error("network down");
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 10 });

    const [r1, r2] = await Promise.allSettled([
      batcher.request("a"),
      batcher.request("b"),
    ]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    if (r1.status === "rejected") expect((r1.reason as Error).message).toBe("network down");
  });

  it("bypasses batching entirely when disabled, calling batchFetcher once per request", async () => {
    const impl: BatchFetcher<string, number> = async (keys) => {
      const map = new Map<string, number>();
      for (const key of keys) map.set(key, 1);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { enabled: false, windowMs: 1000 });

    await Promise.all([batcher.request("x"), batcher.request("x"), batcher.request("y")]);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses a custom keyFn to dedupe structurally-equal but referentially-distinct keys", async () => {
    const impl: BatchFetcher<{ id: string }, string> = async (keys) => {
      const map = new Map<{ id: string }, string>();
      for (const key of keys) map.set(key, `resolved-${key.id}`);
      return map;
    };
    const fetcher = vi.fn(impl);

    const batcher = createRequestBatcher(fetcher, { windowMs: 10 }, (key) => key.id);

    const [r1, r2] = await Promise.all([
      batcher.request({ id: "same" }),
      batcher.request({ id: "same" }),
    ]);

    expect(r1).toBe("resolved-same");
    expect(r2).toBe("resolved-same");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
