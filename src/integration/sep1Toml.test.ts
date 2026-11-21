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

  it("caches successful results for the configured TTL, used as a fallback if verification is unavailable", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('AUTH_SERVER = "https://auth.example.com"'));
    const options = { fetch: fetcher, ttlMs: 60_000, verifyOnCacheHit: false };

    await fetchStellarToml("https://example.com", options);
    await fetchStellarToml("example.com", options);

    // With verification explicitly disabled, a cache hit is trusted
    // immediately without a second network call.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("by default, re-verifies a cache hit against a fresh fetch (#837)", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('AUTH_SERVER = "https://auth.example.com"'));
    const options = { fetch: fetcher, ttlMs: 60_000 };

    await fetchStellarToml("https://example.com", options);
    const second = await fetchStellarToml("example.com", options);

    // Verification happens on every cache hit by default — the fresh data
    // agrees with the cached data, so the result is still served correctly.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      expect(second.data.auth_server).toBe("https://auth.example.com");
    }
  });

  it("invalidates the cache and warns when a re-verification fetch reveals a changed SIGNING_KEY (#837)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('SIGNING_KEY = "GOLDKEY00000000000000000000000000000000000000000000"'))
      .mockResolvedValueOnce(new Response('SIGNING_KEY = "GATTACKER0000000000000000000000000000000000000000000"'));
    const warn = vi.fn();
    const options = {
      fetch: fetcher,
      ttlMs: 60_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    };

    const first = await fetchStellarToml("example.com", options);
    expect(first.status).toBe("ok");
    if (first.status === "ok") expect(first.data.SIGNING_KEY).toContain("GOLDKEY");

    const second = await fetchStellarToml("example.com", options);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("diverged"),
      expect.objectContaining({ domain: "example.com" }),
    );
    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      // Returns the fresh (correct) data, not the stale cached one.
      expect(second.data.SIGNING_KEY).toContain("GATTACKER");
    }

    // A third call must see the (now updated) cache agree with another
    // fresh fetch and must not warn again.
    const thirdFetcher = vi.fn().mockResolvedValue(
      new Response('SIGNING_KEY = "GATTACKER0000000000000000000000000000000000000000000"'),
    );
    const third = await fetchStellarToml("example.com", { ...options, fetch: thirdFetcher });
    expect(third.status).toBe("ok");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cached value when the re-verification fetch itself fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('AUTH_SERVER = "https://auth.example.com"'))
      .mockRejectedValueOnce(new Error("network blip"));
    const options = { fetch: fetcher, ttlMs: 60_000 };

    const first = await fetchStellarToml("example.com", options);
    expect(first.status).toBe("ok");

    const second = await fetchStellarToml("example.com", options);
    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      expect(second.data.auth_server).toBe("https://auth.example.com");
    }
  });

  it("fetches again after the configured TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockImplementation(async () => new Response('AUTH_SERVER = "https://auth.example.com"'));
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
    const fetcher = vi.fn().mockImplementation(async () => new Response('AUTH_SERVER = "https://auth.example.com"'));

    await fetchStellarToml("example.com", { fetch: fetcher, ttlMs: 0 });
    await fetchStellarToml("example.com", { fetch: fetcher, ttlMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("tries the SEP-1 well-known path first (#862)", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('AUTH_SERVER = "https://auth.example.com"'));

    await fetchStellarToml("example.com", { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://example.com/.well-known/stellar.toml"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("falls back to the legacy root path when .well-known is missing (#862)", async () => {
    const fetcher = vi.fn().mockImplementation(async (url: URL) => {
      if (url.pathname === "/.well-known/stellar.toml") {
        return new Response("Not found", { status: 404 });
      }
      return new Response('AUTH_SERVER = "https://auth.example.com"', { status: 200 });
    });

    const result = await fetchStellarToml("example.com", { fetch: fetcher });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.AUTH_SERVER).toBe("https://auth.example.com");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("https://example.com/.well-known/stellar.toml"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("https://example.com/stellar.toml"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns an error when both the well-known and legacy root paths fail (#862)", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    const result = await fetchStellarToml("example.com", { fetch: fetcher });

    expect(result.status).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to the legacy root path when .well-known succeeds (#862)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('AUTH_SERVER = "https://auth.example.com"', { status: 200 }),
    );

    await fetchStellarToml("example.com", { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});