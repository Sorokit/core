/**
 * Security Module
 *
 * Exports key management functionality for secure key generation,
 * BIP39 mnemonic derivation, encryption, and export.
 */

export {
  generateKeypair,
  generateMnemonic,
  deriveFromMnemonic,
  encryptKey,
  decryptKey,
  exportKey,
} from "./keyManagement";

export type {
  GeneratedKeypair,
  DerivedKey,
  EncryptedKey,
  KeyExportFormat,
  ExportedKey,
} from "./keyManagement";
