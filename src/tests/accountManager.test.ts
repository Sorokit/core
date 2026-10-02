import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WalletAccountManager,
  createAccountManager,
  InMemoryAccountStorage,
} from "../wallet/accountManager";
import { createSorokitClient } from "../client/createSorokitClient";

const VALID_KEY_1 = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const VALID_KEY_2 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const VALID_KEY_3 = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYFTRE6A6PIFLSUFZOO";
const INVALID_KEY = "not-a-stellar-key";

describe("WalletAccountManager (#579)", () => {
  let storageAdapter: InMemoryAccountStorage;
  let manager: WalletAccountManager;

  beforeEach(() => {
    storageAdapter = new InMemoryAccountStorage();
    manager = createAccountManager({ storageAdapter, namespace: "test" });
  });

  describe("addAccount", () => {
    it("registers an account with valid public key and metadata", async () => {
      const res = await manager.addAccount(VALID_KEY_1, {
        label: "Main Account",
        network: "testnet",
      });

      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.publicKey).toBe(VALID_KEY_1);
        expect(res.data.metadata.label).toBe("Main Account");
        expect(res.data.metadata.network).toBe("testnet");
        expect(typeof res.data.addedAt).toBe("string");
      }
    });

    it("automatically sets first added account as active", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });

      const activeRes = manager.getActiveAccount();
      expect(activeRes.status).toBe("ok");
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_1);
      }
    });

    it("does not change active account when adding subsequent accounts", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const activeRes = manager.getActiveAccount();
      expect(activeRes.status).toBe("ok");
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_1);
      }
    });

    it("returns an error for invalid public key format", async () => {
      const res = await manager.addAccount(INVALID_KEY);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe("INVALID_ADDRESS");
      }
    });
  });

  describe("listAccounts", () => {
    it("returns all registered accounts", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const listRes = await manager.listAccounts();
      expect(listRes.status).toBe("ok");
      if (listRes.status === "ok") {
        expect(listRes.data).toHaveLength(2);
        expect(listRes.data.map((a) => a.publicKey)).toEqual([
          VALID_KEY_1,
          VALID_KEY_2,
        ]);
      }
    });
  });

  describe("switchAccount", () => {
    it("switches active account to a registered key", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const switchRes = await manager.switchAccount(VALID_KEY_2);
      expect(switchRes.status).toBe("ok");
      if (switchRes.status === "ok") {
        expect(switchRes.data.publicKey).toBe(VALID_KEY_2);
      }

      const activeRes = manager.getActiveAccount();
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_2);
      }
    });

    it("returns ACCOUNT_NOT_FOUND error when switching to unregistered key", async () => {
      const switchRes = await manager.switchAccount(VALID_KEY_3);
      expect(switchRes.status).toBe("error");
      if (switchRes.status === "error") {
        expect(switchRes.error.code).toBe("ACCOUNT_NOT_FOUND");
      }
    });
  });

  describe("removeAccount", () => {
    it("unregisters an account", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const removeRes = await manager.removeAccount(VALID_KEY_2);
      expect(removeRes.status).toBe("ok");

      const listRes = await manager.listAccounts();
      if (listRes.status === "ok") {
        expect(listRes.data).toHaveLength(1);
        expect(listRes.data[0].publicKey).toBe(VALID_KEY_1);
      }
    });

    it("reassigns active account if active account is removed", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      await manager.removeAccount(VALID_KEY_1);

      const activeRes = manager.getActiveAccount();
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_2);
      }
    });

    it("returns ACCOUNT_NOT_FOUND error when removing unregistered key", async () => {
      const removeRes = await manager.removeAccount(VALID_KEY_3);
      expect(removeRes.status).toBe("error");
      if (removeRes.status === "error") {
        expect(removeRes.error.code).toBe("ACCOUNT_NOT_FOUND");
      }
    });
  });

  describe("watchAccountSwitch", () => {
    it("emits real-time notification when account is switched", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const listener = vi.fn();
      manager.watchAccountSwitch(listener);

      await manager.switchAccount(VALID_KEY_2);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: VALID_KEY_2 }),
        expect.objectContaining({ publicKey: VALID_KEY_1 }),
      );
    });

    it("unsubscribes listener when unsubscribe function is called", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });

      const listener = vi.fn();
      const unsubscribe = manager.watchAccountSwitch(listener);

      unsubscribe();
      await manager.switchAccount(VALID_KEY_2);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("Persistence", () => {
    it("restores account state across manager instances sharing storage", async () => {
      await manager.addAccount(VALID_KEY_1, { label: "Main" });
      await manager.addAccount(VALID_KEY_2, { label: "Trading" });
      await manager.switchAccount(VALID_KEY_2);

      // Create new manager instance with same storage & namespace
      const restoredManager = new WalletAccountManager({
        storageAdapter,
        namespace: "test",
      });

      const listRes = await restoredManager.listAccounts();
      expect(listRes.status).toBe("ok");
      if (listRes.status === "ok") {
        expect(listRes.data).toHaveLength(2);
      }

      const activeRes = restoredManager.getActiveAccount();
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_2);
      }
    });
  });

  describe("Client Integration", () => {
    it("allows multi-account operations directly through client.wallet", async () => {
      const clientResult = createSorokitClient({
        network: "testnet",
        accountStorageAdapter: storageAdapter,
      });

      expect(clientResult.status).toBe("ok");
      if (clientResult.status !== "ok") return;

      const client = clientResult.data;

      const addRes = await client.wallet.addAccount(VALID_KEY_1, {
        label: "Client Account",
      });
      expect(addRes.status).toBe("ok");

      const activeRes = client.wallet.getActiveAccount();
      expect(activeRes.status).toBe("ok");
      if (activeRes.status === "ok") {
        expect(activeRes.data?.publicKey).toBe(VALID_KEY_1);
      }

      const listRes = await client.wallet.listAccounts();
      expect(listRes.status).toBe("ok");
      if (listRes.status === "ok") {
        expect(listRes.data).toHaveLength(1);
      }
    });
  });
});
