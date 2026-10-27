/**
 * Example integration with Prometheus-style metrics
 */
import {
  registerObservabilityHook,
  type ObservabilityHooks,
} from "../src/shared/observability";

const counters: Record<string, number> = {};

export function createPrometheusObservability(): { hooks: ObservabilityHooks; getMetrics(): string } {
  const hooks: ObservabilityHooks = {
    onRpcCall: (event) => {
      const key = `rpc_calls_total{method="${event.method}",success="${event.success}"} `;
      counters[key] = (counters[key] || 0) + 1;
    },
    onTransactionSubmit: (event) => {
      const key = `tx_submissions_total{status="${event.status}",success="${event.success}"} `;
      counters[key] = (counters[key] || 0) + 1;
    },
    onWalletStateChange: (event) => {
      const key = `wallet_events_total{event="${event.event}",wallet_type="${event.walletType}"} `;
      counters[key] = (counters[key] || 0) + 1;
    },
    onCacheOperation: (event) => {
      if (event.operation === "hit" || event.operation === "miss") {
        const key = `cache_${event.operation}s_total `;
        counters[key] = (counters[key] || 0) + 1;
      }
    },
  };

  registerObservabilityHook(hooks);

  return {
    hooks,
    getMetrics: () => Object.entries(counters).map(([k, v]) => `${k}${v}`).join("\n") + "\n",
  };
}

export default createPrometheusObservability;
