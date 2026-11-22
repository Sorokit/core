/**
 * Wallet State Manager — Persist and Restore Wallet Connections (#1006)
 *
 * Persists wallet connections, active account, and user settings across reloads
 * with end-to-end encryption for sensitive data.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  encryptSessionPayload,
  decryptSessionPayload,
} from "./sessionPersistence";

export interface WalletConnectionState {
  connectedWallets: string[];
  activeAccount: string | null;
  activeWalletType?: string | null | undefined;
  network?: string | undefined;
  settings?: Record<string, unknown> | undefined;
  lastConnectedAt?: number | undefined;
}

export interface StateManagerOptions {
  storage?: Storage | undefined;
  storageKey?: string | undefined;
  encryptionKey?: string | undefined;
}

export const DEFAULT_STATE_KEY = "sorokit_wallet_state";
const DEFAULT_STATE_SECRET = "sorokit_state_encryption_secret_v1";

function getAvailableStorage(options?: StateManagerOptions): Storage | null {
  if (options?.storage) return options.storage;
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof globalThis !== "undefined") {
    const g = globalThis as unknown as { _sorokitMemoryStorage?: Storage };
    if (!g._sorokitMemoryStorage) {
      const store = new Map<string, string>();
      g._sorokitMemoryStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => {
          store.clear();
        },
        key: (idx: number) => Array.from(store.keys())[idx] ?? null,
        get length() {
          return store.size;
        },
      } as Storage;
    }
    return g._sorokitMemoryStorage;
  }
  return null;
}

/**
 * Persist wallet state into storage with encryption.
 */
export async function saveWalletState(
  state: WalletConnectionState,
  options?: StateManagerOptions,
): Promise<SorokitResult<WalletConnectionState>> {
  try {
    if (!state || !Array.isArray(state.connectedWallets)) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Invalid wallet state: connectedWallets array is required",
      );
    }

    const storage = getAvailableStorage(options);
    if (!storage) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "No storage mechanism available for wallet state persistence",
      );
    }

    const storageKey = options?.storageKey ?? DEFAULT_STATE_KEY;
    const secret = options?.encryptionKey ?? DEFAULT_STATE_SECRET;

    const stateToSave: WalletConnectionState = {
      connectedWallets: [...state.connectedWallets],
      activeAccount: state.activeAccount ?? null,
      activeWalletType: state.activeWalletType ?? null,
      network: state.network ?? "testnet",
      settings: state.settings ? { ...state.settings } : {},
      lastConnectedAt: state.lastConnectedAt ?? Date.now(),
    };

    const encrypted = await encryptSessionPayload(
      JSON.stringify(stateToSave),
      secret,
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    );

    storage.setItem(storageKey, JSON.stringify(encrypted));
    return ok(stateToSave);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to persist wallet state",
      cause,
    );
  }
}

/**
 * Restore persisted wallet state from storage, decrypting with secret key.
 */
export async function loadWalletState(
  options?: StateManagerOptions,
): Promise<SorokitResult<WalletConnectionState>> {
  try {
    const storage = getAvailableStorage(options);
    if (!storage) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "No storage mechanism available for wallet state persistence",
      );
    }

    const storageKey = options?.storageKey ?? DEFAULT_STATE_KEY;
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "No saved wallet state found in storage",
      );
    }

    const secret = options?.encryptionKey ?? DEFAULT_STATE_SECRET;
    let state: WalletConnectionState;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.__sorokit_encrypted) {
        const decryptedJson = await decryptSessionPayload(parsed, secret);
        state = JSON.parse(decryptedJson) as WalletConnectionState;
      } else {
        state = parsed as WalletConnectionState;
      }
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "Failed to decrypt or parse saved wallet state",
        cause,
      );
    }

    return ok(state);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to restore wallet state",
      cause,
    );
  }
}

/**
 * Clear stored wallet state (e.g. on user logout / disconnect).
 */
export function clearWalletState(
  options?: StateManagerOptions,
): SorokitResult<void> {
  try {
    const storage = getAvailableStorage(options);
    if (storage) {
      const storageKey = options?.storageKey ?? DEFAULT_STATE_KEY;
      storage.removeItem(storageKey);
    }
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_NOT_CONNECTED,
      cause instanceof Error ? cause.message : "Failed to clear wallet state",
      cause,
    );
  }
}

/**
 * State Manager Class providing unified API for saving, loading, and clearing wallet state.
 */
export class WalletStateManager {
  private options: StateManagerOptions | undefined;
  private inMemoryCache: WalletConnectionState | null = null;

  constructor(options?: StateManagerOptions) {
    this.options = options;
  }

  async saveState(
    state: WalletConnectionState,
  ): Promise<SorokitResult<WalletConnectionState>> {
    const result = await saveWalletState(state, this.options);
    if (result.status === "ok") {
      this.inMemoryCache = result.data;
    }
    return result;
  }

  async loadState(): Promise<SorokitResult<WalletConnectionState>> {
    const result = await loadWalletState(this.options);
    if (result.status === "ok") {
      this.inMemoryCache = result.data;
    }
    return result;
  }

  clearState(): SorokitResult<void> {
    this.inMemoryCache = null;
    return clearWalletState(this.options);
  }

  getState(): WalletConnectionState | null {
    return this.inMemoryCache;
  }
}

export function createWalletStateManager(
  options?: StateManagerOptions,
): WalletStateManager {
  return new WalletStateManager(options);
}
