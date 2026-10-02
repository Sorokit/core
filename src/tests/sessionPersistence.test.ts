import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveSession,
  restoreSession,
  clearSession,
  isSessionValid,
  saveWalletSession,
  loadWalletSession,
  clearWalletSession,
  DEFAULT_SESSION_KEY,
  encryptSessionPayload,
  decryptSessionPayload,
} from "../wallet/sessionPersistence";
import type { WalletConnection, SessionData } from "../wallet/sessionPersistence";
import { createSorokitClient } from "../client/createSorokitClient";

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    length: store.size,
  };
}

describe("Wallet Session Persistence and Auto-Recovery (#671)", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    Reflect.set(globalThis, "window", {
      localStorage: mockStorage,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "window");
  });

  describe("saveSession and restoreSession", () => {
    it("persists connection session and restores it accurately", async () => {
      const connection: WalletConnection = {
        publicKey: "GDG46KJJEQRFXQ7K4K2X6N45K53EZV5M3D7UZZW4T73Z5U23FNYHAY5E",
        walletType: "freighter",
        network: "testnet",
        metadata: { clientVersion: "1.2.0" },
      };

      const saveResult = await saveSession(connection, { storage: mockStorage });
      expect(saveResult.status).toBe("ok");
      if (saveResult.status !== "ok") return;

      expect(saveResult.data.publicKey).toBe(connection.publicKey);
      expect(saveResult.data.walletType).toBe("freighter");
      expect(saveResult.data.network).toBe("testnet");
      expect(saveResult.data.metadata).toEqual({ clientVersion: "1.2.0" });
      expect(typeof saveResult.data.connectedAt).toBe("number");
      expect(typeof saveResult.data.expiresAt).toBe("number");
      expect(saveResult.data.expiresAt).toBeGreaterThan(saveResult.data.connectedAt);

      const restoreResult = await restoreSession({ storage: mockStorage });
      expect(restoreResult.status).toBe("ok");
      if (restoreResult.status !== "ok") return;

      expect(restoreResult.data.publicKey).toBe(connection.publicKey);
      expect(restoreResult.data.walletType).toBe("freighter");
      expect(restoreResult.data.network).toBe("testnet");
      expect(restoreResult.data.metadata).toEqual({ clientVersion: "1.2.0" });
    });

    it("encrypts sensitive session data in underlying storage", async () => {
      const connection: WalletConnection = {
        publicKey: "GBBD57IFDYXOM7TG74G5FYSQ3D7I4A2I5O47J252EEYJ5M4KXZV44L6J",
        walletType: "xbull",
        network: "mainnet",
      };

      await saveSession(connection, { storage: mockStorage });

      const raw = mockStorage.getItem(DEFAULT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(raw).not.toContain(connection.publicKey);

      const parsed = JSON.parse(raw!);
      expect(parsed.__sorokit_encrypted).toBe(true);
      expect(parsed.version).toBe(1);
      expect(typeof parsed.iv).toBe("string");
      expect(typeof parsed.ciphertext).toBe("string");
      expect(typeof parsed.expiresAt).toBe("number");
    });

    it("supports custom encryption key and rejects restoration with invalid key", async () => {
      const connection: WalletConnection = {
        publicKey: "GA5W2Q427MUWCCEQF7L6RCL66PRTVT5Q525V5Z64D2I46Z56KXZV44L6J",
        walletType: "albedo",
      };

      const customKey = "my_custom_secret_key_12345";
      await saveSession(connection, { storage: mockStorage, encryptionKey: customKey });

      const restoreFail = await restoreSession({
        storage: mockStorage,
        encryptionKey: "wrong_secret_key",
      });
      expect(restoreFail.status).toBe("error");

      const restoreSuccess = await restoreSession({
        storage: mockStorage,
        encryptionKey: customKey,
      });
      expect(restoreSuccess.status).toBe("ok");
      if (restoreSuccess.status === "ok") {
        expect(restoreSuccess.data.publicKey).toBe(connection.publicKey);
      }
    });

    it("rejects session saving without a public key", async () => {
      const invalidConnection = {
        publicKey: "",
        walletType: "freighter",
      } as WalletConnection;

      const result = await saveSession(invalidConnection, { storage: mockStorage });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("publicKey");
      }
    });

    it("returns error when no session is present in storage", async () => {
      const result = await restoreSession({ storage: mockStorage });
      expect(result.status).toBe("error");
    });
  });

  describe("TTL enforcement and expiry", () => {
    it("enforces TTL and refuses to restore expired sessions", async () => {
      const connection: WalletConnection = {
        publicKey: "GCLYF4LALJ2P4K3TXZV5M3D7UZZW4T73Z5U23FNYHAY5E64D2I46Z56K",
        walletType: "lobstr",
      };

      // Set a short TTL of 50ms
      await saveSession(connection, { storage: mockStorage, ttlMs: 50 });

      // Before expiry
      const unexpired = await restoreSession({ storage: mockStorage });
      expect(unexpired.status).toBe("ok");

      // Advance time past TTL
      await new Promise((resolve) => setTimeout(resolve, 80));

      const expired = await restoreSession({ storage: mockStorage });
      expect(expired.status).toBe("error");
      if (expired.status === "error") {
        expect(expired.error.message).toContain("expired");
      }

      // Storage should have been cleaned up automatically
      expect(mockStorage.getItem(DEFAULT_SESSION_KEY)).toBeNull();
    });

    it("isSessionValid returns true for active session and false for expired or corrupted session", () => {
      const now = Date.now();
      const validSession: SessionData = {
        publicKey: "GCLYF4LALJ2P4K3TXZV5M3D7UZZW4T73Z5U23FNYHAY5E64D2I46Z56K",
        connectedAt: now,
        expiresAt: now + 60_000,
      };

      const expiredSession: SessionData = {
        publicKey: "GCLYF4LALJ2P4K3TXZV5M3D7UZZW4T73Z5U23FNYHAY5E64D2I46Z56K",
        connectedAt: now - 120_000,
        expiresAt: now - 60_000,
      };

      expect(isSessionValid(validSession)).toBe(true);
      expect(isSessionValid(expiredSession)).toBe(false);
      expect(isSessionValid(null)).toBe(false);
      expect(isSessionValid(undefined)).toBe(false);
      expect(isSessionValid({} as SessionData)).toBe(false);
    });
  });

  describe("clearSession (logout)", () => {
    it("removes persisted session on logout", async () => {
      const connection: WalletConnection = {
        publicKey: "GDG46KJJEQRFXQ7K4K2X6N45K53EZV5M3D7UZZW4T73Z5U23FNYHAY5E",
        walletType: "freighter",
      };

      await saveSession(connection, { storage: mockStorage });
      expect(mockStorage.getItem(DEFAULT_SESSION_KEY)).not.toBeNull();

      const clearResult = clearSession({ storage: mockStorage });
      expect(clearResult.status).toBe("ok");
      expect(mockStorage.getItem(DEFAULT_SESSION_KEY)).toBeNull();

      const restoreResult = await restoreSession({ storage: mockStorage });
      expect(restoreResult.status).toBe("error");
    });
  });

  describe("encryption utilities", () => {
    it("encrypts and decrypts session payload with AES-GCM", async () => {
      const plaintext = JSON.stringify({ secretInfo: "stellar-secret-token", count: 42 });
      const secret = "test-secret-key-salt";
      const expiresAt = Date.now() + 10_000;

      const payload = await encryptSessionPayload(plaintext, secret, expiresAt);
      expect(payload.__sorokit_encrypted).toBe(true);
      expect(payload.version).toBe(1);
      expect(payload.expiresAt).toBe(expiresAt);

      const decrypted = await decryptSessionPayload(payload, secret);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("Client Integration — standalone functions matching issue usage", () => {
    it("demonstrates the documented API: save → restore → clearSession flow", async () => {
      const connection: WalletConnection = {
        publicKey: "GBBD57IFDYXOM7TG74G5FYSQ3D7I4A2I5O47J252EEYJ5M4KXZV44L6J",
        walletType: "freighter",
        network: "testnet",
      };

      // Save session (equivalent to: client.wallet.saveSession)
      const saveRes = await saveSession(connection, { storage: mockStorage });
      expect(saveRes.status).toBe("ok");

      // Restore session (equivalent to: const restored = await client.wallet.restoreSession())
      const restored = await restoreSession({ storage: mockStorage });
      expect(restored.status).toBe("ok");
      if (restored.status === "ok") {
        expect(restored.data.publicKey).toBe("GBBD57IFDYXOM7TG74G5FYSQ3D7I4A2I5O47J252EEYJ5M4KXZV44L6J");
        expect(isSessionValid(restored.data)).toBe(true);
      }

      // Logout (equivalent to: client.wallet.clearSession())
      const clearRes = clearSession({ storage: mockStorage });
      expect(clearRes.status).toBe("ok");

      const afterLogout = await restoreSession({ storage: mockStorage });
      expect(afterLogout.status).toBe("error");
    });
  });

  describe("Backward Compatibility with legacy wallet session functions", () => {
    it("still supports legacy saveWalletSession, loadWalletSession, clearWalletSession", () => {
      const legacyState = {
        accountId: "GLEGACYACCOUNTID123456789",
        connectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        network: "testnet",
      };

      expect(saveWalletSession(legacyState).status).toBe("ok");
      const loaded = loadWalletSession();
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") {
        expect(loaded.data).toEqual(legacyState);
      }

      expect(clearWalletSession().status).toBe("ok");
      const cleared = loadWalletSession();
      expect(cleared.status).toBe("ok");
      if (cleared.status === "ok") {
        expect(cleared.data).toBeNull();
      }
    });
  });
});
