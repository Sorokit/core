/**
 * OpenTelemetry Integration for Observability (#600)
 *
 * Provides vendor-agnostic distributed tracing and metrics instrumentation
 * for Sorokit operations (HTTP requests, transaction building, signing, and submission).
 */

import { generateTraceId } from "./utils";

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";

export type SpanStatusCode = "ok" | "error" | "unset";

export interface SpanStatus {
  code: SpanStatusCode;
  description?: string | undefined;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown> | undefined;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number | undefined;
  durationMs?: number | undefined;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export type MetricType = "counter" | "histogram" | "gauge";

export interface OtelMetricRecord {
  name: string;
  type: MetricType;
  value: number;
  timestamp: number;
  attributes?: Record<string, unknown> | undefined;
  unit?: string | undefined;
  description?: string | undefined;
}

export interface OtelMetricSummary {
  name: string;
  type: MetricType;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50?: number | undefined;
  p95?: number | undefined;
  p99?: number | undefined;
  unit?: string | undefined;
}

export interface TelemetryExporter {
  exportSpans(spans: SpanData[]): Promise<void> | void;
  exportMetrics(metrics: OtelMetricRecord[]): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export type OpenTelemetryExporterType = "otlp" | "jaeger" | "console" | "memory" | "none";

export interface OpenTelemetryConfig {
  /**
   * Whether OpenTelemetry instrumentation is enabled.
   * @default true
   */
  enabled?: boolean | undefined;

  /**
   * Name of the instrumented service.
   * @default "sorokit-core"
   */
  serviceName?: string | undefined;

  /**
   * Version of the instrumented service.
   * @default "0.1.0"
   */
  serviceVersion?: string | undefined;

  /**
   * Exporter type or protocol.
   * @default "memory"
   */
  exporter?: OpenTelemetryExporterType | undefined;

  /**
   * Exporter endpoint (e.g. "http://localhost:4318/v1/traces").
   */
  endpoint?: string | undefined;

  /**
   * Additional HTTP headers sent to the exporter.
   */
  headers?: Record<string, string> | undefined;

  /**
   * Sampling rate between 0.0 and 1.0.
   * @default 1.0
   */
  sampleRate?: number | undefined;

  /**
   * Custom exporter instance.
   */
  customExporter?: TelemetryExporter | undefined;

  /**
   * Metrics collection/flush interval in milliseconds.
   * @default 10000
   */
  metricsIntervalMs?: number | undefined;
}

export interface StartSpanOptions {
  parent?: SorokitSpan | string | undefined;
  kind?: SpanKind | undefined;
  attributes?: Record<string, unknown> | undefined;
  startTime?: number | undefined;
}

// ─── Span Implementation ───────────────────────────────────────────────────────

export class SorokitSpan {
  private readonly _traceId: string;
  private readonly _spanId: string;
  private readonly _parentSpanId?: string | undefined;
  private readonly _name: string;
  private readonly _kind: SpanKind;
  private readonly _startTime: number;
  private _endTime?: number | undefined;
  private _status: SpanStatus = { code: "unset" };
  private readonly _attributes: Record<string, unknown> = {};
  private readonly _events: SpanEvent[] = [];
  private _ended = false;
  private readonly _onEnd?: ((spanData: SpanData) => void) | undefined;

  constructor(
    name: string,
    options: StartSpanOptions = {},
    onEnd?: ((spanData: SpanData) => void) | undefined,
  ) {
    this._name = name;
    this._kind = options.kind ?? "internal";
    this._startTime = options.startTime ?? Date.now();
    this._spanId = generateTraceId().slice(0, 16);
    this._onEnd = onEnd;

    if (options.parent instanceof SorokitSpan) {
      this._traceId = options.parent.traceId;
      this._parentSpanId = options.parent.spanId;
    } else if (typeof options.parent === "string" && options.parent.length > 0) {
      this._traceId = options.parent;
    } else {
      this._traceId = generateTraceId();
    }

    if (options.attributes) {
      Object.assign(this._attributes, options.attributes);
    }
  }

  public get traceId(): string {
    return this._traceId;
  }

  public get spanId(): string {
    return this._spanId;
  }

  public get parentSpanId(): string | undefined {
    return this._parentSpanId;
  }

  public get name(): string {
    return this._name;
  }

  public isRecording(): boolean {
    return !this._ended;
  }

  public setAttribute(key: string, value: unknown): this {
    if (!this._ended) {
      this._attributes[key] = value;
    }
    return this;
  }

  public setAttributes(attributes: Record<string, unknown>): this {
    if (!this._ended) {
      Object.assign(this._attributes, attributes);
    }
    return this;
  }

  public addEvent(name: string, attributes?: Record<string, unknown> | undefined): this {
    if (!this._ended) {
      this._events.push({
        name,
        timestamp: Date.now(),
        ...(attributes !== undefined ? { attributes } : {}),
      });
    }
    return this;
  }

  public setStatus(code: SpanStatusCode, description?: string | undefined): this {
    if (!this._ended) {
      this._status = {
        code,
        ...(description !== undefined ? { description } : {}),
      };
    }
    return this;
  }

  public recordError(error: unknown): this {
    if (!this._ended) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.setStatus("error", message);
      this.addEvent("exception", {
        "exception.message": message,
        "exception.type": error instanceof Error ? error.name : typeof error,
        "exception.stacktrace": stack,
      });
      this.setAttribute("error", true);
      this.setAttribute("error.message", message);
    }
    return this;
  }

  public end(endTime?: number | undefined): SpanData {
    if (this._ended) {
      return this.toData();
    }
    this._ended = true;
    this._endTime = endTime ?? Date.now();
    const data = this.toData();
    if (this._onEnd) {
      this._onEnd(data);
    }
    return data;
  }

  public toData(): SpanData {
    const end = this._endTime ?? Date.now();
    return {
      traceId: this._traceId,
      spanId: this._spanId,
      ...(this._parentSpanId !== undefined ? { parentSpanId: this._parentSpanId } : {}),
      name: this._name,
      kind: this._kind,
      startTime: this._startTime,
      ...(this._endTime !== undefined ? { endTime: this._endTime } : {}),
      durationMs: end - this._startTime,
      status: {
        code: this._status.code,
        ...(this._status.description !== undefined ? { description: this._status.description } : {}),
      },
      attributes: { ...this._attributes },
      events: [...this._events],
    };
  }
}

// ─── Exporters ─────────────────────────────────────────────────────────────────

export class InMemoryTelemetryExporter implements TelemetryExporter {
  public spans: SpanData[] = [];
  public metrics: OtelMetricRecord[] = [];

  public exportSpans(spans: SpanData[]): void {
    this.spans.push(...spans);
  }

  public exportMetrics(metrics: OtelMetricRecord[]): void {
    this.metrics.push(...metrics);
  }

  public clear(): void {
    this.spans = [];
    this.metrics = [];
  }
}

export class ConsoleTelemetryExporter implements TelemetryExporter {
  public exportSpans(spans: SpanData[]): void {
    for (const span of spans) {
      // eslint-disable-next-line no-console
      console.log(`[OpenTelemetry Span] ${span.name} (${span.durationMs}ms) [${span.status.code}]`, {
        traceId: span.traceId,
        spanId: span.spanId,
        attributes: span.attributes,
      });
    }
  }

  public exportMetrics(metrics: OtelMetricRecord[]): void {
    for (const m of metrics) {
      // eslint-disable-next-line no-console
      console.log(`[OpenTelemetry Metric] ${m.name} (${m.type}): ${m.value}`, m.attributes);
    }
  }
}

export class OtlpHttpTelemetryExporter implements TelemetryExporter {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(endpoint: string, headers: Record<string, string> = {}) {
    this.endpoint = endpoint;
    this.headers = headers;
  }

  public async exportSpans(spans: SpanData[]): Promise<void> {
    if (typeof fetch === "undefined" || !this.endpoint) return;
    try {
      const payload = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: spans.map((s) => ({
                  traceId: s.traceId,
                  spanId: s.spanId,
                  parentSpanId: s.parentSpanId,
                  name: s.name,
                  kind: s.kind,
                  startTimeUnixNano: s.startTime * 1_000_000,
                  endTimeUnixNano: (s.endTime ?? s.startTime) * 1_000_000,
                  attributes: Object.entries(s.attributes).map(([k, v]) => ({
                    key: k,
                    value: { stringValue: String(v) },
                  })),
                  status: {
                    code: s.status.code === "ok" ? 1 : s.status.code === "error" ? 2 : 0,
                    message: s.status.description,
                  },
                })),
              },
            ],
          },
        ],
      };

      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Fail-open for telemetry export
    }
  }

  public async exportMetrics(metrics: OtelMetricRecord[]): Promise<void> {
    if (typeof fetch === "undefined" || !this.endpoint) return;
    try {
      const payload = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: metrics.map((m) => ({
                  name: m.name,
                  data: {
                    dataPoints: [
                      {
                        timeUnixNano: m.timestamp * 1_000_000,
                        asDouble: m.value,
                        attributes: Object.entries(m.attributes ?? {}).map(([k, v]) => ({
                          key: k,
                          value: { stringValue: String(v) },
                        })),
                      },
                    ],
                  },
                })),
              },
            ],
          },
        ],
      };

      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Fail-open for telemetry export
    }
  }
}

export class JaegerHttpTelemetryExporter implements TelemetryExporter {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(endpoint: string, headers: Record<string, string> = {}) {
    this.endpoint = endpoint;
    this.headers = headers;
  }

  public async exportSpans(spans: SpanData[]): Promise<void> {
    if (typeof fetch === "undefined" || !this.endpoint) return;
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ spans }),
      });
    } catch {
      // Fail-open for telemetry export
    }
  }

  public async exportMetrics(metrics: OtelMetricRecord[]): Promise<void> {
    if (typeof fetch === "undefined" || !this.endpoint) return;
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ metrics }),
      });
    } catch {
      // Fail-open for telemetry export
    }
  }
}

// ─── OpenTelemetry Manager ─────────────────────────────────────────────────────

export class OpenTelemetryManager {
  private readonly config: OpenTelemetryConfig;
  private readonly exporter: TelemetryExporter;
  private readonly inMemoryExporter?: InMemoryTelemetryExporter | undefined;
  private readonly activeSpans: Set<SorokitSpan> = new Set();
  private readonly rawMetrics: OtelMetricRecord[] = [];
  private flushTimer?: ReturnType<typeof setInterval> | undefined;

  constructor(config: OpenTelemetryConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      serviceName: config.serviceName ?? "sorokit-core",
      serviceVersion: config.serviceVersion ?? "0.1.0",
      exporter: config.exporter ?? "memory",
      sampleRate: config.sampleRate ?? 1.0,
      metricsIntervalMs: config.metricsIntervalMs ?? 10_000,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.customExporter !== undefined ? { customExporter: config.customExporter } : {}),
    };

    if (this.config.customExporter) {
      this.exporter = this.config.customExporter;
    } else {
      switch (this.config.exporter) {
        case "console":
          this.exporter = new ConsoleTelemetryExporter();
          break;
        case "jaeger":
          this.exporter = new JaegerHttpTelemetryExporter(
            this.config.endpoint ?? "http://localhost:14268/api/traces",
            this.config.headers ?? {},
          );
          break;
        case "otlp":
          this.exporter = new OtlpHttpTelemetryExporter(
            this.config.endpoint ?? "http://localhost:4318/v1/traces",
            this.config.headers ?? {},
          );
          break;
        case "none":
          this.exporter = {
            exportSpans: () => {},
            exportMetrics: () => {},
          };
          break;
        case "memory":
        default:
          this.inMemoryExporter = new InMemoryTelemetryExporter();
          this.exporter = this.inMemoryExporter;
          break;
      }
    }
  }

  public isEnabled(): boolean {
    return Boolean(this.config.enabled);
  }

  public getConfig(): OpenTelemetryConfig {
    return { ...this.config };
  }

  /**
   * Starts a new trace span.
   */
  public startSpan(name: string, options: StartSpanOptions = {}): SorokitSpan {
    if (!this.isEnabled()) {
      return new SorokitSpan(name, options);
    }

    // Apply sampling
    if (this.config.sampleRate !== undefined && this.config.sampleRate < 1.0) {
      if (Math.random() > this.config.sampleRate) {
        const noopSpan = new SorokitSpan(name, options);
        return noopSpan;
      }
    }

    const initialAttributes = {
      "service.name": this.config.serviceName,
      "service.version": this.config.serviceVersion,
      ...(options.attributes ?? {}),
    };

    const span = new SorokitSpan(
      name,
      { ...options, attributes: initialAttributes },
      (spanData) => {
        this.activeSpans.delete(span);
        this.exporter.exportSpans([spanData]);
      },
    );

    this.activeSpans.add(span);
    return span;
  }

  /**
   * Executes an asynchronous function within an automatically ended span.
   */
  public async withSpan<T>(
    name: string,
    fn: (span: SorokitSpan) => Promise<T> | T,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    const start = Date.now();
    try {
      const result = await fn(span);
      if (span.isRecording()) {
        span.setStatus("ok");
        span.end();
      }
      this.recordLatency(`${name}.duration_ms`, Date.now() - start, {
        status: "ok",
        ...(options.attributes ?? {}),
      });
      this.recordCounter(`${name}.success_count`, 1, options.attributes);
      return result;
    } catch (error) {
      if (span.isRecording()) {
        span.recordError(error);
        span.end();
      }
      this.recordLatency(`${name}.duration_ms`, Date.now() - start, {
        status: "error",
        ...(options.attributes ?? {}),
      });
      this.recordCounter(`${name}.error_count`, 1, {
        error: error instanceof Error ? error.name : "UnknownError",
        ...(options.attributes ?? {}),
      });
      throw error;
    }
  }

  /**
   * Records a counter metric (e.g., total requests, error count).
   */
  public recordCounter(
    name: string,
    value = 1,
    attributes?: Record<string, unknown>,
    unit?: string,
  ): void {
    if (!this.isEnabled()) return;
    const record: OtelMetricRecord = {
      name,
      type: "counter",
      value,
      timestamp: Date.now(),
      attributes,
      unit,
    };
    this.rawMetrics.push(record);
    this.exporter.exportMetrics([record]);
  }

  /**
   * Records a duration or latency histogram value in milliseconds.
   */
  public recordHistogram(
    name: string,
    durationMs: number,
    attributes?: Record<string, unknown>,
    unit = "ms",
  ): void {
    if (!this.isEnabled()) return;
    const record: OtelMetricRecord = {
      name,
      type: "histogram",
      value: durationMs,
      timestamp: Date.now(),
      attributes,
      unit,
    };
    this.rawMetrics.push(record);
    this.exporter.exportMetrics([record]);
  }

  /**
   * Alias for recordHistogram.
   */
  public recordLatency(
    name: string,
    durationMs: number,
    attributes?: Record<string, unknown>,
  ): void {
    this.recordHistogram(name, durationMs, attributes, "ms");
  }

  /**
   * Records an instantaneous gauge metric value.
   */
  public recordGauge(
    name: string,
    value: number,
    attributes?: Record<string, unknown>,
    unit?: string,
  ): void {
    if (!this.isEnabled()) return;
    const record: OtelMetricRecord = {
      name,
      type: "gauge",
      value,
      timestamp: Date.now(),
      attributes,
      unit,
    };
    this.rawMetrics.push(record);
    this.exporter.exportMetrics([record]);
  }

  /**
   * Returns calculated metric summary statistics.
   */
  public getMetricsSummary(metricName?: string): Record<string, OtelMetricSummary> {
    const filtered = metricName
      ? this.rawMetrics.filter((m) => m.name === metricName)
      : this.rawMetrics;

    const groups = new Map<string, number[]>();
    const types = new Map<string, MetricType>();
    const units = new Map<string, string | undefined>();

    for (const m of filtered) {
      if (!groups.has(m.name)) {
        groups.set(m.name, []);
        types.set(m.name, m.type);
        units.set(m.name, m.unit);
      }
      groups.get(m.name)!.push(m.value);
    }

    const summaries: Record<string, OtelMetricSummary> = {};

    for (const [name, values] of groups.entries()) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const count = sorted.length;
      const min = sorted[0] as number;
      const max = sorted[sorted.length - 1] as number;
      const avg = sum / count;

      const p50 = (sorted[Math.floor(count * 0.5)] ?? min) as number;
      const p95 = (sorted[Math.floor(count * 0.95)] ?? max) as number;
      const p99 = (sorted[Math.floor(count * 0.99)] ?? max) as number;

      summaries[name] = {
        name,
        type: types.get(name) ?? "histogram",
        count,
        sum,
        min,
        max,
        avg,
        p50,
        p95,
        p99,
        ...(units.get(name) !== undefined ? { unit: units.get(name) } : {}),
      };
    }

    return summaries;
  }

  /**
   * Returns all exported spans when using the default in-memory exporter.
   */
  public getExportedSpans(): SpanData[] {
    return this.inMemoryExporter ? [...this.inMemoryExporter.spans] : [];
  }

  /**
   * Returns all exported metrics when using the default in-memory exporter.
   */
  public getExportedMetrics(): OtelMetricRecord[] {
    return this.inMemoryExporter ? [...this.inMemoryExporter.metrics] : [...this.rawMetrics];
  }

  /**
   * Clears accumulated in-memory spans and metrics.
   */
  public clear(): void {
    this.rawMetrics.length = 0;
    this.inMemoryExporter?.clear();
    this.activeSpans.clear();
  }

  /**
   * Shuts down exporters and timers.
   */
  public async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.exporter.shutdown) {
      await this.exporter.shutdown();
    }
    this.clear();
  }
}

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Creates an OpenTelemetryManager instance.
 */
export function createOpenTelemetryManager(
  config?: OpenTelemetryConfig,
): OpenTelemetryManager {
  return new OpenTelemetryManager(config);
}

// ─── Aliases for compatibility ───────────────────────────────────────────────
export {
  InMemoryTelemetryExporter as InMemorySpanExporter,
  ConsoleTelemetryExporter as ConsoleSpanExporter,
  OtlpHttpTelemetryExporter as OtlpSpanExporter,
  JaegerHttpTelemetryExporter as JaegerSpanExporter,
};
export type OtelSpan = SorokitSpan;
export type OtelSpanContext = SpanData;
export type OtelSpanExporter = TelemetryExporter;



