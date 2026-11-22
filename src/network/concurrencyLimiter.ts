import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface ConcurrencyLimiter {
  <T>(task: () => Promise<SorokitResult<T>>): Promise<SorokitResult<T>>;
  run<T>(task: () => Promise<SorokitResult<T>>): Promise<SorokitResult<T>>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

/** Queue async SDK requests while allowing at most maxConcurrent to run. */
export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  let active = 0;
  const queue: Array<{
    task: () => Promise<SorokitResult<unknown>>;
    resolve: (result: SorokitResult<unknown>) => void;
  }> = [];

  const pump = (): void => {
    while (active < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      active += 1;
      void entry.task()
        .then(entry.resolve)
        .catch((cause) =>
          entry.resolve(
            err(
              SorokitErrorCode.INTERNAL,
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
          ),
        )
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const run = <T>(task: () => Promise<SorokitResult<T>>): Promise<SorokitResult<T>> =>
    new Promise((resolve) => {
      queue.push({
        task: task as () => Promise<SorokitResult<unknown>>,
        resolve: resolve as (result: SorokitResult<unknown>) => void,
      });
      pump();
    });

  const limiter = run as ConcurrencyLimiter;
  limiter.run = run;
  Object.defineProperties(limiter, {
    activeCount: { enumerable: true, get: () => active },
    pendingCount: { enumerable: true, get: () => queue.length },
  });
  return limiter;
}
