/**
 * Wallet Session Persistence and Auto-Recovery (#671)
 *
 * Persists wallet sessions locally with encryption and TTL enforcement.
 * Enables auto-recovery on page reload without re-authentication.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletType } from "./types";

export interface WalletState {
  accountId: string;
  connectedAt: number;
  expiresAt: number;
  network: string;
}

export interface SessionData {
  publicKey: string;
  walletType?: WalletType | string;
  network?: string;
  connectedAt: number;
  expiresAt: number;
  metadata?: Record<string, unknown>;
}

export interface WalletConnection {
  publicKey: string;
  walletType?: WalletType | string;
  network?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionPersistenceOptions {
  ttlMs?: number;
  encryptionKey?: string;
  storage?: Storage;
  storageKey?: string;
}

export interface EncryptedSessionPayload {
  __sorokit_encrypted: true;
  version: 1;
  iv: string;
  ciphertext: string;
  expiresAt: number;
}

export const DEFAULT_SESSION_KEY = "sorokit_wallet_session";
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_ENCRYPTION_SECRET = "sorokit_session_encryption_secret_v1";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSessionPayload(
  plaintext: string,
  secret: string,
  expiresAt: number,
): Promise<EncryptedSessionPayload> {
  if (typeof crypto !== "undefined" && crypto.subtle && crypto.getRandomValues) {
    const key = await deriveAesKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const encryptedBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded,
    );
    return {
      __sorokit_encrypted: true,
      version: 1,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encryptedBuf)),
      expiresAt,
    };
  }

  // Fallback cipher for environments without WebCrypto
  const enc = new TextEncoder();
  const bytes = enc.encode(plaintext);
  const secretBytes = enc.encode(secret);
  const xorBytes = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    xorBytes[i] = bytes[i]! ^ (secretBytes[i % secretBytes.length] ?? 0);
  }
  return {
    __sorokit_encrypted: true,
    version: 1,
    iv: "fallback",
    ciphertext: bytesToBase64(xorBytes),
    expiresAt,
  };
}

export async function decryptSessionPayload(
  payload: EncryptedSessionPayload,
  secret: string,
): Promise<string> {
  if (payload.iv !== "fallback" && typeof crypto !== "undefined" && crypto.subtle) {
    const key = await deriveAesKey(secret);
    const iv = base64ToBytes(payload.iv);
    const ciphertext = base64ToBytes(payload.ciphertext);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      key,
      ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
    );
    return new TextDecoder().decode(decryptedBuf);
  }

  const xorBytes = base64ToBytes(payload.ciphertext);
  const enc = new TextEncoder();
  const secretBytes = enc.encode(secret);
  const plainBytes = new Uint8Array(xorBytes.length);
  for (let i = 0; i < xorBytes.length; i++) {
    plainBytes[i] = xorBytes[i]! ^ (secretBytes[i % secretBytes.length] ?? 0);
  }
  return new TextDecoder().decode(plainBytes);
}

function resolveStorage(options?: SessionPersistenceOptions): Storage | null {
  if (options?.storage) return options.storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis !== "undefined" && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage: Storage }).localStorage;
  }
  return null;
}

/**
 * Check whether a session is valid and not expired.
 */
export function isSessionValid(session: SessionData | null | undefined): boolean {
  if (!session || typeof session !== "object") return false;
  if (!session.publicKey || typeof session.publicKey !== "string") return false;
  if (typeof session.expiresAt !== "number") return false;
  return Date.now() < session.expiresAt;
}

/**
 * Persist wallet connection session to local storage with encryption and TTL.
 */
export async function saveSession(
  connection: WalletConnection,
  options?: SessionPersistenceOptions,
): Promise<SorokitResult<SessionData>> {
  try {
    if (!connection || !connection.publicKey) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "Cannot persist session without a valid publicKey",
      );
    }

    const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const now = Date.now();
    const sessionData: SessionData = {
      publicKey: connection.publicKey,
      ...(connection.walletType ? { walletType: connection.walletType } : {}),
      ...(connection.network ? { network: connection.network } : {}),
      connectedAt: now,
      expiresAt: now + ttlMs,
      ...(connection.metadata ? { metadata: connection.metadata } : {}),
    };

    const storage = resolveStorage(options);
    if (!storage) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "No storage mechanism available for session persistence",
      );
    }

    const storageKey = options?.storageKey ?? DEFAULT_SESSION_KEY;
    const secret = options?.encryptionKey ?? DEFAULT_ENCRYPTION_SECRET;
    const encrypted = await encryptSessionPayload(
      JSON.stringify(sessionData),
      secret,
      sessionData.expiresAt,
    );

    storage.setItem(storageKey, JSON.stringify(encrypted));
    return ok(sessionData);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to persist wallet session",
      cause,
    );
  }
}

/**
 * Restore persisted wallet session from local storage, decrypting and checking TTL.
 */
export async function restoreSession(
  options?: SessionPersistenceOptions,
): Promise<SorokitResult<SessionData>> {
  try {
    const storage = resolveStorage(options);
    if (!storage) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "No storage mechanism available for session persistence",
      );
    }

    const storageKey = options?.storageKey ?? DEFAULT_SESSION_KEY;
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "No saved wallet session found in storage",
      );
    }

    const secret = options?.encryptionKey ?? DEFAULT_ENCRYPTION_SECRET;
    let sessionData: SessionData;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.__sorokit_encrypted) {
        const decryptedJson = await decryptSessionPayload(parsed, secret);
        sessionData = JSON.parse(decryptedJson) as SessionData;
      } else {
        // Fallback for unencrypted / legacy sessions
        sessionData = {
          publicKey: parsed.publicKey || parsed.accountId || "",
          walletType: parsed.walletType,
          network: parsed.network,
          connectedAt: parsed.connectedAt || Date.now(),
          expiresAt: parsed.expiresAt || 0,
          metadata: parsed.metadata,
        };
      }
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "Failed to decrypt or parse saved wallet session",
        cause,
      );
    }

    if (!isSessionValid(sessionData)) {
      clearSession(options);
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "Saved wallet session has expired",
      );
    }

    return ok(sessionData);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to restore wallet session",
      cause,
    );
  }
}

/**
 * Clear persisted wallet session from local storage (logout).
 */
export function clearSession(
  options?: Pick<SessionPersistenceOptions, "storage" | "storageKey">,
): SorokitResult<void> {
  try {
    const storage = resolveStorage(options as SessionPersistenceOptions);
    if (storage) {
      const storageKey = options?.storageKey ?? DEFAULT_SESSION_KEY;
      storage.removeItem(storageKey);
    }
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Failed to clear wallet session",
      cause,
    );
  }
}

// ─── Legacy compatibility functions (preserves existing tests) ───────────────

export function saveWalletSession(state: WalletState): SorokitResult<void> {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(DEFAULT_SESSION_KEY, JSON.stringify(state));
    }
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Unable to save wallet session",
      cause,
    );
  }
}

export function loadWalletSession(): SorokitResult<WalletState | null> {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(DEFAULT_SESSION_KEY);
      if (!raw) return ok(null);
      const state = JSON.parse(raw) as WalletState;
      if (Date.now() > state.expiresAt) {
        clearWalletSession();
        return ok(null);
      }
      return ok(state);
    }
    return ok(null);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Unable to load wallet session",
      cause,
    );
  }
}

export function clearWalletSession(): SorokitResult<void> {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(DEFAULT_SESSION_KEY);
    }
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_CONNECT_FAILED,
      cause instanceof Error ? cause.message : "Unable to clear wallet session",
      cause,
    );
  }
}
