import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, deduplicateRequest, SorokitRateLimitError, withRateLimit } from "./rateLimiter";

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

  it("rejects requests beyond the queue limit while slow operations are pending", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter(1, 1_000, { maxRetries: 0, maxQueueSize: 1 });
      let finishFirst: (value: string) => void = () => {};
      const first = limiter.execute(() => new Promise<string>((resolve) => {
        finishFirst = resolve;
      }));
      await vi.advanceTimersByTimeAsync(0);

      const second = limiter.execute(async () => "second");
      expect(limiter.pending).toBe(1);
      const overflow = await limiter.execute(async () => "third");
      expect(overflow).toMatchObject({ status: "error", error: { code: "RATE_LIMITED" } });
      expect(limiter.pending).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await second).toMatchObject({ status: "ok", data: "second" });
      finishFirst("first");
      expect(await first).toMatchObject({ status: "ok", data: "first" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows immediate work with a zero-sized waiting queue", async () => {
    const limiter = createRateLimiter(1, 1_000, { maxQueueSize: 0 });
    const result = await limiter.execute(async () => "immediate");

    expect(result).toMatchObject({ status: "ok", data: "immediate" });
    expect(limiter.pending).toBe(0);
  });

  it("rejects invalid queue limits", () => {
    expect(() => createRateLimiter(1, 1_000, { maxQueueSize: -1 })).toThrow();
    expect(() => createRateLimiter(1, 1_000, { maxQueueSize: 1.5 })).toThrow();
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

describe("withRateLimit (#864)", () => {
  it("applies a per-method override instead of the global default", async () => {
    const calls: string[] = [];
    const client = {
      cheap: async (id: string) => {
        calls.push(`cheap:${id}`);
        return `cheap-result-${id}`;
      },
      expensive: async (id: string) => {
        calls.push(`expensive:${id}`);
        return `expensive-result-${id}`;
      },
    };

    const limited = withRateLimit(client, {
      default: { limit: 10, windowMs: 1_000, options: { maxRetries: 0 } },
      perMethod: {
        expensive: { limit: 1, windowMs: 1_000, options: { maxRetries: 0, maxQueueSize: 0 } },
      },
    });

    await limited.cheap("a");
    expect(await limited.expensive("a")).toBe("expensive-result-a");

    await expect(limited.expensive("b")).rejects.toBeInstanceOf(SorokitRateLimitError);
    await expect(limited.expensive("b")).rejects.toMatchObject({
      methodName: "expensive",
      result: { status: "error", error: { code: "RATE_LIMITED" } },
    });
  });

  it("leaves a method with no applicable config completely unlimited", async () => {
    const original = vi.fn(async (value: number) => value * 2);
    const client = { double: original };

    const limited = withRateLimit(client, {
      perMethod: { other: { limit: 1, windowMs: 1_000 } },
    });

    const results = await Promise.all([1, 2, 3].map((value) => limited.double(value)));
    expect(results).toEqual([2, 4, 6]);
    expect(original).toHaveBeenCalledTimes(3);
  });

  it("applies the global default when no per-method entry exists", async () => {
    const client = {
      transfer: vi.fn(async () => "ok"),
    };

    const limited = withRateLimit(client, {
      default: { limit: 1, windowMs: 1_000, options: { maxRetries: 0, maxQueueSize: 0 } },
    });

    await limited.transfer();
    await expect(limited.transfer()).rejects.toMatchObject({
      methodName: "transfer",
      result: { status: "error", error: { code: "RATE_LIMITED" } },
    });
  });

  it("gives each configured method its own independent limiter", async () => {
    const client = {
      a: vi.fn(async () => "a-ok"),
      b: vi.fn(async () => "b-ok"),
    };

    const limited = withRateLimit(client, {
      default: { limit: 1, windowMs: 1_000, options: { maxRetries: 0, maxQueueSize: 0 } },
    });

    // Saturating method "a"'s single-slot limiter must not affect method
    // "b"'s independent limiter.
    await limited.a();
    await expect(limited.a()).rejects.toBeInstanceOf(SorokitRateLimitError);
    expect(await limited.b()).toBe("b-ok");
  });
});
