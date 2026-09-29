/**
 * Tests for OpenTelemetry tracing and metrics integration (#676).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
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
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

describe("telemetry", () => {
  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("validateTelemetryConfig", () => {
    it("accepts a minimal valid config", () => {
      expect(validateTelemetryConfig({ serviceName: "my-app" })).toBeNull();
    });

    it("accepts a full config", () => {
      expect(
        validateTelemetryConfig({
          serviceName: "my-app",
          exporter: "jaeger",
          samplingRate: 0.1,
          metricsIntervalMs: 5000,
        }),
      ).toBeNull();
    });

    it("rejects a missing serviceName", () => {
      // @ts-expect-error intentionally omitting required field
      expect(validateTelemetryConfig({})).toMatch(/serviceName/);
    });

    it("rejects an empty serviceName", () => {
      expect(validateTelemetryConfig({ serviceName: "   " })).toMatch(/serviceName/);
    });

    it("rejects an unknown exporter", () => {
      expect(
        // @ts-expect-error intentionally invalid exporter
        validateTelemetryConfig({ serviceName: "my-app", exporter: "splunk" }),
      ).toMatch(/Invalid exporter/);
    });

    it("rejects a samplingRate below 0", () => {
      expect(
        validateTelemetryConfig({ serviceName: "my-app", samplingRate: -0.1 }),
      ).toMatch(/samplingRate/);
    });

    it("rejects a samplingRate above 1", () => {
      expect(
        validateTelemetryConfig({ serviceName: "my-app", samplingRate: 1.5 }),
      ).toMatch(/samplingRate/);
    });

    it("rejects a non-positive metricsIntervalMs", () => {
      expect(
        validateTelemetryConfig({ serviceName: "my-app", metricsIntervalMs: 0 }),
      ).toMatch(/metricsIntervalMs/);
    });
  });

  describe("resolveOpenTelemetryConfig (exporter selection)", () => {
    it("defaults to the otlp exporter with its default endpoint", () => {
      const resolved = resolveOpenTelemetryConfig({ serviceName: "my-app" });
      expect(resolved.exporter).toBe("otlp");
      expect(resolved.endpoint).toBe("http://localhost:4318/v1/traces");
    });

    it("selects the jaeger exporter with its default endpoint", () => {
      const resolved = resolveOpenTelemetryConfig({ serviceName: "my-app", exporter: "jaeger" });
      expect(resolved.exporter).toBe("jaeger");
      expect(resolved.endpoint).toBe("http://localhost:14268/api/traces");
    });

    it("honors a custom endpoint override", () => {
      const resolved = resolveOpenTelemetryConfig({
        serviceName: "my-app",
        exporter: "otlp",
        endpoint: "https://collector.internal/v1/traces",
      });
      expect(resolved.endpoint).toBe("https://collector.internal/v1/traces");
    });

    it("wires a DatadogHttpTelemetryExporter as the customExporter for exporter: datadog", () => {
      const resolved = resolveOpenTelemetryConfig({
        serviceName: "my-app",
        exporter: "datadog",
        apiKey: "dd-key-123",
      });
      expect(resolved.exporter).toBe("otlp");
      expect(resolved.customExporter).toBeInstanceOf(DatadogHttpTelemetryExporter);
      expect(resolved.endpoint).toBe("https://otlp.datadoghq.com/v1/traces");
    });

    it("maps samplingRate to sampleRate", () => {
      const resolved = resolveOpenTelemetryConfig({ serviceName: "my-app", samplingRate: 0.25 });
      expect(resolved.sampleRate).toBe(0.25);
    });

    it("does not attach an endpoint for console/memory/none exporters", () => {
      for (const exporter of ["console", "memory", "none"] as const) {
        const resolved = resolveOpenTelemetryConfig({ serviceName: "my-app", exporter });
        expect(resolved.endpoint).toBeUndefined();
      }
    });
  });

  describe("initTelemetry", () => {
    it("returns ok(TelemetryData) for a valid config", () => {
      const result = initTelemetry({ serviceName: "my-app", exporter: "memory", samplingRate: 1 });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.serviceName).toBe("my-app");
        expect(result.data.exporter).toBe("memory");
        expect(result.data.samplingRate).toBe(1);
        expect(typeof result.data.instanceId).toBe("string");
        expect(result.data.instanceId.length).toBeGreaterThan(0);
        expect(typeof result.data.initializedAt).toBe("number");
      }
    });

    it("installs a manager reachable via getTelemetryManager", () => {
      expect(getTelemetryManager()).toBeNull();
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      expect(getTelemetryManager()).not.toBeNull();
      expect(isTelemetryInitialized()).toBe(true);
    });

    it("exposes the last init result via getTelemetryData", () => {
      expect(getTelemetryData()).toBeNull();
      initTelemetry({ serviceName: "svc-a", exporter: "memory" });
      expect(getTelemetryData()?.serviceName).toBe("svc-a");
    });

    it("returns an INVALID_CONFIG error for an invalid config and does not install a manager", () => {
      const result = initTelemetry({ serviceName: "" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
      expect(getTelemetryManager()).toBeNull();
    });

    it("rejects an invalid samplingRate", () => {
      const result = initTelemetry({ serviceName: "my-app", samplingRate: 2 });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      }
    });

    it("replaces a previously installed manager on re-init", () => {
      initTelemetry({ serviceName: "svc-a", exporter: "memory" });
      const first = getTelemetryManager();
      initTelemetry({ serviceName: "svc-b", exporter: "memory" });
      const second = getTelemetryManager();
      expect(second).not.toBe(first);
      expect(getTelemetryData()?.serviceName).toBe("svc-b");
    });
  });

  describe("traceSpan and named wrappers", () => {
    it("executes fn directly with no span when telemetry is uninitialized (zero overhead)", async () => {
      let receivedSpan: unknown = "not-called";
      const result = await traceSpan("wallet.connect", (span) => {
        receivedSpan = span;
        return "done";
      });
      expect(result).toBe("done");
      expect(receivedSpan).toBeUndefined();
    });

    it("creates and records a real span once initialized", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });

      const result = await traceSpan("wallet.connect", (span) => {
        span?.setAttribute("wallet.adapter", "freighter");
        return "connected";
      });

      expect(result).toBe("connected");
      const spans = getTelemetrySpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe("wallet.connect");
      expect(spans[0]?.attributes["wallet.adapter"]).toBe("freighter");
      expect(spans[0]?.status.code).toBe("ok");
    });

    it("marks the span as errored and rethrows when fn throws", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });

      await expect(
        traceSpan("transaction.submit", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const spans = getTelemetrySpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.status.code).toBe("error");
      expect(spans[0]?.status.description).toBe("boom");
    });

    it("traceWalletConnect names the span wallet.connect", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      await traceWalletConnect(async () => ok({ connected: true }));
      const spans = getTelemetrySpans();
      expect(spans[0]?.name).toBe("wallet.connect");
    });

    it("traceTransactionSubmit names the span transaction.submit", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      await traceTransactionSubmit(async () => ok({ hash: "abc" }));
      const spans = getTelemetrySpans();
      expect(spans[0]?.name).toBe("transaction.submit");
    });

    it("traceAccountFetch names the span account.fetch", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      await traceAccountFetch(async () => ok({ publicKey: "G..." }));
      const spans = getTelemetrySpans();
      expect(spans[0]?.name).toBe("account.fetch");
    });

    it("passes attributes through to the span", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      await traceWalletConnect(async () => ok(true), { "wallet.type": "freighter" });
      const spans = getTelemetrySpans();
      expect(spans[0]?.attributes["wallet.type"]).toBe("freighter");
    });

    it("simulates instrumenting a SorokitResult-returning operation end to end", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory", samplingRate: 1 });

      async function simulatedConnectWallet(): Promise<SorokitResult<{ publicKey: string }>> {
        return traceWalletConnect(async (span) => {
          span?.setAttribute("wallet.type", "freighter");
          return ok({ publicKey: "GABC" });
        });
      }

      async function simulatedGetAccount(): Promise<SorokitResult<{ publicKey: string }>> {
        return traceAccountFetch(async () => err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found"));
      }

      const connectResult = await simulatedConnectWallet();
      const accountResult = await simulatedGetAccount();

      expect(connectResult.status).toBe("ok");
      expect(accountResult.status).toBe("error");

      const spans = getTelemetrySpans();
      expect(spans.map((s) => s.name).sort()).toEqual(["account.fetch", "wallet.connect"]);
    });
  });

  describe("metrics: duration, error rate, cache hits", () => {
    beforeEach(() => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
    });

    it("is a no-op before initialization (no throw)", () => {
      resetTelemetry();
      expect(() => recordOperationDuration("account.fetch", 12)).not.toThrow();
      expect(() => recordOperationError("account.fetch")).not.toThrow();
      expect(() => recordCacheHit("balances", true)).not.toThrow();
      expect(getTelemetryMetricsSummary()).toEqual({});
    });

    it("records operation duration as a histogram", () => {
      recordOperationDuration("account.fetch", 42);
      recordOperationDuration("account.fetch", 58);
      const summary = getTelemetryMetricsSummary("account.fetch.duration_ms");
      expect(summary["account.fetch.duration_ms"]?.count).toBe(2);
      expect(summary["account.fetch.duration_ms"]?.type).toBe("histogram");
      expect(summary["account.fetch.duration_ms"]?.avg).toBe(50);
    });

    it("records error counts", () => {
      recordOperationError("transaction.submit");
      recordOperationError("transaction.submit");
      const summary = getTelemetryMetricsSummary("transaction.submit.error_count");
      expect(summary["transaction.submit.error_count"]?.count).toBe(2);
      expect(summary["transaction.submit.error_count"]?.sum).toBe(2);
    });

    it("records cache hits and misses separately", () => {
      recordCacheHit("balances", true);
      recordCacheHit("balances", true);
      recordCacheHit("balances", false);

      const summary = getTelemetryMetricsSummary();
      expect(summary["balances.cache_hit"]?.count).toBe(2);
      expect(summary["balances.cache_miss"]?.count).toBe(1);
    });

    it("automatically records duration and success/error counts via traceSpan", async () => {
      await traceSpan("account.fetch", async () => "ok-value");
      try {
        await traceSpan("account.fetch", async () => {
          throw new Error("nope");
        });
      } catch {
        // expected
      }

      const summary = getTelemetryMetricsSummary();
      expect(summary["account.fetch.duration_ms"]?.count).toBe(2);
      expect(summary["account.fetch.success_count"]?.count).toBe(1);
      expect(summary["account.fetch.error_count"]?.count).toBe(1);
    });
  });

  describe("exporters", () => {
    it("DatadogHttpTelemetryExporter posts spans with a DD-API-KEY header", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const exporter = new DatadogHttpTelemetryExporter(
        "https://otlp.datadoghq.com/v1/traces",
        "dd-key-abc",
      );

      await exporter.exportSpans([
        {
          traceId: "trace-1",
          spanId: "span-1",
          name: "wallet.connect",
          kind: "internal",
          startTime: Date.now(),
          endTime: Date.now() + 5,
          durationMs: 5,
          status: { code: "ok" },
          attributes: {},
          events: [],
        },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://otlp.datadoghq.com/v1/traces");
      const headers = requestInit.headers as Record<string, string>;
      expect(headers["DD-API-KEY"]).toBe("dd-key-abc");
    });

    it("omits the DD-API-KEY header when no apiKey is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const exporter = new DatadogHttpTelemetryExporter("http://localhost:4318/v1/traces");
      await exporter.exportMetrics([
        { name: "test.metric", type: "counter", value: 1, timestamp: Date.now() },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = requestInit.headers as Record<string, string>;
      expect(headers["DD-API-KEY"]).toBeUndefined();
    });

    it("initTelemetry with exporter: jaeger produces a manager that posts to the jaeger endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      initTelemetry({ serviceName: "my-app", exporter: "jaeger" });
      await traceSpan("wallet.connect", () => "ok");
      // Manager batches export synchronously per-span (see OpenTelemetryManager.startSpan),
      // so the HTTP call should have fired by the time withSpan resolves.
      expect(fetchMock).toHaveBeenCalled();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://localhost:14268/api/traces");
    });

    it("initTelemetry with exporter: datadog and an apiKey sends the DD-API-KEY header end-to-end", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      initTelemetry({ serviceName: "my-app", exporter: "datadog", apiKey: "secret-key" });
      await traceSpan("transaction.submit", () => "ok");

      expect(fetchMock).toHaveBeenCalled();
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://otlp.datadoghq.com/v1/traces");
      const headers = requestInit.headers as Record<string, string>;
      expect(headers["DD-API-KEY"]).toBe("secret-key");
    });
  });

  describe("shutdownTelemetry / resetTelemetry", () => {
    it("shutdownTelemetry clears the manager and is idempotent", async () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      expect(getTelemetryManager()).not.toBeNull();

      const result = await shutdownTelemetry();
      expect(result.status).toBe("ok");
      expect(getTelemetryManager()).toBeNull();
      expect(getTelemetryData()).toBeNull();

      // Calling again with nothing installed should still succeed.
      const second = await shutdownTelemetry();
      expect(second.status).toBe("ok");
    });

    it("resetTelemetry synchronously clears state", () => {
      initTelemetry({ serviceName: "my-app", exporter: "memory" });
      resetTelemetry();
      expect(getTelemetryManager()).toBeNull();
      expect(isTelemetryInitialized()).toBe(false);
    });
  });
});
