import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStellarTomlCache,
  fetchStellarToml,
} from "./sep1Toml";

describe("fetchStellarToml", () => {
  beforeEach(() => clearStellarTomlCache());

  it("fetches and parses standard stellar.toml fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'FEDERATION_SERVER = "https://example.com/federation"\nTRANSFER_SERVER = "https://example.com/sep6"',
      { status: 200 },
    ));

    const result = await fetchStellarToml("example.com", { fetch: fetcher });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.FEDERATION_SERVER).toBe("https://example.com/federation");
      expect(result.data.TRANSFER_SERVER).toBe("https://example.com/sep6");
      expect(result.data.federation_server).toBe("https://example.com/federation");
      expect(result.data.transfer_server).toBe("https://example.com/sep6");
    }
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://example.com/.well-known/stellar.toml"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects invalid domains without making a request", async () => {
    const fetcher = vi.fn();
    const result = await fetchStellarToml("https://user:pass@example.com/path", { fetch: fetcher });

    expect(result.status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a parse error for malformed TOML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("INVALID = [", { status: 200 }));

    const result = await fetchStellarToml("example.com", { fetch: fetcher });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_CONFIG");
  });

  it("caches successful results for the configured TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('AUTH_SERVER = "https://auth.example.com"'));
    const options = { fetch: fetcher, ttlMs: 60_000 };

    await fetchStellarToml("https://example.com", options);
    await fetchStellarToml("example.com", options);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches again after the configured TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(new Response('AUTH_SERVER = "https://auth.example.com"'));
      const options = { fetch: fetcher, ttlMs: 100 };

      await fetchStellarToml("example.com", options);
      await vi.advanceTimersByTimeAsync(101);
      await fetchStellarToml("example.com", options);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache when the TTL is zero", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('AUTH_SERVER = "https://auth.example.com"'));

    await fetchStellarToml("example.com", { fetch: fetcher, ttlMs: 0 });
    await fetchStellarToml("example.com", { fetch: fetcher, ttlMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});