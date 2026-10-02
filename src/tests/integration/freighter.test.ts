/**
 * Integration tests for Freighter wallet adapter (#198).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FreighterAdapter } from "../../wallet/adapters/freighter";
import type { SWKInstance } from "../../wallet/types";

describe("Freighter adapter integration tests", () => {
  let mockKit: SWKInstance;

  beforeEach(() => {
    // Mock SWK instance
    mockKit = {
      getAddress: vi.fn(),
      signTransaction: vi.fn(),
    } as unknown as SWKInstance;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("should successfully connect to Freighter wallet", async () => {
      vi.stubGlobal("window", { document: {} });

      (mockKit.getAddress as any).mockResolvedValue({
        address: "GABC1234567890DEF...",
      });

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.connect();

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe("GABC1234567890DEF...");
      }
    });

    it("should fail when wallet is not available", async () => {
      // Mock isBrowser to return false
      vi.stubGlobal("window", undefined);

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.connect();

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("WALLET_BROWSER_ONLY");
    });

    it("should handle connection errors gracefully", async () => {
      vi.stubGlobal("window", { document: {} });

      (mockKit.getAddress as any).mockRejectedValue(new Error("User rejected"));

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.connect();

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("WALLET_CONNECT_FAILED");
    });
  });

  describe("disconnect", () => {
    it("should successfully disconnect from Freighter wallet", async () => {
      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.disconnect();

      expect(result.status).toBe("ok");
      expect(result.data).toBeUndefined();
    });

    it("should handle disconnect when already disconnected", async () => {
      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.disconnect();

      expect(result.status).toBe("ok");
      expect(result.data).toBeUndefined();
    });
  });

  describe("signTransaction", () => {
    it("should successfully sign a transaction", async () => {
      vi.stubGlobal("window", { document: {} });

      (mockKit.signTransaction as any).mockResolvedValue({
        signedTxXdr: "AAAB...", // Signed XDR
      });

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "AAAA...",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toMatch(/AAAB/);
      }
    });

    it("should fail when wallet is not available", async () => {
      vi.stubGlobal("window", undefined);

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "AAAA...",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("WALLET_BROWSER_ONLY");
    });

    it("should handle user rejection", async () => {
      vi.stubGlobal("window", { document: {} });

      (mockKit.signTransaction as any).mockRejectedValue(
        new Error("User rejected"),
      );

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "AAAA...",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("WALLET_SIGN_REJECTED");
    });

    it("should handle timeout", async () => {
      const timeout = new AbortController();
      const abortTimer = setTimeout(() => timeout.abort(), 100);

      (mockKit.signTransaction as any).mockImplementation(
        () =>
          new Promise((_, reject) => {
            timeout.signal.addEventListener("abort", () => {
              clearTimeout(abortTimer);
              reject(new Error("Timeout"));
            });
          }),
      );

      const adapter = new FreighterAdapter(mockKit);

      // Set a short timeout for the test
      const result = await adapter.signTransaction({
        transactionXdr: "AAAA...",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
    }, 1000);

    it("should handle network errors", async () => {
      (mockKit.signTransaction as any).mockRejectedValue(
        new Error("Network error"),
      );

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "AAAA...",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
      expect(result.error?.code).toBeDefined();
    });
  });

  describe("isAvailable", () => {
    it("should return true when in browser environment", () => {
      vi.stubGlobal("window", { document: {} });

      const adapter = new FreighterAdapter(mockKit);
      const available = adapter.isAvailable();
      expect(available).toBe(true);
    });

    it("should return false when not in browser environment", () => {
      vi.stubGlobal("window", undefined);

      const adapter = new FreighterAdapter(mockKit);
      const available = adapter.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe("walletType", () => {
    it("should return correct wallet type", () => {
      const adapter = new FreighterAdapter(mockKit);
      expect(adapter.walletType).toBe("FREIGHTER");
    });
  });

  describe("error scenarios", () => {
    it("should handle invalid XDR format", async () => {
      (mockKit.signTransaction as any).mockRejectedValue(
        new Error("Invalid XDR"),
      );

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "invalid-xdr",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
    });

    it("should handle empty XDR", async () => {
      (mockKit.signTransaction as any).mockRejectedValue(
        new Error("Empty XDR"),
      );

      const adapter = new FreighterAdapter(mockKit);
      const result = await adapter.signTransaction({
        transactionXdr: "",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      expect(result.status).toBe("error");
    });
  });
});
