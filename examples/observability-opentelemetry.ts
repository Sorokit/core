/**
 * Example integration with OpenTelemetry
 */
import {
  registerObservabilityHook,
  type ObservabilityHooks,
} from "../src/shared/observability";

export interface OpenTelemetryLike {
  counter: (name: string) => { add: (val: number, attrs?: Record<string, unknown>) => void };
  histogram: (name: string) => { record: (val: number, attrs?: Record<string, unknown>) => void };
}

export function createOpenTelemetryObservability(otel: OpenTelemetryLike): ObservabilityHooks {
  const rpcCounter = otel.counter("sorokit.rpc.calls");
  const txCounter = otel.counter("sorokit.tx.submissions");
  const walletCounter = otel.counter("sorokit.wallet.events");
  const cacheHits = otel.counter("sorokit.cache.hits");
  const cacheMisses = otel.counter("sorokit.cache.misses");
  const rpcDuration = otel.histogram("sorokit.rpc.duration");

  const hooks: ObservabilityHooks = {
    onRpcCall: (event) => {
      rpcCounter.add(1, { method: event.method, success: event.success });
      if (typeof event.durationMs === "number") {
        rpcDuration.record(event.durationMs, { method: event.method });
      }
    },
    onTransactionSubmit: (event) => {
      txCounter.add(1, { status: event.status, success: event.success });
    },
    onWalletStateChange: (event) => {
      walletCounter.add(1, { event: event.event, wallet_type: event.walletType });
    },
    onCacheOperation: (event) => {
      if (event.operation === "hit") cacheHits.add(1, {});
      if (event.operation === "miss") cacheMisses.add(1, {});
    },
  };

  registerObservabilityHook(hooks);
  return hooks;
}

export default createOpenTelemetryObservability;
