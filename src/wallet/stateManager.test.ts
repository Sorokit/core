import { describe, it, expect, beforeEach } from "vitest";
import {
  saveWalletState,
  loadWalletState,
  clearWalletState,
  createWalletStateManager,
  type WalletConnectionState,
} from "./stateManager";

describe("WalletStateManager (#1006)", () => {
  const mockStorageStore = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key: string) => mockStorageStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      mockStorageStore.set(key, String(value));
    },
    removeItem: (key: string) => {
      mockStorageStore.delete(key);
    },
    clear: () => {
      mockStorageStore.clear();
    },
    key: (i: number) => Array.from(mockStorageStore.keys())[i] ?? null,
    get length() {
      return mockStorageStore.size;
    },
  };

  const sampleState: WalletConnectionState = {
    connectedWallets: ["freighter", "xbull"],
    activeAccount: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    activeWalletType: "freighter",
    network: "testnet",
    settings: { autoSign: false, timeout: 30 },
  };

  beforeEach(() => {
    mockStorageStore.clear();
  });

  it("persists wallet state to storage and encrypts it", async () => {
    const res = await saveWalletState(sampleState, { storage: mockStorage });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.connectedWallets).toEqual(["freighter", "xbull"]);
      expect(res.data.activeAccount).toBe(sampleState.activeAccount);
    }

    const storedRaw = mockStorage.getItem("sorokit_wallet_state");
    expect(storedRaw).toBeDefined();
    const parsed = JSON.parse(storedRaw!);
    expect(parsed.__sorokit_encrypted).toBe(true);
    expect(parsed.ciphertext).toBeDefined();
  });

  it("restores persisted wallet state correctly", async () => {
    await saveWalletState(sampleState, { storage: mockStorage });
    const loaded = await loadWalletState({ storage: mockStorage });

    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.data.connectedWallets).toEqual(["freighter", "xbull"]);
      expect(loaded.data.activeAccount).toBe(sampleState.activeAccount);
      expect(loaded.data.network).toBe("testnet");
      expect(loaded.data.settings).toEqual({ autoSign: false, timeout: 30 });
    }
  });

  it("clears wallet state on disconnect", async () => {
    await saveWalletState(sampleState, { storage: mockStorage });
    expect(mockStorage.getItem("sorokit_wallet_state")).not.toBeNull();

    const clearRes = clearWalletState({ storage: mockStorage });
    expect(clearRes.status).toBe("ok");
    expect(mockStorage.getItem("sorokit_wallet_state")).toBeNull();

    const loadAfter = await loadWalletState({ storage: mockStorage });
    expect(loadAfter.status).toBe("error");
  });

  it("WalletStateManager class instance methods work smoothly", async () => {
    const mgr = createWalletStateManager({ storage: mockStorage });
    await mgr.saveState(sampleState);
    expect(mgr.getState()?.activeAccount).toBe(sampleState.activeAccount);

    const reloaded = await mgr.loadState();
    expect(reloaded.status).toBe("ok");

    mgr.clearState();
    expect(mgr.getState()).toBeNull();
  });
});
