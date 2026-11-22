import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSdkVersion, clearSdkVersionCache } from "./versionCheck";

describe("SDK Version Check Utility (#968)", () => {
  beforeEach(() => {
    clearSdkVersionCache();
  });

  it("identifies up to date SDK version", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.1.0" }),
    });

    const res = await checkSdkVersion({
      currentVersion: "0.1.0",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.isOutdated).toBe(false);
      expect(res.data.warning).toBeUndefined();
    }
  });

  it("detects and warns on outdated SDK version", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.3.0" }),
    });

    const onOutdatedSpy = vi.fn();

    const res = await checkSdkVersion({
      currentVersion: "0.1.0",
      fetchFn: mockFetch as unknown as typeof fetch,
      onOutdated: onOutdatedSpy,
    });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.isOutdated).toBe(true);
      expect(res.data.warning).toContain("is outdated");
      expect(onOutdatedSpy).toHaveBeenCalled();
    }
  });
});
