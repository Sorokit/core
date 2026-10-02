import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpenTelemetryManager,
  createOpenTelemetryManager,
  SorokitSpan,
  InMemoryTelemetryExporter,
  ConsoleTelemetryExporter,
  OtlpHttpTelemetryExporter,
} from "../shared/openTelemetry";

describe("OpenTelemetry Integration (#600)", () => {
  let manager: OpenTelemetryManager;

  beforeEach(() => {
    manager = createOpenTelemetryManager({
      enabled: true,
      serviceName: "sorokit-test",
      serviceVersion: "1.0.0",
      exporter: "memory",
    });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe("Span Management", () => {
    it("should start and end a span with accurate duration and metadata", () => {
      const span = manager.startSpan("test.operation", {
        kind: "client",
        attributes: { "custom.attr": "value" },
      });

      expect(span.name).toBe("test.operation");
      expect(span.traceId).toBeDefined();
      expect(span.spanId).toBeDefined();
      expect(span.isRecording()).toBe(true);

      span.setAttribute("account.id", "GABC123");
      span.addEvent("request_sent", { bytes: 1024 });
      span.setStatus("ok");

      const data = span.end();

      expect(span.isRecording()).toBe(false);
      expect(data.status.code).toBe("ok");
      expect(data.attributes["service.name"]).toBe("sorokit-test");
      expect(data.attributes["custom.attr"]).toBe("value");
      expect(data.attributes["account.id"]).toBe("GABC123");
      expect(data.events.length).toBe(1);
      expect(data.events[0].name).toBe("request_sent");
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should export spans to the in-memory exporter on end", () => {
      const span1 = manager.startSpan("op.one");
      span1.end();

      const span2 = manager.startSpan("op.two");
      span2.end();

      const exported = manager.getExportedSpans();
      expect(exported.length).toBe(2);
      expect(exported[0].name).toBe("op.one");
      expect(exported[1].name).toBe("op.two");
    });

    it("should propagate parent traceId and spanId to child spans", () => {
      const parentSpan = manager.startSpan("parent.op");
      const childSpan = manager.startSpan("child.op", { parent: parentSpan });

      expect(childSpan.traceId).toBe(parentSpan.traceId);
      expect(childSpan.parentSpanId).toBe(parentSpan.spanId);

      parentSpan.end();
      childSpan.end();
    });

    it("should handle error recording and exception events", () => {
      const span = manager.startSpan("failing.op");
      const error = new Error("Network request timed out");

      span.recordError(error);
      const data = span.end();

      expect(data.status.code).toBe("error");
      expect(data.status.description).toBe("Network request timed out");
      expect(data.attributes["error"]).toBe(true);
      expect(data.attributes["error.message"]).toBe("Network request timed out");

      const exceptionEvent = data.events.find((e) => e.name === "exception");
      expect(exceptionEvent).toBeDefined();
      expect(exceptionEvent?.attributes?.["exception.message"]).toBe("Network request timed out");
    });
  });

  describe("withSpan Helper", () => {
    it("should automatically handle successful async operations", async () => {
      const result = await manager.withSpan(
        "async.http.get",
        async (span) => {
          span.setAttribute("http.status_code", 200);
          return { status: 200, body: "ok" };
        },
        { attributes: { "http.url": "https://horizon-testnet.stellar.org" } },
      );

      expect(result).toEqual({ status: 200, body: "ok" });

      const spans = manager.getExportedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe("async.http.get");
      expect(spans[0].status.code).toBe("ok");
      expect(spans[0].attributes["http.status_code"]).toBe(200);
      expect(spans[0].attributes["http.url"]).toBe("https://horizon-testnet.stellar.org");

      // Verify automatic metric recording
      const metrics = manager.getExportedMetrics();
      expect(metrics.some((m) => m.name === "async.http.get.success_count")).toBe(true);
      expect(metrics.some((m) => m.name === "async.http.get.duration_ms")).toBe(true);
    });

    it("should automatically record errors and rethrow on failure", async () => {
      await expect(
        manager.withSpan("failing.async.op", async () => {
          throw new Error("Transaction rejected: op_underfunded");
        }),
      ).rejects.toThrow("Transaction rejected: op_underfunded");

      const spans = manager.getExportedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe("error");
      expect(spans[0].attributes["error.message"]).toBe("Transaction rejected: op_underfunded");

      const metrics = manager.getExportedMetrics();
      expect(metrics.some((m) => m.name === "failing.async.op.error_count")).toBe(true);
    });
  });

  describe("Metrics Collection & Summaries", () => {
    it("should record counters, histograms, and gauges", () => {
      manager.recordCounter("http.requests.total", 1, { method: "POST" });
      manager.recordCounter("http.requests.total", 2, { method: "POST" });
      manager.recordLatency("http.request.latency", 45, { endpoint: "/transactions" });
      manager.recordLatency("http.request.latency", 150, { endpoint: "/transactions" });
      manager.recordLatency("http.request.latency", 80, { endpoint: "/transactions" });
      manager.recordGauge("connection.pool.active", 5);

      const metrics = manager.getExportedMetrics();
      expect(metrics.length).toBe(6);

      const summary = manager.getMetricsSummary("http.request.latency");
      expect(summary["http.request.latency"]).toBeDefined();
      expect(summary["http.request.latency"].count).toBe(3);
      expect(summary["http.request.latency"].min).toBe(45);
      expect(summary["http.request.latency"].max).toBe(150);
      expect(summary["http.request.latency"].sum).toBe(275);
      expect(summary["http.request.latency"].avg).toBeCloseTo(91.67, 1);
    });
  });

  describe("Exporters", () => {
    it("should support ConsoleTelemetryExporter without throwing", () => {
      const consoleExporter = new ConsoleTelemetryExporter();
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      consoleExporter.exportSpans([
        {
          traceId: "t1",
          spanId: "s1",
          name: "test.span",
          kind: "internal",
          startTime: Date.now(),
          durationMs: 12,
          status: { code: "ok" },
          attributes: {},
          events: [],
        },
      ]);

      consoleExporter.exportMetrics([
        {
          name: "m1",
          type: "counter",
          value: 1,
          timestamp: Date.now(),
        },
      ]);

      expect(consoleLogSpy).toHaveBeenCalled();
      consoleLogSpy.mockRestore();
    });

    it("should support OtlpHttpTelemetryExporter and handle network errors gracefully", async () => {
      const otlpExporter = new OtlpHttpTelemetryExporter("http://localhost:4318/v1/traces");
      await expect(
        otlpExporter.exportSpans([
          {
            traceId: "t1",
            spanId: "s1",
            name: "test.span",
            kind: "internal",
            startTime: Date.now(),
            durationMs: 12,
            status: { code: "ok" },
            attributes: {},
            events: [],
          },
        ]),
      ).resolves.not.toThrow();
    });
  });

  describe("Disabled Telemetry", () => {
    it("should be a no-op when enabled is false", () => {
      const disabledManager = createOpenTelemetryManager({ enabled: false });
      expect(disabledManager.isEnabled()).toBe(false);

      const span = disabledManager.startSpan("noop.span");
      span.setAttribute("key", "value");
      span.end();

      disabledManager.recordCounter("test.counter", 1);
      disabledManager.recordLatency("test.latency", 50);

      expect(disabledManager.getExportedSpans().length).toBe(0);
      expect(disabledManager.getExportedMetrics().length).toBe(0);
    });
  });
});
