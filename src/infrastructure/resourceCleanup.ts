/**
 * Resource Cleanup on Errors — Prevent Memory Leaks (#1002)
 *
 * Centralized tracking and automatic cleanup of resources (timers, event listeners,
 * HTTP connections, streams, AbortControllers) on error, disconnect, or operation exit.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type CleanupTask = () => void | Promise<void>;

export interface ResourceItem {
  id: string;
  type: "timer" | "listener" | "stream" | "abort" | "custom";
  cleanup: CleanupTask;
  registeredAt: number;
}

export class ResourceManager {
  private resources: Map<string, ResourceItem> = new Map();
  private isCleanedUp = false;

  /**
   * Register a custom cleanup task. Returns an unregister function.
   */
  register(cleanup: CleanupTask, type: ResourceItem["type"] = "custom"): () => void {
    if (this.isCleanedUp) {
      // Execute immediately if manager has already been cleaned up
      try {
        const res = cleanup();
        if (res instanceof Promise) {
          res.catch(() => {});
        }
      } catch {}
      return () => {};
    }

    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.resources.set(id, {
      id,
      type,
      cleanup,
      registeredAt: Date.now(),
    });

    return () => {
      this.resources.delete(id);
    };
  }

  /**
   * Register a timer (setTimeout or setInterval) to be cleared on cleanup.
   */
  registerTimer(timer: NodeJS.Timeout | number): () => void {
    return this.register(() => {
      clearTimeout(timer as unknown as NodeJS.Timeout);
      clearInterval(timer as unknown as NodeJS.Timeout);
    }, "timer");
  }

  /**
   * Register an event listener on an EventEmitter or EventTarget.
   */
  registerListener(
    target: { removeListener?: (...args: any[]) => void; off?: (...args: any[]) => void; removeEventListener?: (...args: any[]) => void },
    event: string,
    handler: (...args: any[]) => void,
  ): () => void {
    return this.register(() => {
      if (typeof target.removeListener === "function") {
        target.removeListener(event, handler);
      } else if (typeof target.off === "function") {
        target.off(event, handler);
      } else if (typeof target.removeEventListener === "function") {
        target.removeEventListener(event, handler);
      }
    }, "listener");
  }

  /**
   * Register an AbortController to abort on cleanup.
   */
  registerAbortController(controller: AbortController): () => void {
    return this.register(() => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, "abort");
  }

  /**
   * Register a stream or stream-like object to be closed/destroyed.
   */
  registerStream(stream: { destroy?: () => void; close?: () => void; cancel?: () => void }): () => void {
    return this.register(() => {
      if (typeof stream.destroy === "function") {
        stream.destroy();
      } else if (typeof stream.close === "function") {
        stream.close();
      } else if (typeof stream.cancel === "function") {
        stream.cancel();
      }
    }, "stream");
  }

  /**
   * Clean up all registered resources in reverse order of registration.
   */
  async cleanupAll(): Promise<void> {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;

    const items = Array.from(this.resources.values()).reverse();
    this.resources.clear();

    for (const item of items) {
      try {
        const result = item.cleanup();
        if (result instanceof Promise) {
          await result.catch(() => {});
        }
      } catch {
        // Suppress errors during cleanup so all items run
      }
    }
  }

  /**
   * Count of currently active resources.
   */
  get activeCount(): number {
    return this.resources.size;
  }
}

/**
 * Helper to run an async operation with automatic cleanup on error or success.
 */
export async function withResourceCleanup<T>(
  fn: (resourceManager: ResourceManager) => Promise<T>,
): Promise<T> {
  const rm = new ResourceManager();
  try {
    return await fn(rm);
  } finally {
    await rm.cleanupAll();
  }
}

/**
 * Helper to execute an operation and automatically clean up resources ONLY if an error occurs.
 */
export async function cleanupOnError<T>(
  fn: (resourceManager: ResourceManager) => Promise<T>,
): Promise<SorokitResult<T>> {
  const rm = new ResourceManager();
  try {
    const data = await fn(rm);
    return ok(data);
  } catch (cause) {
    await rm.cleanupAll();
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Operation failed and resources were cleaned up",
      cause,
    );
  }
}

export function createResourceManager(): ResourceManager {
  return new ResourceManager();
}
