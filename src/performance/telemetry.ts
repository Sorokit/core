/**
 * OpenTelemetry Integration for Tracing and Metrics (#676)
 *
 * Public entry point for enabling distributed tracing and metrics collection
 * across Sorokit SDK operations (wallet connection, transaction submission,
 * account lookups, and beyond).
 *
 * This module is a thin, ergonomic layer on top of the vendor-agnostic
 * OpenTelemetry-compatible engine in `../shared/openTelemetry` (spans,
 * histograms, counters, and real HTTP exporters for OTLP/Jaeger). It adds:
 *
 *  - `initTelemetry(config)` — a single call that validates configuration,
 *    selects/builds an exporter (Jaeger, Datadog, OTLP, or an in-process
 *    console/memory sink), and installs a process-wide telemetry manager.
 *  - Named instrumentation helpers for the SDK's most latency-sensitive
 *    operations (`wallet.connect`, `transaction.submit`, `account.fetch`)
 *    plus a generic `traceSpan` any module can use.
 *  - Metric recording helpers for operation duration, error rates, and
 *    cache hit/miss ratios.
 *
 * ## Zero-overhead when unconfigured
 *
 * Every helper here is safe to call unconditionally, even before
 * `initTelemetry` has run. Until a config is installed, `traceSpan` and the
 * named wrappers call straight through to the wrapped function with no span
 * allocation, and the metric recorders are no-ops. This lets other SDK
 * modules (see `wallet/connect.ts`, `transaction/submitTransaction.ts`,
 * `account/getAccount.ts`) instrument themselves unconditionally without
 * imposing cost — or a hard dependency — on consumers who never call
 * `initTelemetry`.
 *
 * ## Usage
 *
 * ```typescript
 * import { initTelemetry, traceWalletConnect } from "sorokit-core";
 *
 * initTelemetry({
 *   serviceName: "my-app",
 *   exporter: "jaeger",
 *   samplingRate: 0.1,
 * });
 *
 * // Automatic tracing of SDK operations:
 * const result = await traceWalletConnect((span) => {
 *   span?.setAttribute("wallet.adapter", "freighter");
 *   return connectWallet(adapter);
 * });
 * ```
 */

import {
  createOpenTelemetryManager,
  OpenTelemetryManager,
  OtlpHttpTelemetryExporter,
  SorokitSpan,
} from "../shared/openTelemetry";
import type {
  OpenTelemetryConfig,
  OpenTelemetryExporterType,
  OtelMetricRecord,
  OtelMetricSummary,
  SpanData,
  StartSpanOptions,
  TelemetryExporter,
} from "../shared/openTelemetry";
import { generateTraceId } from "../shared/utils";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Supported exporter backends. `"console"`, `"memory"`, and `"none"` are
 * local/testing sinks; `"jaeger"`, `"datadog"`, and `"otlp"` export over HTTP
 * to a real (or locally running) collector.
 */
export type TelemetryExporterType =
  | "jaeger"
  | "datadog"
  | "otlp"
  | "console"
  | "memory"
  | "none";

export interface TelemetryConfig {
  /** Logical name of the instrumented service, e.g. `"my-app"`. */
  serviceName: string;

  /** Version of the instrumented service. @default "0.1.0" */
  serviceVersion?: string | undefined;

  /**
   * Which exporter backend to send spans/metrics to.
   * @default "otlp"
   */
  exporter?: TelemetryExporterType | undefined;

  /**
   * Fraction of spans to sample, between 0 and 1 inclusive.
   * @default 1.0
   */
  samplingRate?: number | undefined;

  /**
   * Exporter endpoint. Ignored for `"console"`, `"memory"`, and `"none"`.
   * Defaults are supplied per-exporter (see {@link DEFAULT_EXPORTER_ENDPOINTS}).
   */
  endpoint?: string | undefined;

  /** Additional HTTP headers sent with every export request. */
  headers?: Record<string, string> | undefined;

  /**
   * Datadog API key. Only used when `exporter: "datadog"`; sent as the
   * `DD-API-KEY` header. Required for Datadog's public OTLP intake, but may
   * be omitted when exporting to a local Datadog Agent configured to accept
   * unauthenticated OTLP.
   */
  apiKey?: string | undefined;

  /** Metrics flush interval in milliseconds. @default 10000 */
  metricsIntervalMs?: number | undefined;
}

export interface TelemetryData {
  /** Echoes the configured service name. */
  serviceName: string;
  /** Resolved service version (defaulted if not supplied). */
  serviceVersion: string;
  /** Resolved exporter backend. */
  exporter: TelemetryExporterType;
  /** Resolved sampling rate. */
  samplingRate: number;
  /** Resolved export endpoint, if applicable to the chosen exporter. */
  endpoint?: string | undefined;
  /** Unique identifier for this telemetry session, useful for correlating logs. */
  instanceId: string;
  /** Epoch ms at which telemetry was initialized. */
  initializedAt: number;
}

/** A subset of {@link SorokitSpan}'s API that instrumentation callbacks receive. */
export type TelemetrySpan = SorokitSpan;

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_EXPORTER_ENDPOINTS: Record<TelemetryExporterType, string | undefined> = {
  jaeger: "http://localhost:14268/api/traces",
  otlp: "http://localhost:4318/v1/traces",
  datadog: "https://otlp.datadoghq.com/v1/traces",
  console: undefined,
  memory: undefined,
  none: undefined,
};

const VALID_EXPORTERS: readonly TelemetryExporterType[] = [
  "jaeger",
  "datadog",
  "otlp",
  "console",
  "memory",
  "none",
];

// ─── Datadog Exporter ───────────────────────────────────────────────────────

/**
 * Exports spans and metrics to Datadog over its OTLP-compatible intake
 * (`https://otlp.datadoghq.com` by default, or a local Datadog Agent with
 * OTLP ingestion enabled). Requires no additional npm dependency — it
 * reuses the same lightweight `fetch`-based OTLP payload shape as
 * {@link OtlpHttpTelemetryExporter}, adding the `DD-API-KEY` header Datadog
 * expects for its public intake.
 *
 * If your deployment instead routes through a Datadog Agent with an
 * OTLP receiver, omit `apiKey` and point `endpoint` at the agent
 * (typically `http://localhost:4318/v1/traces`).
 */
export class DatadogHttpTelemetryExporter implements TelemetryExporter {
  private readonly delegate: OtlpHttpTelemetryExporter;

  constructor(endpoint: string, apiKey?: string, headers: Record<string, string> = {}) {
    const ddHeaders: Record<string, string> = { ...headers };
    if (apiKey) {
      ddHeaders["DD-API-KEY"] = apiKey;
    }
    this.delegate = new OtlpHttpTelemetryExporter(endpoint, ddHeaders);
  }

  public exportSpans(spans: SpanData[]): Promise<void> | void {
    return this.delegate.exportSpans(spans);
  }

  public exportMetrics(metrics: OtelMetricRecord[]): Promise<void> | void {
    return this.delegate.exportMetrics(metrics);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validates a {@link TelemetryConfig} without side effects. Returns `null`
 * when the config is valid, or a descriptive error otherwise.
 */
export function validateTelemetryConfig(config: TelemetryConfig): string | null {
  if (!config || typeof config !== "object") {
    return "Telemetry config must be an object.";
  }
  if (typeof config.serviceName !== "string" || config.serviceName.trim().length === 0) {
    return "Telemetry config requires a non-empty `serviceName`.";
  }
  if (config.exporter !== undefined && !VALID_EXPORTERS.includes(config.exporter)) {
    return `Invalid exporter "${String(config.exporter)}". Expected one of: ${VALID_EXPORTERS.join(", ")}.`;
  }
  if (config.samplingRate !== undefined) {
    if (
      typeof config.samplingRate !== "number" ||
      Number.isNaN(config.samplingRate) ||
      config.samplingRate < 0 ||
      config.samplingRate > 1
    ) {
      return "`samplingRate` must be a number between 0 and 1 (inclusive).";
    }
  }
  if (
    config.metricsIntervalMs !== undefined &&
    (typeof config.metricsIntervalMs !== "number" || config.metricsIntervalMs <= 0)
  ) {
    return "`metricsIntervalMs` must be a positive number.";
  }
  return null;
}

/**
 * Resolves a {@link TelemetryConfig} into the {@link OpenTelemetryConfig}
 * consumed by `OpenTelemetryManager`, selecting/constructing the correct
 * exporter instance. Exported separately from `initTelemetry` so exporter
 * selection logic can be unit-tested without side effects (no manager is
 * constructed or installed).
 */
export function resolveOpenTelemetryConfig(config: TelemetryConfig): OpenTelemetryConfig {
  const exporterType: TelemetryExporterType = config.exporter ?? "otlp";
  const endpoint = config.endpoint ?? DEFAULT_EXPORTER_ENDPOINTS[exporterType];

  const base: OpenTelemetryConfig = {
    enabled: true,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion ?? "0.1.0",
    sampleRate: config.samplingRate ?? 1.0,
    metricsIntervalMs: config.metricsIntervalMs ?? 10_000,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  };

  if (exporterType === "datadog") {
    return {
      ...base,
      exporter: "otlp",
      ...(endpoint !== undefined ? { endpoint } : {}),
      customExporter: new DatadogHttpTelemetryExporter(
        endpoint ?? (DEFAULT_EXPORTER_ENDPOINTS.datadog as string),
        config.apiKey,
        config.headers ?? {},
      ),
    };
  }

  return {
    ...base,
    exporter: exporterType as OpenTelemetryExporterType,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

// ─── Manager Singleton ──────────────────────────────────────────────────────

let activeManager: OpenTelemetryManager | null = null;
let activeData: TelemetryData | null = null;

/**
 * Initializes OpenTelemetry-compatible tracing and metrics for the SDK.
 *
 * Validates `config`, resolves the requested exporter (Jaeger, Datadog,
 * OTLP, or a local console/memory sink), and installs a process-wide
 * telemetry manager used by {@link traceSpan} and the named `trace*`
 * helpers. Safe to call more than once — each call replaces the previously
 * installed manager (the old one is left to be garbage collected; call
 * {@link shutdownTelemetry} first if you need its exporters flushed).
 *
 * @example
 * const result = initTelemetry({ serviceName: "my-app", exporter: "jaeger", samplingRate: 0.1 });
 * if (result.status === "ok") {
 *   console.log("Telemetry ready:", result.data.instanceId);
 * }
 */
export function initTelemetry(config: TelemetryConfig): SorokitResult<TelemetryData> {
  const validationError = validateTelemetryConfig(config);
  if (validationError) {
    return err(SorokitErrorCode.INVALID_CONFIG, validationError, config);
  }

  try {
    const otelConfig = resolveOpenTelemetryConfig(config);
    const manager = createOpenTelemetryManager(otelConfig);
    const resolvedExporter = config.exporter ?? "otlp";

    const data: TelemetryData = {
      serviceName: otelConfig.serviceName as string,
      serviceVersion: otelConfig.serviceVersion as string,
      exporter: resolvedExporter,
      samplingRate: otelConfig.sampleRate as number,
      ...(otelConfig.endpoint !== undefined ? { endpoint: otelConfig.endpoint } : {}),
      instanceId: generateTraceId(),
      initializedAt: Date.now(),
    };

    activeManager = manager;
    activeData = data;

    return ok(data);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      `Failed to initialize telemetry: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/** Returns the currently installed telemetry manager, or `null` if uninitialized. */
export function getTelemetryManager(): OpenTelemetryManager | null {
  return activeManager;
}

/** Returns the `TelemetryData` from the most recent successful `initTelemetry` call. */
export function getTelemetryData(): TelemetryData | null {
  return activeData;
}

/** Whether telemetry has been initialized and is currently active. */
export function isTelemetryInitialized(): boolean {
  return activeManager !== null && activeManager.isEnabled();
}

/**
 * Shuts down the active telemetry manager (flushing/stopping its exporter)
 * and clears the installed singleton. Safe to call when telemetry was never
 * initialized.
 */
export async function shutdownTelemetry(): Promise<SorokitResult<void>> {
  if (!activeManager) {
    return ok(undefined);
  }
  try {
    await activeManager.shutdown();
    activeManager = null;
    activeData = null;
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      `Failed to shut down telemetry: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Resets telemetry state synchronously without flushing the exporter.
 * Intended for tests; production code should prefer {@link shutdownTelemetry}.
 */
export function resetTelemetry(): void {
  activeManager = null;
  activeData = null;
}

// ─── Tracing Helpers ────────────────────────────────────────────────────────

/**
 * Runs `fn` inside a trace span named `name`. When telemetry has not been
 * initialized, `fn` is invoked directly with no span (zero overhead) — this
 * makes `traceSpan` safe for any SDK module to call unconditionally.
 *
 * Duration, success count, and error count metrics are recorded
 * automatically (see `OpenTelemetryManager.withSpan`).
 */
export async function traceSpan<T>(
  name: string,
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  options?: StartSpanOptions,
): Promise<T> {
  if (!activeManager) {
    return fn();
  }
  return activeManager.withSpan(name, (span) => fn(span), options ?? {});
}

/** Traces a wallet connection attempt under the `wallet.connect` span name. */
export function traceWalletConnect<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("wallet.connect", fn, attributes ? { attributes } : {});
}

/** Traces a transaction submission under the `transaction.submit` span name. */
export function traceTransactionSubmit<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("transaction.submit", fn, attributes ? { attributes } : {});
}

/** Traces an account lookup under the `account.fetch` span name. */
export function traceAccountFetch<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("account.fetch", fn, attributes ? { attributes } : {});
}

// ─── Metrics Helpers ────────────────────────────────────────────────────────

/**
 * Records an operation's duration as a histogram metric
 * (`<operation>.duration_ms`). No-op when telemetry is uninitialized.
 */
export function recordOperationDuration(
  operation: string,
  durationMs: number,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordHistogram(`${operation}.duration_ms`, durationMs, attributes, "ms");
}

/**
 * Increments an operation's error counter (`<operation>.error_count`).
 * No-op when telemetry is uninitialized.
 */
export function recordOperationError(
  operation: string,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordCounter(`${operation}.error_count`, 1, attributes);
}

/**
 * Records a cache hit or miss for `cacheName` as a counter metric
 * (`<cacheName>.cache_hit` / `<cacheName>.cache_miss`). No-op when
 * telemetry is uninitialized.
 */
export function recordCacheHit(
  cacheName: string,
  hit: boolean,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordCounter(
    hit ? `${cacheName}.cache_hit` : `${cacheName}.cache_miss`,
    1,
    attributes,
  );
}

/** Returns aggregated metric summaries (duration percentiles, counts) from the active manager. */
export function getTelemetryMetricsSummary(metricName?: string): Record<string, OtelMetricSummary> {
  return activeManager ? activeManager.getMetricsSummary(metricName) : {};
}

/** Returns exported spans held by the in-memory exporter, if that's the active exporter. */
export function getTelemetrySpans(): SpanData[] {
  return activeManager ? activeManager.getExportedSpans() : [];
}
