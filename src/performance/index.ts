// ─── OpenTelemetry tracing & metrics (#676) ────────────────────────────────
export {
  initTelemetry,
  getTelemetryManager,
  getTelemetryData,
  isTelemetryInitialized,
  validateTelemetryInitialized,
  requireTelemetryManager,
  requireTelemetryData,
  shutdownTelemetry,
  resetTelemetry,
  traceSpan,
  traceWalletConnect,
  traceTransactionSubmit,
  traceAccountFetch,
  recordOperationDuration,
  recordOperationError,
  recordCacheHit,
  getTelemetryMetricsSummary,
  getTelemetrySpans,
  validateTelemetryConfig,
  resolveOpenTelemetryConfig,
  DatadogHttpTelemetryExporter,
} from "./telemetry";
export type {
  TelemetryConfig,
  TelemetryData,
  TelemetryExporterType,
  TelemetrySpan,
} from "./telemetry";
export { createCache, CacheBuilder } from "./cacheStrategy";
export type { CacheOptions, CachedData, CacheStats, CacheFetcher } from "./cacheStrategy";
