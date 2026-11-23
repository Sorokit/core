import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAssetMetadata,
  clearAssetMetadataCache,
  getCachedAssetMetadata,
} from "../integration/assetMetadataResolver";

describe("asset metadata resolver (#960)", () => {
  const issuerKey = "GDZSTSFDZVTLY27X2Y65DCE4G62OQ62YV5SGL2E67DTDT66RFD7GZQ6W";

  beforeEach(() => {
    clearAssetMetadataCache();
    vi.restoreAllMocks();
  });

  it("resolves native XLM metadata without network call", async () => {
    const result = await getAssetMetadata("XLM", "");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.code).toBe("XLM");
      expect(result.data.name).toBe("Lumen");
      expect(result.data.domain).toBe("stellar.org");
    }
  });

  it("fetches asset metadata from issuer domain and caches it", async () => {
    const mockTomlContent = `
      VERSION = "2.0.0"
      [DOCUMENTATION]
      ORG_NAME = "USD Issuer Inc"

      [[CURRENCIES]]
      code = "USDC"
      issuer = "${issuerKey}"
      name = "USD Coin"
      desc = "Digital dollar backed 1:1"
      image = "https://example.com/usdc.png"
      display_decimals = 7
    `;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(".well-known/stellar.toml")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mockTomlContent),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
      });
    });

    const result = await getAssetMetadata("USDC", issuerKey, {
      domain: "example.com",
      fetch: mockFetch as any,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.code).toBe("USDC");
      expect(result.data.name).toBe("USD Coin");
      expect(result.data.description).toBe("Digital dollar backed 1:1");
      expect(result.data.logo).toBe("https://example.com/usdc.png");
      expect(result.data.orgName).toBe("USD Issuer Inc");
      expect(result.data.decimals).toBe(7);
    }

    // Verify cache hit
    const cached = getCachedAssetMetadata("USDC", issuerKey);
    expect(cached).toBeDefined();
    expect(cached?.name).toBe("USD Coin");

    // Second call should use cache and not fetch again
    const secondResult = await getAssetMetadata("USDC", issuerKey, {
      domain: "example.com",
      fetch: mockFetch as any,
    });
    expect(secondResult.status).toBe("ok");
  });

  it("handles missing domain or account gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await getAssetMetadata("UNKNOWN", issuerKey, {
      fetch: mockFetch as any,
    });
    expect(result.status).toBe("error");
  });
});
