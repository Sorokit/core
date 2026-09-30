import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, deduplicateRequest } from "./rateLimiter";

describe("rate limiter", () => {
  it("queues work beyond the configured window limit", async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter(2, 1_000, { maxRetries: 0 });
    const starts: number[] = [];
    const tasks = [1, 2, 3].map((value) => limiter.execute(async () => { starts.push(Date.now()); return value; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(2);
    expect(limiter.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await Promise.all(tasks)).every((result) => result.status === "ok")).toBe(true);
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(1_000);
    vi.useRealTimers();
  });

  it("retries failures with exponential backoff", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue("done");
    const promise = createRateLimiter(1, 1, { initialBackoffMs: 50 }).execute(operation);
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ status: "ok", data: "done" });
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("deduplicates concurrent requests and clears completed entries", async () => {
    const operation = vi.fn(async () => "response");
    const [first, second] = await Promise.all([
      deduplicateRequest("account:GABC", operation),
      deduplicateRequest("account:GABC", operation),
    ]);
    expect(first).toEqual(second);
    expect(operation).toHaveBeenCalledTimes(1);
    await deduplicateRequest("account:GABC", operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
