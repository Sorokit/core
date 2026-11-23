import { describe, it, expect, vi } from "vitest";
import {
  RequestDeduplicator,
  createDeduplicator,
  buildRequestKey,
} from "./deduplication";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RequestDeduplicator", () => {
  it("creates an instance via the factory", () => {
    expect(createDeduplicator()).toBeInstanceOf(RequestDeduplicator);
  });

  it("runs the fetcher once for identical concurrent requests", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const calls = [1, 2, 3, 4, 5].map(() => dedup.dedupe("/accounts/G1", fetcher, { a: 1 }));
    gate.resolve("payload");

    expect(await Promise.all(calls)).toEqual(Array(5).fill("payload"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(dedup.stats()).toMatchObject({ executed: 1, deduplicated: 4, inFlight: 0 });
  });

  it("shares the very same response object", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<{ n: number }>();
    const a = dedup.dedupe("/x", () => gate.promise);
    const b = dedup.dedupe("/x", () => gate.promise);
    gate.resolve({ n: 1 });
    expect(await a).toBe(await b);
  });

  it("treats params with different key order as identical", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<number>();
    const fetcher = vi.fn(() => gate.promise);

    const a = dedup.dedupe("/x", fetcher, { a: 1, b: { c: 2, d: 3 } });
    const b = dedup.dedupe("/x", fetcher, { b: { d: 3, c: 2 }, a: 1 });
    gate.resolve(7);

    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not combine requests that differ by URL or params", async () => {
    const dedup = new RequestDeduplicator();
    const fetcher = vi.fn(async () => "ok");

    await Promise.all([
      dedup.dedupe("/a", fetcher, { id: 1 }),
      dedup.dedupe("/a", fetcher, { id: 2 }),
      dedup.dedupe("/b", fetcher, { id: 1 }),
      dedup.dedupe("/a", fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not cache: a call after completion issues a new request", async () => {
    const dedup = new RequestDeduplicator();
    const fetcher = vi.fn(async () => "ok");

    await dedup.dedupe("/x", fetcher);
    await dedup.dedupe("/x", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cleans up completed requests", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<string>();
    const pending = dedup.dedupe("/x", () => gate.promise);

    expect(dedup.size).toBe(1);
    expect(dedup.isInFlight("/x")).toBe(true);

    gate.resolve("done");
    await pending;

    expect(dedup.size).toBe(0);
    expect(dedup.isInFlight("/x")).toBe(false);
  });

  it("shares a failure with every caller and then forgets it", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const a = dedup.dedupe("/x", fetcher);
    const b = dedup.dedupe("/x", fetcher);
    gate.reject(new Error("boom"));

    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect(dedup.size).toBe(0);

    const retry = vi.fn(async () => "recovered");
    await expect(dedup.dedupe("/x", retry)).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("cleans up when the fetcher throws synchronously", async () => {
    const dedup = new RequestDeduplicator();
    await expect(
      dedup.dedupe("/x", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(dedup.size).toBe(0);
  });

  it("clear() drops sharing but lets running requests finish", async () => {
    const dedup = new RequestDeduplicator();
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const first = dedup.dedupe("/x", fetcher);
    dedup.clear();
    expect(dedup.size).toBe(0);

    const second = dedup.dedupe("/x", fetcher);
    gate.resolve("v");

    expect(await Promise.all([first, second])).toEqual(["v", "v"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(dedup.size).toBe(0);
  });

  it("does not leak entries across many requests", async () => {
    const dedup = new RequestDeduplicator();
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) => dedup.dedupe(`/item/${i % 50}`, async () => i)),
    );
    expect(dedup.size).toBe(0);
    expect(dedup.stats().executed).toBe(50);
  });

  it("collapses a large concurrent burst into one request (performance)", async () => {
    const dedup = new RequestDeduplicator();
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "data";
    });

    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5000 }, () => dedup.dedupe("/hot", fetcher, { page: 1 })),
    );
    const elapsed = Date.now() - started;

    expect(results.every((r) => r === "data")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 5000 callers cost one 20ms request, not 5000 sequential/parallel ones.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("buildRequestKey", () => {
  it("is stable across param key order and distinguishes values", () => {
    expect(buildRequestKey("/x", { a: 1, b: 2 })).toBe(buildRequestKey("/x", { b: 2, a: 1 }));
    expect(buildRequestKey("/x", { a: 1 })).not.toBe(buildRequestKey("/x", { a: 2 }));
    expect(buildRequestKey("/x")).toBe(buildRequestKey("/x", undefined));
  });
});
