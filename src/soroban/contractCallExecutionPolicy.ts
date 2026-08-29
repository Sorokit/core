import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type TimeoutRecoveryStrategy = "fail" | "retry" | "cache" | "fallback";

export interface ContractCallExecutionPolicy {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  recoveryStrategy?: TimeoutRecoveryStrategy;
  fallbackRpcUrl?: string;
  cacheKey?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const pendingTimers = new Map<object, ReturnType<typeof setTimeout>>();
const abortListeners = new Map<object, () => void>();

export function withExecutionPolicy<T>(
  fn: () => Promise<SorokitResult<T>>,
  policy?: ContractCallExecutionPolicy,
): Promise<SorokitResult<T>> {
  if (!policy) return fn();

  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const key = {};

  if (policy.abortSignal) {
    if (policy.abortSignal.aborted) {
      return Promise.resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, "Operation aborted before start"));
    }
    const onAbort = () => controller.abort();
    policy.abortSignal.addEventListener("abort", onAbort, { once: true });
    abortListeners.set(key, onAbort);
  }

  return new Promise<SorokitResult<T>>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      handleTimeout(policy, resolve);
    }, timeoutMs);

    pendingTimers.set(key, timer);

    controller.signal.addEventListener("abort", () => {
      cleanup();
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, "Contract call cancelled"));
    });

    function cleanup() {
      const t = pendingTimers.get(key);
      if (t) clearTimeout(t);
      pendingTimers.delete(key);
      const listener = abortListeners.get(key);
      if (listener && policy?.abortSignal) {
        policy.abortSignal.removeEventListener("abort", listener);
      }
      abortListeners.delete(key);
    }

    fn()
      .then((result) => {
        cleanup();
        resolve(result);
      })
      .catch((cause) => {
        cleanup();
        resolve(err(SorokitErrorCode.CONTRACT_INVOKE_FAILED, `Contract call failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause));
      });
  });
}

function handleTimeout<T>(policy: ContractCallExecutionPolicy | undefined, resolve: (r: SorokitResult<T>) => void) {
  const strategy = policy?.recoveryStrategy ?? "fail";
  const timeoutMs = policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (strategy) {
    case "fail":
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, `Contract call timed out after ${timeoutMs}ms`));
      break;
    case "retry":
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, `Contract call timed out (retry not implemented in simple version)`));
      break;
    case "cache":
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, `Contract call timed out (cache not available)`));
      break;
    case "fallback":
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, `Contract call timed out (fallback RPC not configured)`));
      break;
    default:
      resolve(err(SorokitErrorCode.OPERATION_TIMEOUT, `Contract call timed out`));
  }
}

export function cleanupAllExecutionPolicies() {
  for (const [, timer] of pendingTimers) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  abortListeners.clear();
}
