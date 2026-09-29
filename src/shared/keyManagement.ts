import { mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import {
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";

export interface DerivedStellarKey {
  publicKey: string;
  /** Keep this value in a secure signer or user-controlled secret store. */
  secretKey: string;
  path: string;
}

export interface RotateSecretKeyOptions {
  account: Account;
  /** Public key of the existing non-master signer to remove. */
  oldPublicKey: string;
  /** Public key of the replacement signer. */
  newPublicKey: string;
  networkPassphrase: string;
  baseFee?: string;
  timeoutSeconds?: number;
  weight?: number;
}

function asBytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function asBufferSource(value: Uint8Array): BufferSource {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", asBufferSource(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  return asBytes(await crypto.subtle.sign("HMAC", cryptoKey, asBufferSource(data)));
}

function parseHardenedPath(path: string): number[] | null {
  if (!/^m(?:\/(?:0|[1-9]\d*)')+$/.test(path)) return null;
  const parts = path.split("/").slice(1);
  const indices = parts.map((part) => Number(part.slice(0, -1)));
  if (indices.some((index) => !Number.isSafeInteger(index) || index >= 0x80000000)) return null;
  return indices;
}

/**
 * Derive a Stellar Ed25519 key using SEP-5 (BIP-39 PBKDF2 + SLIP-0010),
 * which uses hardened BIP-44 paths such as `m/44'/148'/0'`.
 * The caller must supply a valid BIP-39 mnemonic and should not persist the
 * returned secret outside a secure signer or secret store.
 */
export async function deriveKey(
  mnemonic: string,
  path = "m/44'/148'/0'",
  passphrase = "",
): Promise<SorokitResult<DerivedStellarKey>> {
  const indices = parseHardenedPath(path);
  if (!indices || !validateMnemonic(mnemonic, englishWordlist)) {
    return err(SorokitErrorCode.VALIDATION, "A valid English BIP-39 mnemonic and hardened derivation path are required.");
  }
  try {
    const seed = await mnemonicToSeed(mnemonic, passphrase);
    const root = await hmacSha512(new TextEncoder().encode("ed25519 seed"), seed);
    let key = root.slice(0, 32);
    let chainCode = root.slice(32);
    for (const index of indices) {
      const data = new Uint8Array(37);
      data[0] = 0;
      data.set(key, 1);
      new DataView(data.buffer).setUint32(33, index + 0x80000000, false);
      const child = await hmacSha512(chainCode, data);
      key = child.slice(0, 32);
      chainCode = child.slice(32);
    }
    const keypair = Keypair.fromRawEd25519Seed(key as unknown as Parameters<typeof Keypair.fromRawEd25519Seed>[0]);
    return ok({ publicKey: keypair.publicKey(), secretKey: keypair.secret(), path });
  } catch (cause) {
    return err(SorokitErrorCode.INTERNAL, "Stellar key derivation failed.", cause);
  }
}

/** Validate a Stellar secret seed without returning or retaining key material. */
export function validateSecretKey(secretKey: string): SorokitResult<{ publicKey: string }> {
  try {
    if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
      return err(SorokitErrorCode.VALIDATION, "Secret key is not a valid Stellar ed25519 secret seed.");
    }
    const keypair = Keypair.fromSecret(secretKey);
    return ok({ publicKey: keypair.publicKey() });
  } catch (cause) {
    return err(SorokitErrorCode.VALIDATION, "Secret key is invalid.", cause);
  }
}

/**
 * Build (but do not sign or submit) a transaction that replaces one account
 * signer. This cannot rotate an account's master key; the source account must
 * have sufficient threshold weight from other signers to authorize the change.
 */
export function rotateSecretKey(
  options: RotateSecretKeyOptions,
): SorokitResult<Transaction> {
  if (options.oldPublicKey === options.newPublicKey) {
    return err(SorokitErrorCode.VALIDATION, "Old and new signer keys must differ.");
  }
  if (options.oldPublicKey === options.account.accountId()) {
    return err(SorokitErrorCode.VALIDATION, "The account master key cannot be rotated as a signer; use a separate signer key.");
  }
  const oldKey = StrKey.isValidEd25519PublicKey(options.oldPublicKey);
  const newKey = StrKey.isValidEd25519PublicKey(options.newPublicKey);
  if (!oldKey || !newKey || !options.networkPassphrase) {
    return err(SorokitErrorCode.VALIDATION, "Valid public signer keys and a network passphrase are required.");
  }
  const weight = options.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1 || weight > 255) {
    return err(SorokitErrorCode.VALIDATION, "New signer weight must be an integer from 1 to 255.");
  }
  try {
    const transaction = new TransactionBuilder(options.account, {
      fee: options.baseFee ?? "100",
      networkPassphrase: options.networkPassphrase,
    })
      .addOperation(Operation.setOptions({
        signer: { ed25519PublicKey: options.newPublicKey, weight },
      }))
      .addOperation(Operation.setOptions({
        signer: { ed25519PublicKey: options.oldPublicKey, weight: 0 },
      }))
      .setTimeout(options.timeoutSeconds ?? 180)
      .build();
    return ok(transaction);
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Failed to build signer rotation transaction.", cause);
  }
}
