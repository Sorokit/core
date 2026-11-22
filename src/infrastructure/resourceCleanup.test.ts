import { describe, it, expect, vi } from "vitest";
import {
  ResourceManager,
  withResourceCleanup,
  cleanupOnError,
  createResourceManager,
} from "./resourceCleanup";

describe("Resource Cleanup on Errors (#1002)", () => {
  it("registers and executes cleanup tasks in LIFO order", async () => {
    const rm = new ResourceManager();
    const order: number[] = [];

    rm.register(() => {
      order.push(1);
    });
    rm.register(() => {
      order.push(2);
    });
    rm.register(() => {
      order.push(3);
    });

    expect(rm.activeCount).toBe(3);
    await rm.cleanupAll();
    expect(order).toEqual([3, 2, 1]);
    expect(rm.activeCount).toBe(0);
  });

  it("registers and cancels timers properly", async () => {
    const rm = createResourceManager();
    const timerSpy = vi.fn();
    const timer = setTimeout(timerSpy, 1000);

    rm.registerTimer(timer);
    expect(rm.activeCount).toBe(1);

    await rm.cleanupAll();
    expect(rm.activeCount).toBe(0);
    expect(timerSpy).not.toHaveBeenCalled();
  });

  it("removes event listeners upon cleanup", async () => {
    const rm = new ResourceManager();
    const offSpy = vi.fn();
    const dummyEmitter = {
      off: offSpy,
    };
    const handler = () => {};

    rm.registerListener(dummyEmitter, "testEvent", handler);
    await rm.cleanupAll();

    expect(offSpy).toHaveBeenCalledWith("testEvent", handler);
  });

  it("aborts AbortControllers upon cleanup", async () => {
    const rm = new ResourceManager();
    const controller = new AbortController();

    rm.registerAbortController(controller);
    expect(controller.signal.aborted).toBe(false);

    await rm.cleanupAll();
    expect(controller.signal.aborted).toBe(true);
  });

  it("withResourceCleanup automatically cleans up even when operation throws", async () => {
    let cleaned = false;
    await expect(
      withResourceCleanup(async (rm) => {
        rm.register(() => {
          cleaned = true;
        });
        throw new Error("Simulated failure");
      }),
    ).rejects.toThrow("Simulated failure");

    expect(cleaned).toBe(true);
  });

  it("cleanupOnError only cleans up when error occurs", async () => {
    let cleanedSuccess = false;
    const okRes = await cleanupOnError(async (rm) => {
      rm.register(() => {
        cleanedSuccess = true;
      });
      return "success_val";
    });
    expect(okRes.status).toBe("ok");
    expect(cleanedSuccess).toBe(false);

    let cleanedErr = false;
    const errRes = await cleanupOnError(async (rm) => {
      rm.register(() => {
        cleanedErr = true;
      });
      throw new Error("Boom");
    });
    expect(errRes.status).toBe("error");
    expect(cleanedErr).toBe(true);
  });
});
