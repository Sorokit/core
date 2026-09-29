// ─── OpenTelemetry tracing & metrics (#676) ────────────────────────────────
export {
  initTelemetry,
  getTelemetryManager,
  getTelemetryData,
  isTelemetryInitialized,
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
