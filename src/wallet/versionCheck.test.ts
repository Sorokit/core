import { describe, it, expect } from "vitest";
import {
  checkWalletVersion,
  compareSemver,
  MINIMUM_WALLET_VERSIONS,
} from "./versionCheck";

describe("Wallet Upgrade Helper (#1005)", () => {
  it("compares semantic versions correctly", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("0.9.1", "1.0.0")).toBe(-1);
    expect(compareSemver("5.2.0", "5.2.0-beta.1")).toBe(0);
    expect(compareSemver("v5.1.0", "5.0.0")).toBe(1);
  });

  it("detects up-to-date wallet versions", () => {
    const res = checkWalletVersion("freighter", "5.1.0");
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.isSupported).toBe(true);
      expect(res.data.isOutdated).toBe(false);
      expect(res.data.warning).toBeUndefined();
    }
  });

  it("warns on outdated wallet versions below minimum", () => {
    const res = checkWalletVersion("freighter", "4.9.0");
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.isSupported).toBe(false);
      expect(res.data.isOutdated).toBe(true);
      expect(res.data.warning).toContain("below minimum supported version");
      expect(res.data.upgradeUrl).toBeDefined();
    }
  });

  it("handles wallet object inputs with embedded version", () => {
    const res = checkWalletVersion({
      walletType: "xbull",
      version: "0.6.2",
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.isSupported).toBe(true);
      expect(res.data.minimumVersion).toBe(MINIMUM_WALLET_VERSIONS.xbull);
    }
  });

  it("gracefully handles unknown version", () => {
    const res = checkWalletVersion("lobstr");
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.detectedVersion).toBe("unknown");
      expect(res.data.warning).toContain("Could not detect installed version");
    }
  });
});
