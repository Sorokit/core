/**
 * In-memory authentication storage implementation.
 *
 * Provides secure storage for authentication credentials and session state.
 * For production use, applications should implement persistent storage.
 */

import { ok } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import type {
  AuthenticationStorage,
  AuthenticationCredential,
  AuthenticationStatus,
} from "./types";

/**
 * In-memory authentication storage.
 *
 * Stores credentials and sessions in memory only - data is lost on reload.
 * Applications should implement a persistent storage adapter for production use.
 *
 * @example
 * const storage = new InMemoryAuthenticationStorage();
 * await storage.storeCredential("wallet-123", credential);
 */
export class InMemoryAuthenticationStorage implements AuthenticationStorage {
  private credentials = new Map<string, AuthenticationCredential>();
  private sessions = new Map<string, AuthenticationStatus>();

  async storeCredential(
    walletId: string,
    credential: AuthenticationCredential
  ): Promise<SorokitResult<void>> {
    this.credentials.set(walletId, credential);
    return ok(undefined);
  }

  async getCredential(
    walletId: string
  ): Promise<SorokitResult<AuthenticationCredential | null>> {
    const credential = this.credentials.get(walletId) ?? null;
    return ok(credential);
  }

  async removeCredential(walletId: string): Promise<SorokitResult<void>> {
    this.credentials.delete(walletId);
    return ok(undefined);
  }

  async storeSession(
    walletId: string,
    status: AuthenticationStatus
  ): Promise<SorokitResult<void>> {
    this.sessions.set(walletId, status);
    return ok(undefined);
  }

  async getSession(
    walletId: string
  ): Promise<SorokitResult<AuthenticationStatus | null>> {
    const status = this.sessions.get(walletId) ?? null;
    return ok(status);
  }

  async clearSession(walletId: string): Promise<SorokitResult<void>> {
    this.sessions.delete(walletId);
    return ok(undefined);
  }

  /**
   * Clear all stored data (for testing).
   */
  clear(): void {
    this.credentials.clear();
    this.sessions.clear();
  }
}

/**
 * Create a localStorage-based authentication storage adapter.
 *
 * Persists credentials and sessions in browser localStorage.
 * Falls back to in-memory storage if localStorage is unavailable.
 *
 * @returns Storage adapter instance
 *
 * @example
 * const storage = createLocalStorageAuthenticationStorage();
 * await storage.storeCredential("wallet-123", credential);
 */
export function createLocalStorageAuthenticationStorage(): AuthenticationStorage {
  // Check if localStorage is available
  const hasLocalStorage =
    typeof window !== "undefined" &&
    typeof window.localStorage !== "undefined";

  if (!hasLocalStorage) {
    // Fallback to in-memory storage
    return new InMemoryAuthenticationStorage();
  }

  return {
    async storeCredential(walletId, credential) {
      try {
        const key = `sorokit:auth:credential:${walletId}`;
        localStorage.setItem(key, JSON.stringify(credential));
        return ok(undefined);
      } catch {
        return ok(undefined);
      }
    },

    async getCredential(walletId) {
      try {
        const key = `sorokit:auth:credential:${walletId}`;
        const data = localStorage.getItem(key);
        if (!data) return ok(null);
        const credential = JSON.parse(data) as AuthenticationCredential;
        return ok(credential);
      } catch {
        return ok(null);
      }
    },

    async removeCredential(walletId) {
      try {
        const key = `sorokit:auth:credential:${walletId}`;
        localStorage.removeItem(key);
        return ok(undefined);
      } catch {
        return ok(undefined);
      }
    },

    async storeSession(walletId, status) {
      try {
        const key = `sorokit:auth:session:${walletId}`;
        localStorage.setItem(key, JSON.stringify(status));
        return ok(undefined);
      } catch {
        return ok(undefined);
      }
    },

    async getSession(walletId) {
      try {
        const key = `sorokit:auth:session:${walletId}`;
        const data = localStorage.getItem(key);
        if (!data) return ok(null);
        const status = JSON.parse(data) as AuthenticationStatus;
        return ok(status);
      } catch {
        return ok(null);
      }
    },

    async clearSession(walletId) {
      try {
        const key = `sorokit:auth:session:${walletId}`;
        localStorage.removeItem(key);
        return ok(undefined);
      } catch {
        return ok(undefined);
      }
    },
  };
}
