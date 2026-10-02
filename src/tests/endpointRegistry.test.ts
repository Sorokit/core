import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EndpointRegistry,
  createEndpointRegistry,
} from "../network/endpointRegistry";
import type { EndpointType } from "../network/endpointRegistry";

describe("Custom Endpoint Registry and Load Balancing (#672)", () => {
  let registry: EndpointRegistry;

  beforeEach(() => {
    registry = createEndpointRegistry();
  });

  describe("registerEndpoint", () => {
    it("registers a valid horizon endpoint", () => {
      const result = registry.registerEndpoint(
        "horizon",
        "https://horizon.example.com",
        10,
        0,
      );
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://horizon.example.com");
        expect(result.data.type).toBe("horizon");
        expect(result.data.weight).toBe(10);
        expect(result.data.priority).toBe(0);
        expect(result.data.healthy).toBe(true);
        expect(result.data.failureCount).toBe(0);
      }
    });

    it("registers a valid RPC endpoint with defaults", () => {
      const result = registry.registerEndpoint("rpc", "https://rpc.example.com");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.weight).toBe(1);
        expect(result.data.priority).toBe(0);
      }
    });

    it("rejects invalid URL", () => {
      const result = registry.registerEndpoint("horizon", "not-a-url");
      expect(result.status).toBe("error");
    });

    it("rejects empty URL", () => {
      const result = registry.registerEndpoint("horizon", "");
      expect(result.status).toBe("error");
    });

    it("rejects non-http(s) protocol", () => {
      const result = registry.registerEndpoint("horizon", "ftp://example.com");
      expect(result.status).toBe("error");
    });

    it("rejects negative weight", () => {
      const result = registry.registerEndpoint(
        "horizon",
        "https://example.com",
        -1,
      );
      expect(result.status).toBe("error");
    });

    it("updates existing endpoint weight and priority", () => {
      registry.registerEndpoint("horizon", "https://example.com", 5, 1);
      const result = registry.registerEndpoint(
        "horizon",
        "https://example.com",
        20,
        0,
      );
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.weight).toBe(20);
        expect(result.data.priority).toBe(0);
      }
      expect(registry.getEndpoints("horizon")).toHaveLength(1);
    });
  });

  describe("removeEndpoint", () => {
    it("removes a registered endpoint", () => {
      registry.registerEndpoint("horizon", "https://example.com");
      expect(registry.getEndpoints("horizon")).toHaveLength(1);
      const result = registry.removeEndpoint("horizon", "https://example.com");
      expect(result.status).toBe("ok");
      expect(registry.getEndpoints("horizon")).toHaveLength(0);
    });

    it("returns error for non-existent endpoint", () => {
      const result = registry.removeEndpoint("horizon", "https://nope.com");
      expect(result.status).toBe("error");
    });
  });

  describe("getEndpoints", () => {
    it("lists endpoints filtered by type", () => {
      registry.registerEndpoint("horizon", "https://h1.example.com");
      registry.registerEndpoint("horizon", "https://h2.example.com");
      registry.registerEndpoint("rpc", "https://r1.example.com");

      expect(registry.getEndpoints("horizon")).toHaveLength(2);
      expect(registry.getEndpoints("rpc")).toHaveLength(1);
      expect(registry.getEndpoints()).toHaveLength(3);
    });
  });

  describe("getOptimalEndpoint", () => {
    it("selects higher-weight endpoint when latencies are equal", () => {
      registry.registerEndpoint("horizon", "https://low.com", 1);
      registry.registerEndpoint("horizon", "https://high.com", 10);

      const result = registry.getOptimalEndpoint("horizon");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://high.com");
      }
    });

    it("prefers lower latency endpoint", () => {
      registry.registerEndpoint("horizon", "https://slow.com", 5);
      registry.registerEndpoint("horizon", "https://fast.com", 5);
      registry.recordLatency("horizon", "https://slow.com", 2000);
      registry.recordLatency("horizon", "https://fast.com", 50);

      const result = registry.getOptimalEndpoint("horizon");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://fast.com");
      }
    });

    it("prefers higher priority (lower number)", () => {
      registry.registerEndpoint("horizon", "https://secondary.com", 10, 5);
      registry.registerEndpoint("horizon", "https://primary.com", 1, 0);

      const result = registry.getOptimalEndpoint("horizon");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://primary.com");
      }
    });

    it("skips unhealthy endpoints", () => {
      registry.registerEndpoint("rpc", "https://dead.com", 100);
      registry.registerEndpoint("rpc", "https://alive.com", 1);

      // Mark dead.com as unhealthy via repeated failures
      for (let i = 0; i < 3; i++) {
        registry.recordFailure("rpc", "https://dead.com");
      }

      const result = registry.getOptimalEndpoint("rpc");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://alive.com");
      }
    });

    it("falls back to unhealthy if all are unhealthy", () => {
      registry.registerEndpoint("rpc", "https://only.com", 1);
      for (let i = 0; i < 3; i++) {
        registry.recordFailure("rpc", "https://only.com");
      }

      const result = registry.getOptimalEndpoint("rpc");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.url).toBe("https://only.com");
      }
    });

    it("returns error when no endpoints registered", () => {
      const result = registry.getOptimalEndpoint("horizon");
      expect(result.status).toBe("error");
    });
  });

  describe("rotateEndpoints", () => {
    it("cycles through endpoints in round-robin order", () => {
      registry.registerEndpoint("horizon", "https://a.com");
      registry.registerEndpoint("horizon", "https://b.com");
      registry.registerEndpoint("horizon", "https://c.com");

      const urls: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = registry.rotateEndpoints("horizon");
        if (r.status === "ok") urls.push(r.data.url);
      }

      // Should cycle: a, b, c, a, b, c
      expect(urls[0]).toBe(urls[3]);
      expect(urls[1]).toBe(urls[4]);
      expect(urls[2]).toBe(urls[5]);
      expect(new Set(urls).size).toBe(3);
    });

    it("returns error when no endpoints registered", () => {
      const result = registry.rotateEndpoints("rpc");
      expect(result.status).toBe("error");
    });
  });

  describe("failure tracking and recovery", () => {
    it("marks endpoint unhealthy after maxFailures", () => {
      registry = createEndpointRegistry({ maxFailures: 2 });
      registry.registerEndpoint("horizon", "https://example.com");

      registry.recordFailure("horizon", "https://example.com");
      let eps = registry.getEndpoints("horizon");
      expect(eps[0].healthy).toBe(true);
      expect(eps[0].failureCount).toBe(1);

      registry.recordFailure("horizon", "https://example.com");
      eps = registry.getEndpoints("horizon");
      expect(eps[0].healthy).toBe(false);
      expect(eps[0].failureCount).toBe(2);
    });

    it("resets failure count on recordSuccess", () => {
      registry.registerEndpoint("horizon", "https://example.com");
      registry.recordFailure("horizon", "https://example.com");
      registry.recordFailure("horizon", "https://example.com");
      registry.recordSuccess("horizon", "https://example.com");

      const eps = registry.getEndpoints("horizon");
      expect(eps[0].failureCount).toBe(0);
      expect(eps[0].healthy).toBe(true);
    });
  });

  describe("latency tracking", () => {
    it("records latency with exponential moving average", () => {
      registry.registerEndpoint("rpc", "https://example.com");

      registry.recordLatency("rpc", "https://example.com", 100);
      let eps = registry.getEndpoints("rpc");
      expect(eps[0].latencyMs).toBe(100); // First measurement

      registry.recordLatency("rpc", "https://example.com", 200);
      eps = registry.getEndpoints("rpc");
      // EMA: 100 * 0.7 + 200 * 0.3 = 130
      expect(eps[0].latencyMs).toBeCloseTo(130, 0);
    });
  });

  describe("testEndpoint", () => {
    it("reports healthy for successful fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      registry = createEndpointRegistry({ fetchFn: mockFetch as unknown as typeof fetch });
      registry.registerEndpoint("horizon", "https://example.com");

      const result = await registry.testEndpoint("https://example.com");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.healthy).toBe(true);
        expect(result.data.httpStatus).toBe(200);
        expect(typeof result.data.latencyMs).toBe("number");
      }

      const eps = registry.getEndpoints("horizon");
      expect(eps[0].healthy).toBe(true);
      expect(eps[0].failureCount).toBe(0);
    });

    it("reports unhealthy for failed fetch", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      registry = createEndpointRegistry({ fetchFn: mockFetch as unknown as typeof fetch });
      registry.registerEndpoint("rpc", "https://dead.com");

      const result = await registry.testEndpoint("https://dead.com");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.healthy).toBe(false);
      }

      const eps = registry.getEndpoints("rpc");
      expect(eps[0].failureCount).toBe(1);
    });

    it("returns error when no fetch available", async () => {
      const origFetch = (globalThis as any).fetch;
      try {
        (globalThis as any).fetch = undefined;
        registry = createEndpointRegistry({ fetchFn: undefined });
        const result = await registry.testEndpoint("https://example.com");
        expect(result.status).toBe("error");
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });
  });

  describe("clear", () => {
    it("removes all endpoints", () => {
      registry.registerEndpoint("horizon", "https://a.com");
      registry.registerEndpoint("rpc", "https://b.com");
      expect(registry.getEndpoints()).toHaveLength(2);

      registry.clear();
      expect(registry.getEndpoints()).toHaveLength(0);
    });
  });
});
