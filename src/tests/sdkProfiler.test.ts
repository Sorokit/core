import { describe, expect, it } from "vitest";
import { Profiler, createProfiler } from "../performance/profiler";

describe("SDK performance profiler (#1055)", () => {
  it("profiles synchronous operations and records call counts", () => {
    const profiler = createProfiler();
    const value = profiler.profileOperation(() => 42, "sync-operation");

    expect(value).toBe(42);
    expect(profiler.getMetrics()["sync-operation"]).toMatchObject({
      duration: expect.any(Number),
      durationMs: expect.any(Number),
      memory: expect.any(Number),
      memoryMB: expect.any(Number),
      callCount: 1,
    });
  });

  it("profiles asynchronous operations", async () => {
    const profiler = new Profiler();
    await expect(
      profiler.profileOperation(async () => "done", "async-operation"),
    ).resolves.toBe("done");
    expect(profiler.getMetrics()["async-operation"]?.callCount).toBe(1);
  });

  it("supports manual timing and aggregates repeated calls", () => {
    const profiler = new Profiler();
    profiler.startProfiling("manual");
    const duration = profiler.stopProfiling("manual");

    profiler.startProfiling("manual");
    profiler.stopProfiling("manual");

    expect(duration).toBeGreaterThanOrEqual(0);
    expect(profiler.getMetrics().manual?.callCount).toBe(2);
  });

  it("records elapsed time for thrown operations", () => {
    const profiler = new Profiler();
    expect(() =>
      profiler.profileOperation(() => {
        throw new Error("boom");
      }, "failure"),
    ).toThrow("boom");
    expect(profiler.getMetrics().failure?.callCount).toBe(1);
  });
});
