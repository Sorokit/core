/**
 * Multi-Account Wallet Manager and Account Switching (#579)
 *
 * Manages registration of multiple Stellar accounts per wallet session,
 * tracking active account state, emitting real-time switch notifications,
 * and persisting account registries across reloads.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";

/** Metadata associated with a registered wallet account */
export interface AccountMetadata {
  /** Human-readable account label (e.g. "Main Account", "Trading") */
  label?: string;
  /** Target network (e.g. "mainnet", "testnet") */
  network?: string;
  /** Custom key-value pairs */
  [key: string]: unknown;
}

/** Structured account record stored in the Account Manager */
export interface AccountData {
  /** Stellar public key (G...) */
  publicKey: string;
  /** Custom account metadata */
  metadata: AccountMetadata;
  /** ISO timestamp when account was registered */
  addedAt: string;
}

/** Listener callback triggered when the active account switches */
export type AccountSwitchListener = (
  activeAccount: AccountData | null,
  previousAccount: AccountData | null,
) => void;

/** Function returned by watchAccountSwitch to cancel subscription */
export type AccountSwitchUnsubscribe = () => void;

/** Pluggable storage adapter for persisting multi-account state */
export interface AccountStorageAdapter {
  save(key: string, data: { activePublicKey: string | null; accounts: AccountData[] }): void;
  load(key: string): { activePublicKey: string | null; accounts: AccountData[] } | null;
  clear(key: string): void;
}

/** In-memory fallback storage adapter */
export class InMemoryAccountStorage implements AccountStorageAdapter {
  private store = new Map<string, { activePublicKey: string | null; accounts: AccountData[] }>();

  save(key: string, data: { activePublicKey: string | null; accounts: AccountData[] }): void {
    this.store.set(key, JSON.parse(JSON.stringify(data)));
  }

  load(key: string): { activePublicKey: string | null; accounts: AccountData[] } | null {
    const data = this.store.get(key);
    return data ? JSON.parse(JSON.stringify(data)) : null;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}

/** Create a localStorage-backed AccountStorageAdapter when available */
export function createLocalStorageAccountStorage(
  storageKey = "sorokit:accounts",
): AccountStorageAdapter | null {
  if (
    typeof globalThis.localStorage === "undefined" ||
    globalThis.localStorage === null
  ) {
    return null;
  }

  return {
    save(key: string, data: { activePublicKey: string | null; accounts: AccountData[] }): void {
      try {
        globalThis.localStorage.setItem(
          `${storageKey}:${key}`,
          JSON.stringify(data),
        );
      } catch {
        // Storage quota exceeded or security error
      }
    },

    load(key: string): { activePublicKey: string | null; accounts: AccountData[] } | null {
      try {
        const raw = globalThis.localStorage.getItem(`${storageKey}:${key}`);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.accounts)) {
          return parsed;
        }
        return null;
      } catch {
        return null;
      }
    },

    clear(key: string): void {
      try {
        globalThis.localStorage.removeItem(`${storageKey}:${key}`);
      } catch {
        // Silently ignore
      }
    },
  };
}

export interface WalletAccountManagerConfig {
  /** Optional persistence storage adapter */
  storageAdapter?: AccountStorageAdapter;
  /** Storage key namespace (default: "default") */
  namespace?: string;
}

export class WalletAccountManager {
  private accounts = new Map<string, AccountData>();
  private activePublicKey: string | null = null;
  private listeners = new Set<AccountSwitchListener>();
  private storageAdapter: AccountStorageAdapter;
  private namespace: string;

  constructor(config?: WalletAccountManagerConfig) {
    this.namespace = config?.namespace ?? "default";
    this.storageAdapter =
      config?.storageAdapter ??
      createLocalStorageAccountStorage() ??
      new InMemoryAccountStorage();

    this.restoreFromStorage();
  }

  private restoreFromStorage(): void {
    const data = this.storageAdapter.load(this.namespace);
    if (data) {
      this.accounts.clear();
      for (const acc of data.accounts) {
        if (acc && typeof acc.publicKey === "string") {
          this.accounts.set(acc.publicKey, acc);
        }
      }
      this.activePublicKey =
        data.activePublicKey && this.accounts.has(data.activePublicKey)
          ? data.activePublicKey
          : this.accounts.keys().next().value ?? null;
    }
  }

  private persistToStorage(): void {
    const accounts = Array.from(this.accounts.values());
    this.storageAdapter.save(this.namespace, {
      activePublicKey: this.activePublicKey,
      accounts,
    });
  }

  private notifySwitch(
    activeAccount: AccountData | null,
    previousAccount: AccountData | null,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(activeAccount, previousAccount);
      } catch {
        // Prevent listener errors from breaking execution
      }
    }
  }

  /**
   * Register an account with optional label/network metadata.
   * If no active account is currently set, sets this account as active.
   */
  async addAccount(
    publicKey: string,
    metadata: AccountMetadata = {},
  ): Promise<SorokitResult<AccountData>> {
    if (!publicKey || typeof publicKey !== "string" || !isValidPublicKey(publicKey.trim())) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        "Invalid Stellar public key format.",
      );
    }

    const key = publicKey.trim();
    const previousActive = this.getActiveAccountData();

    const existing = this.accounts.get(key);
    const accountData: AccountData = {
      publicKey: key,
      metadata: { ...(existing?.metadata ?? {}), ...metadata },
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };

    this.accounts.set(key, accountData);

    let switched = false;
    if (this.activePublicKey === null) {
      this.activePublicKey = key;
      switched = true;
    }

    this.persistToStorage();

    if (switched) {
      this.notifySwitch(accountData, previousActive);
    }

    return ok(accountData);
  }

  /**
   * Unregister an account by public key.
   * If the removed account was active, updates active account and notifies listeners.
   */
  async removeAccount(publicKey: string): Promise<SorokitResult<boolean>> {
    const key = publicKey.trim();
    if (!this.accounts.has(key)) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Account ${key} is not registered in the account manager.`,
      );
    }

    const previousActive = this.getActiveAccountData();
    const wasActive = this.activePublicKey === key;

    this.accounts.delete(key);

    if (wasActive) {
      this.activePublicKey = this.accounts.keys().next().value ?? null;
      const nextActive = this.getActiveAccountData();
      this.persistToStorage();
      this.notifySwitch(nextActive, previousActive);
    } else {
      this.persistToStorage();
    }

    return ok(true);
  }

  /**
   * Switch the active account to the given registered public key.
   * Emits real-time notifications to watchAccountSwitch listeners.
   */
  async switchAccount(publicKey: string): Promise<SorokitResult<AccountData>> {
    const key = publicKey.trim();
    const account = this.accounts.get(key);

    if (!account) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Account ${key} is not registered in the account manager.`,
      );
    }

    const previousActive = this.getActiveAccountData();
    if (this.activePublicKey !== key) {
      this.activePublicKey = key;
      this.persistToStorage();
      this.notifySwitch(account, previousActive);
    }

    return ok(account);
  }

  /**
   * Get the currently active account record, or null if none registered.
   */
  getActiveAccount(): SorokitResult<AccountData | null> {
    const active = this.getActiveAccountData();
    return ok(active);
  }

  private getActiveAccountData(): AccountData | null {
    if (this.activePublicKey === null) return null;
    return this.accounts.get(this.activePublicKey) ?? null;
  }

  /**
   * List all registered accounts with metadata.
   */
  async listAccounts(): Promise<SorokitResult<AccountData[]>> {
    return ok(Array.from(this.accounts.values()));
  }

  /**
   * Subscribe to real-time account switch notifications.
   * Returns an unsubscribe callback.
   */
  watchAccountSwitch(listener: AccountSwitchListener): AccountSwitchUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear all registered accounts and active state.
   */
  async clearAll(): Promise<SorokitResult<void>> {
    const previousActive = this.getActiveAccountData();
    this.accounts.clear();
    this.activePublicKey = null;
    this.storageAdapter.clear(this.namespace);
    if (previousActive !== null) {
      this.notifySwitch(null, previousActive);
    }
    return ok(undefined);
  }
}

/** Create a standalone WalletAccountManager instance */
export function createAccountManager(
  config?: WalletAccountManagerConfig,
): WalletAccountManager {
  return new WalletAccountManager(config);
}
