import { beforeEach, describe, expect, it, vi } from "vitest";
import { StellarToml } from "@stellar/stellar-sdk";
import { clearAnchorCache, getAnchorInfo } from "./anchors";
import { fetchStellarToml } from "./sep1Toml";

describe("getAnchorInfo", () => {
  beforeEach(() => clearAnchorCache());

  it("reuses cached anchor information for the same domain when verification is disabled", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);

    const first = await getAnchorInfo("example.com", { verifyOnCacheHit: false });
    const second = await getAnchorInfo("example.com", { verifyOnCacheHit: false });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("by default, re-verifies a cache hit against a fresh resolve (#837)", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);

    const first = await getAnchorInfo("example.com");
    const second = await getAnchorInfo("example.com");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cache and warns when re-verification reveals a changed SIGNING_KEY (#837)", async () => {
    const resolve = vi
      .spyOn(StellarToml.Resolver, "resolve")
      .mockResolvedValueOnce({ SIGNING_KEY: "GOLDKEY00000000000000000000000000000000000000000000" } as never)
      .mockResolvedValueOnce({ SIGNING_KEY: "GATTACKER0000000000000000000000000000000000000000000" } as never);
    const warn = vi.fn();

    const first = await getAnchorInfo("example.com");
    if (first.status === "ok") expect(first.data.SIGNING_KEY).toContain("GOLDKEY");

    const second = await getAnchorInfo("example.com", {
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("diverged"),
      expect.objectContaining({ domain: "example.com" }),
    );
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.data.SIGNING_KEY).toContain("GATTACKER");
  });

  it("fetches anchor information again after the configured TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
        TRANSFER_SERVER: "https://anchor.example.com/sep6",
      } as never);

      await getAnchorInfo("example.com", { ttlMs: 100 });
      await vi.advanceTimersByTimeAsync(101);
      await getAnchorInfo("example.com", { ttlMs: 100 });

      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates cached anchor information", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);

    await getAnchorInfo("example.com", { verifyOnCacheHit: false });
    clearAnchorCache();
    await getAnchorInfo("example.com", { verifyOnCacheHit: false });

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("shares normalized TOML entries with the SEP-1 cache", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);
    const fetcher = vi.fn();

    await getAnchorInfo("example.com", { verifyOnCacheHit: false });
    const result = await fetchStellarToml("example.com", { fetch: fetcher, verifyOnCacheHit: false });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transfer_server).toBe("https://anchor.example.com/sep6");
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
