import { describe, it, expect, vi } from "vitest";
import { performHealthCheck } from "./healthCheck";

describe("Health Check Endpoint (#1001)", () => {
  it("returns healthy status when all endpoints are up", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      return {
        ok: true,
        status: 200,
      } as Response;
    });

    const res = await performHealthCheck({
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 1000,
    });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.healthy).toBe(true);
      expect(res.data.status).toBe("healthy");
      expect(res.data.endpoints.horizon?.status).toBe("up");
      expect(res.data.endpoints.sorobanRpc?.status).toBe("up");
    }
  });

  it("reports degraded or unhealthy when endpoints fail", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("soroban")) {
        throw new Error("Connection refused");
      }
      return {
        ok: true,
        status: 200,
      } as Response;
    });

    const res = await performHealthCheck({
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 1000,
    });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.healthy).toBe(false);
      expect(res.data.status).toBe("degraded");
      expect(res.data.endpoints.horizon?.status).toBe("up");
      expect(res.data.endpoints.sorobanRpc?.status).toBe("down");
      expect(res.data.endpoints.sorobanRpc?.error).toBe("Connection refused");
    }
  });

  it("checks custom endpoints", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const res = await performHealthCheck({
      fetchFn: mockFetch as unknown as typeof fetch,
      customEndpoints: {
        friendbot: "https://friendbot.stellar.org",
      },
    });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.endpoints.friendbot).toBeDefined();
      expect(res.data.endpoints.friendbot?.status).toBe("up");
    }
  });
});
