/**
 * Pluggable observability layer with hooks for key operations (RPC calls,
 * submissions, wallet events, cache operations). Provides a simple registry
 * for metrics collection and event emission.
 */

export interface ObservabilityContext {
  /** Optional trace/correlation id */
  traceId?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface RpcCallEvent {
  type: "rpc_call";
  method: string;
  url?: string;
  durationMs?: number;
  success?: boolean;
  errorCode?: string;
}

export interface TransactionSubmissionEvent {
  type: "transaction_submission";
  hash?: string;
  status?: "submitted" | "confirmed" | "failed" | "timeout" | "pending";
  durationMs?: number;
  success?: boolean;
  errorCode?: string;
}

export interface WalletStateChangeEvent {
  type: "wallet_state_change";
  event: "connected" | "disconnected" | "account_changed" | "network_changed";
  walletType?: string;
  publicKey?: string | null;
}

export interface CacheOperationEvent {
  type: "cache_operation";
  operation: "get" | "set" | "invalidate" | "clear" | "hit" | "miss" | "evict";
  key?: string;
  success?: boolean;
}

export type ObservabilityEvent =
  | RpcCallEvent
  | TransactionSubmissionEvent
  | WalletStateChangeEvent
  | CacheOperationEvent;

export interface ObservabilityHooks {
  /** Called for RPC/simulation/account calls */
  onRpcCall?: (event: RpcCallEvent, context?: ObservabilityContext) => void;
  /** Called for transaction submission/lifecycle */
  onTransactionSubmit?: (event: TransactionSubmissionEvent, context?: ObservabilityContext) => void;
  /** Alias for onTransactionSubmit */
  onSubmission?: (event: TransactionSubmissionEvent, context?: ObservabilityContext) => void;
  /** Called for wallet state changes */
  onWalletStateChange?: (event: WalletStateChangeEvent, context?: ObservabilityContext) => void;
  /** Alias for onWalletStateChange */
  onWalletEvent?: (event: WalletStateChangeEvent, context?: ObservabilityContext) => void;
  /** Called for cache operations */
  onCacheOperation?: (event: CacheOperationEvent, context?: ObservabilityContext) => void;
  /** Alias for cache hits */
  onCacheHit?: (event: CacheOperationEvent, context?: ObservabilityContext) => void;
  /** Alias for cache misses */
  onCacheMiss?: (event: CacheOperationEvent, context?: ObservabilityContext) => void;
}

export type ObservabilityHook = ObservabilityHooks;

export interface ObservabilityRegistry {
  register(hooks: ObservabilityHooks): () => void;
  getHooks(): ObservabilityHooks[];
  emit(event: ObservabilityEvent, context?: ObservabilityContext): void;
}

const hooks: ObservabilityHooks[] = [];

export const observability: ObservabilityRegistry = {
  register(hooksToRegister: ObservabilityHooks): () => void {
    hooks.push(hooksToRegister);
    return () => {
      const idx = hooks.indexOf(hooksToRegister);
      if (idx >= 0) {
        hooks.splice(idx, 1);
      }
    };
  },
  getHooks(): ObservabilityHooks[] {
    return [...hooks];
  },
  emit(event: ObservabilityEvent, context?: ObservabilityContext): void {
    for (const h of hooks) {
      try {
        if (event.type === "rpc_call") {
          h.onRpcCall?.(event, context);
        } else if (event.type === "transaction_submission") {
          h.onTransactionSubmit?.(event, context);
          h.onSubmission?.(event, context);
        } else if (event.type === "wallet_state_change") {
          h.onWalletStateChange?.(event, context);
          h.onWalletEvent?.(event, context);
        } else if (event.type === "cache_operation") {
          h.onCacheOperation?.(event, context);
          if (event.operation === "hit") {
            h.onCacheHit?.(event, context);
          } else if (event.operation === "miss") {
            h.onCacheMiss?.(event, context);
          }
        }
      } catch {
        // Ignore hook errors
      }
    }
  },
};

export function registerObservabilityHook(hooksToRegister: ObservabilityHooks): () => void {
  return observability.register(hooksToRegister);
}

export function addObservabilityHook(hooksToRegister: ObservabilityHooks): () => void {
  return observability.register(hooksToRegister);
}

export function createObservabilityHooks(hooksToRegister: ObservabilityHooks): ObservabilityHooks {
  return hooksToRegister;
}

export function emitObservabilityEvent(event: ObservabilityEvent, context?: ObservabilityContext): void {
  observability.emit(event, context);
}

export function clearObservabilityHooks(): void {
  hooks.length = 0;
}

export default observability;
