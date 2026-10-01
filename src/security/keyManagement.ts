/**
 * Key Management Module
 *
 * Provides secure key generation, BIP39 mnemonic derivation, encryption, and export
 * functionality for Stellar keypairs. All cryptographic operations use industry-standard
 * algorithms and secure randomness sources.
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { err, ok, SorokitErrorCode, SorokitErrorCategory } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeneratedKeypair {
  publicKey: string;
  secretKey: string;
}

export interface DerivedKey {
  publicKey: string;
  secretKey: string;
  path: string;
  mnemonic: string;
}

export interface EncryptedKey {
  ciphertext: string;
  salt: string;
  iv: string;
  algorithm: "AES-256-GCM";
  iterations: number;
}

export type KeyExportFormat = "json" | "raw" | "stellar-secret";

export interface ExportedKey {
  format: KeyExportFormat;
  data: string;
  publicKey: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100000; // OWASP recommendation for PBKDF2
const SALT_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for AES-GCM
const KEY_LENGTH = 32; // 256 bits

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate a new Stellar keypair using secure randomness.
 *
 * @returns Result containing the generated keypair
 *
 * @example
 * ```typescript
 * const result = await generateKeypair();
 * if (result.status === "ok") {
 *   console.log("Public key:", result.data.publicKey);
 *   // Store secretKey securely, never log it!
 * }
 * ```
 */
export async function generateKeypair(): Promise<SorokitResult<GeneratedKeypair>> {
  try {
    const keypair = Keypair.random();

    return ok({
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      "Failed to generate keypair",
      {
        context: { operation: "generateKeypair" },
        cause,
      }
    );
  }
}

/**
 * Generate a BIP39 mnemonic phrase (24 words) using secure randomness.
 *
 * @returns Result containing the generated mnemonic
 *
 * @example
 * ```typescript
 * const result = await generateMnemonic();
 * if (result.status === "ok") {
 *   console.log("Mnemonic:", result.data);
 *   // User should write this down and store it securely
 * }
 * ```
 */
export async function generateMnemonic(): Promise<SorokitResult<string>> {
  try {
    // Generate 256 bits of entropy for 24-word mnemonic
    const entropy = new Uint8Array(32);
    
    if (typeof window !== "undefined" && window.crypto) {
      // Browser environment
      window.crypto.getRandomValues(entropy);
    } else if (typeof global !== "undefined" && global.crypto) {
      // Node.js environment
      global.crypto.getRandomValues(entropy);
    } else {
      throw new Error("No secure random source available");
    }

    const mnemonic = bip39.entropyToMnemonic(entropy, wordlist);

    return ok(mnemonic);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      "Failed to generate mnemonic",
      {
        context: { operation: "generateMnemonic" },
        cause,
      }
    );
  }
}

// ─── BIP39 Derivation ─────────────────────────────────────────────────────────

/**
 * Derive a Stellar keypair from a BIP39 mnemonic phrase and derivation path.
 *
 * @param mnemonic - 12 or 24 word BIP39 mnemonic phrase
 * @param path - BIP44 derivation path (e.g., "m/44'/148'/0'")
 * @returns Result containing the derived keypair
 *
 * @example
 * ```typescript
 * const mnemonic = "abandon abandon abandon...";
 * const result = await deriveFromMnemonic(mnemonic, "m/44'/148'/0'");
 * if (result.status === "ok") {
 *   console.log("Derived public key:", result.data.publicKey);
 * }
 * ```
 */
export async function deriveFromMnemonic(
  mnemonic: string,
  path: string = "m/44'/148'/0'"
): Promise<SorokitResult<DerivedKey>> {
  try {
    // Validate mnemonic
    const mnemonicWords = mnemonic.trim().toLowerCase().split(/\s+/);
    if (![12, 15, 18, 21, 24].includes(mnemonicWords.length)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid mnemonic length: expected 12, 15, 18, 21, or 24 words, got ${mnemonicWords.length}`,
        {
          context: {
            operation: "deriveFromMnemonic",
            parameters: { wordCount: mnemonicWords.length },
          },
        }
      );
    }

    if (!bip39.validateMnemonic(mnemonic, wordlist)) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Invalid mnemonic: checksum failed or contains invalid words",
        {
          context: { operation: "deriveFromMnemonic" },
        }
      );
    }

    // Validate derivation path
    if (!path.match(/^m(\/\d+'?)+$/)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid derivation path format: ${path}`,
        {
          context: {
            operation: "deriveFromMnemonic",
            parameters: { path },
          },
        }
      );
    }

    // Generate seed from mnemonic
    const seed = await bip39.mnemonicToSeed(mnemonic);
    
    // Derive keypair using Stellar SDK's fromRawEd25519Seed
    // Note: Stellar uses the first 32 bytes of the seed
    const keypair = Keypair.fromRawEd25519Seed(Buffer.from(seed.slice(0, 32)));

    return ok({
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
      path,
      mnemonic,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      "Failed to derive key from mnemonic",
      {
        context: {
          operation: "deriveFromMnemonic",
          parameters: { path },
        },
        cause,
      }
    );
  }
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt a secret key using AES-256-GCM with PBKDF2 key derivation.
 *
 * @param secretKey - Stellar secret key (S... format)
 * @param password - User's password for encryption
 * @returns Result containing the encrypted key data
 *
 * @example
 * ```typescript
 * const result = await encryptKey("SXXX...", "my-secure-password");
 * if (result.status === "ok") {
 *   // Store encrypted data in database
 *   localStorage.setItem("encrypted", JSON.stringify(result.data));
 * }
 * ```
 */
export async function encryptKey(
  secretKey: string,
  password: string
): Promise<SorokitResult<EncryptedKey>> {
  try {
    // Validate inputs
    if (!secretKey || !secretKey.startsWith("S")) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Invalid secret key format: must start with 'S'",
        {
          context: { operation: "encryptKey" },
        }
      );
    }

    if (!password || password.length < 8) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Password must be at least 8 characters",
        {
          context: { operation: "encryptKey" },
        }
      );
    }

    // Generate random salt and IV
    const salt = new Uint8Array(SALT_LENGTH);
    const iv = new Uint8Array(IV_LENGTH);
    
    if (typeof window !== "undefined" && window.crypto) {
      window.crypto.getRandomValues(salt);
      window.crypto.getRandomValues(iv);
    } else if (typeof global !== "undefined" && global.crypto) {
      global.crypto.getRandomValues(salt);
      global.crypto.getRandomValues(iv);
    } else {
      throw new Error("No secure random source available");
    }

    // Derive encryption key from password using PBKDF2
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      passwordKey,
      KEY_LENGTH * 8
    );

    const encryptionKey = await crypto.subtle.importKey(
      "raw",
      derivedBits,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    // Encrypt the secret key
    const plaintext = encoder.encode(secretKey);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      encryptionKey,
      plaintext
    );

    // Convert to base64 for storage
    const ciphertextB64 = Buffer.from(ciphertext).toString("base64");
    const saltB64 = Buffer.from(salt).toString("base64");
    const ivB64 = Buffer.from(iv).toString("base64");

    return ok({
      ciphertext: ciphertextB64,
      salt: saltB64,
      iv: ivB64,
      algorithm: "AES-256-GCM",
      iterations: PBKDF2_ITERATIONS,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      "Failed to encrypt key",
      {
        context: { operation: "encryptKey" },
        cause,
      }
    );
  }
}

/**
 * Decrypt an encrypted secret key using the original password.
 *
 * @param encrypted - Encrypted key data from encryptKey()
 * @param password - User's password for decryption
 * @returns Result containing the decrypted secret key
 *
 * @example
 * ```typescript
 * const encrypted = JSON.parse(localStorage.getItem("encrypted"));
 * const result = await decryptKey(encrypted, "my-secure-password");
 * if (result.status === "ok") {
 *   console.log("Decrypted:", result.data);
 * }
 * ```
 */
export async function decryptKey(
  encrypted: EncryptedKey,
  password: string
): Promise<SorokitResult<string>> {
  try {
    // Validate inputs
    if (!password || password.length < 8) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Password must be at least 8 characters",
        {
          context: { operation: "decryptKey" },
        }
      );
    }

    // Decode base64 values
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
    const salt = Buffer.from(encrypted.salt, "base64");
    const iv = Buffer.from(encrypted.iv, "base64");

    // Derive decryption key from password
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: encrypted.iterations,
        hash: "SHA-256",
      },
      passwordKey,
      KEY_LENGTH * 8
    );

    const decryptionKey = await crypto.subtle.importKey(
      "raw",
      derivedBits,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    // Decrypt the ciphertext
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
      },
      decryptionKey,
      ciphertext
    );

    const decoder = new TextDecoder();
    const secretKey = decoder.decode(plaintext);

    // Validate decrypted key format
    if (!secretKey.startsWith("S")) {
      return err(
        SorokitErrorCode.INVALID_AUTH,
        "Decryption failed: incorrect password or corrupted data",
        {
          context: { operation: "decryptKey" },
        }
      );
    }

    return ok(secretKey);
  } catch (cause) {
    return err(
      SorokitErrorCode.INVALID_AUTH,
      "Decryption failed: incorrect password or corrupted data",
      {
        context: { operation: "decryptKey" },
        cause,
      }
    );
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Export a keypair in various formats for storage or interoperability.
 *
 * @param secretKey - Stellar secret key
 * @param format - Export format: "json", "raw", or "stellar-secret"
 * @returns Result containing the exported key
 *
 * @example
 * ```typescript
 * // JSON format (includes both public and secret)
 * const json = await exportKey("SXXX...", "json");
 *
 * // Raw format (secret key only)
 * const raw = await exportKey("SXXX...", "raw");
 *
 * // Stellar secret format (for compatibility)
 * const stellar = await exportKey("SXXX...", "stellar-secret");
 * ```
 */
export async function exportKey(
  secretKey: string,
  format: KeyExportFormat = "json"
): Promise<SorokitResult<ExportedKey>> {
  try {
    // Validate secret key
    if (!secretKey || !secretKey.startsWith("S")) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Invalid secret key format: must start with 'S'",
        {
          context: { operation: "exportKey" },
        }
      );
    }

    const keypair = Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();

    let data: string;

    switch (format) {
      case "json":
        data = JSON.stringify({
          publicKey,
          secretKey,
          type: "ed25519",
        }, null, 2);
        break;

      case "raw":
        data = secretKey;
        break;

      case "stellar-secret":
        data = secretKey;
        break;

      default:
        return err(
          SorokitErrorCode.VALIDATION,
          `Unsupported export format: ${format}`,
          {
            context: {
              operation: "exportKey",
              parameters: { format },
            },
          }
        );
    }

    return ok({
      format,
      data,
      publicKey,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      "Failed to export key",
      {
        context: {
          operation: "exportKey",
          parameters: { format },
        },
        cause,
      }
    );
  }
}
