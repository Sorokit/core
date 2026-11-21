/**
 * Centralized input validation for sorokit-core.
 *
 * Every function in this module returns a SorokitResult<T> and never throws —
 * callers can safely invoke them without a try/catch block.
 *
 * These are pure format/shape validators. Business-rule validation (e.g.
 * "this account must already exist on-chain" or "must have 2+ signers") is
 * intentionally out of scope and left to higher-level callers.
 *
 * Each error message names the exact problem and, where applicable, how to fix
 * it — following the same actionable-message pattern used in validateDeployConfig.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";

// ─── Network passphrases ──────────────────────────────────────────────────────

/**
 * The official Stellar mainnet network passphrase.
 * Source: https://developers.stellar.org/docs/learn/glossary#network-passphrase
 */
export const STELLAR_MAINNET_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

/**
 * The official Stellar testnet network passphrase.
 * Source: https://developers.stellar.org/docs/learn/glossary#network-passphrase
 */
export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of decimal places Stellar amounts support.
 * Stellar uses 7 decimal places (1 stroop = 0.0000001 XLM).
 */
export const STELLAR_MAX_DECIMAL_PLACES = 7;

/**
 * Maximum amount representable in Stellar, derived from:
 *   MAX_INT64 (9223372036854775807 stroops) / ONE (10000000 stroops per XLM)
 *
 * This matches the value enforced by @stellar/stellar-base's Operation.isValidAmount().
 * Source: stellar-base/lib/operation.js — MAX_INT64 = '9223372036854775807', ONE = 10000000
 */
export const STELLAR_MAX_AMOUNT = "922337203685.4775807";

/**
 * Maximum length of a Stellar asset code.
 */
export const STELLAR_MAX_ASSET_CODE_LENGTH = 12;

/**
 * Minimum length of a Stellar asset code.
 */
export const STELLAR_MIN_ASSET_CODE_LENGTH = 1;

/** Standard length of an Ed25519 G-address StrKey. */
export const STELLAR_ED25519_PUBLIC_KEY_LENGTH = 56;

/** Standard length of a Muxed M-address StrKey. */
export const STELLAR_MUXED_PUBLIC_KEY_LENGTH = 69;

const BASE32_REGEX = /^[A-Z2-7]+$/;
const FEDERATION_ADDRESS_REGEX = /^[^*\s<>@]+\*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Supported public key / account identifier formats on Stellar (#926). */
export type PublicKeyFormat = "ed25519" | "muxed" | "federation";

/** Options for public key validation (#926). */
export interface ValidatePublicKeyOptions {
  /** Allow M-prefixed 69-character muxed account addresses. Default: false. */
  allowMuxed?: boolean;
  /** Allow name*domain.tld federation addresses. Default: false. */
  allowFederation?: boolean;
}

/** Detailed validation result including detected format and checksum status (#926). */
export interface PublicKeyValidationDetails {
  key: string;
  format: PublicKeyFormat;
  checksumValid: boolean;
}

/**
 * Detect the format of a Stellar public key or account identifier (#926).
 *
 * Recognizes:
 * - `"ed25519"` for G-prefixed Ed25519 public keys
 * - `"muxed"` for M-prefixed Med25519 muxed account keys
 * - `"federation"` for `name*domain.tld` federation addresses
 * - `"unknown"` for anything else
 */
export function detectPublicKeyFormat(key: string): PublicKeyFormat | "unknown" {
  if (typeof key !== "string" || key.length === 0) {
    return "unknown";
  }
  if (key.includes("*")) {
    return FEDERATION_ADDRESS_REGEX.test(key) ? "federation" : "unknown";
  }
  if (key.startsWith("G")) {
    return "ed25519";
  }
  if (key.startsWith("M")) {
    return "muxed";
  }
  return "unknown";
}

/**
 * Verify the StrKey CRC16-XModem checksum for an Ed25519 (G...) or Muxed (M...) public key (#926).
 */
export function verifyPublicKeyChecksum(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) {
    return false;
  }
  try {
    if (key.startsWith("G")) {
      return StrKey.isValidEd25519PublicKey(key);
    }
    if (key.startsWith("M")) {
      return StrKey.isValidMed25519PublicKey(key);
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Validators ───────────────────────────────────────────────────────────────

/**
 * Validate a Stellar address.
 *
 * Performs two checks:
 * 1. Prefix — must start with "G" (standard Ed25519 public key prefix).
 * 2. StrKey checksum — uses the stellar-sdk StrKey utility (the same library
 *    the rest of the codebase already depends on) for cryptographic validation.
 *
 * Use this for general Stellar G-address validation. If you specifically need
 * to assert an Ed25519 public key (e.g. for signing), use validatePublicKey
 * instead.
 *
 * @param addr - The Stellar address string to validate.
 * @returns ok(addr) when valid, err(INVALID_ADDRESS) with an actionable message otherwise.
 */
export function validateStellarAddress(addr: string): SorokitResult<string> {
  if (typeof addr !== "string" || addr.length === 0) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `address — address is empty or not a string. Fix: Provide a 56-character G-prefixed Stellar public key (e.g. "GABC...XYZ").`,
    );
  }

  if (!addr.startsWith("G")) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `address — "${addr}" does not start with "G". Fix: Stellar public keys must begin with the letter G. Check that you have not supplied a secret key (S...) or contract ID (C...) by mistake.`,
    );
  }

  if (!StrKey.isValidEd25519PublicKey(addr)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `address — "${addr}" is not a valid Stellar address. Fix: Ensure the address is a 56-character Base32 string starting with G and contains no typos. Use Keypair.random().publicKey() to generate a valid example.`,
    );
  }

  return ok(addr);
}

/**
 * Validate a Stellar public key with checksum verification and format detection (#926).
 *
 * By default, validates standard 56-character G-prefixed Ed25519 public keys and
 * verifies the StrKey CRC16 checksum with specific error diagnostics for wrong
 * prefix, invalid length, non-Base32 characters, or corrupted checksum.
 *
 * When `options.allowMuxed` or `options.allowFederation` is enabled, also accepts
 * M-prefixed 69-character muxed addresses or `name*domain.tld` federation addresses.
 *
 * @param key - The public key string to validate.
 * @param options - Optional flags to allow muxed or federation formats.
 * @returns ok(key) when valid, err(INVALID_ADDRESS) with an actionable message otherwise.
 */
export function validatePublicKey(
  key: string,
  options?: ValidatePublicKeyOptions,
): SorokitResult<string> {
  if (typeof key !== "string" || key.length === 0) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — public key is empty or not a string. Fix: Provide a 56-character G-prefixed Ed25519 public key (e.g. "GABC...XYZ").`,
    );
  }

  if (options?.allowFederation && key.includes("*")) {
    if (!FEDERATION_ADDRESS_REGEX.test(key)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — "${key}" is not a valid federation address. Fix: Use the format "name*domain.com" with a valid domain name and no spaces.`,
      );
    }
    return ok(key);
  }

  if (options?.allowMuxed && key.startsWith("M")) {
    if (key.length !== STELLAR_MUXED_PUBLIC_KEY_LENGTH) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — muxed key "${key}" has length ${key.length}, expected ${STELLAR_MUXED_PUBLIC_KEY_LENGTH}. Fix: Provide a full 69-character M-prefixed muxed Stellar address.`,
      );
    }
    if (!BASE32_REGEX.test(key)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — muxed key "${key}" contains invalid Base32 characters. Fix: Use only uppercase A–Z and digits 2–7.`,
      );
    }
    if (!verifyPublicKeyChecksum(key)) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — muxed key "${key}" failed StrKey CRC16 checksum verification. Fix: Check the M-address for typos or bit corruption.`,
      );
    }
    return ok(key);
  }

  if (!key.startsWith("G")) {
    if (key.startsWith("M")) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — "${key}" is a muxed M-address, not a G-prefixed Ed25519 key. Fix: Pass { allowMuxed: true } or extract the underlying G-prefixed Ed25519 public key.`,
      );
    }
    if (key.includes("*")) {
      return err(
        SorokitErrorCode.INVALID_ADDRESS,
        `publicKey — "${key}" appears to be a federation address, not a G-prefixed Ed25519 key. Fix: Resolve the federation address to a G-address first or pass { allowFederation: true }.`,
      );
    }
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — "${key}" does not start with "G". Fix: Ed25519 public keys on Stellar always begin with G. You may have provided a secret key (S...) or contract address (C...) by mistake.`,
    );
  }

  if (key.length !== STELLAR_ED25519_PUBLIC_KEY_LENGTH) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — "${key}" has invalid length ${key.length} (expected ${STELLAR_ED25519_PUBLIC_KEY_LENGTH}). Fix: Ensure the Ed25519 public key is exactly 56 characters long and starts with G.`,
    );
  }

  if (!BASE32_REGEX.test(key)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — "${key}" contains invalid Base32 characters. Fix: Stellar public keys only use uppercase letters A–Z and digits 2–7.`,
    );
  }

  if (!verifyPublicKeyChecksum(key)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — "${key}" failed StrKey CRC16 checksum verification. Fix: Ensure the key is a valid 56-character Base32 Ed25519 public key starting with G and contains no typos.`,
    );
  }

  return ok(key);
}

/**
 * Validate a Stellar public key or address across all supported formats
 * (`ed25519` G-address, `muxed` M-address, and `federation` address) and
 * return the detected format and checksum verification details (#926).
 */
export function validatePublicKeyDetailed(
  key: string,
  options: ValidatePublicKeyOptions = { allowMuxed: true, allowFederation: true },
): SorokitResult<PublicKeyValidationDetails> {
  const validation = validatePublicKey(key, options);
  if (validation.status === "error") {
    return validation;
  }

  const format = detectPublicKeyFormat(key);
  if (format === "unknown") {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `publicKey — "${key}" has an unrecognized public key format. Fix: Provide a valid G-address, M-address, or federation address.`,
    );
  }

  return ok({
    key,
    format,
    checksumValid: format === "federation" ? true : verifyPublicKeyChecksum(key),
  });
}

/**
 * Validate a Stellar asset code.
 *
 * Rules enforced (matches Stellar protocol limits):
 * - Must be 1–12 characters long.
 * - Must contain only alphanumeric characters (A–Z, a–z, 0–9).
 *
 * @param code - The asset code string to validate (e.g. "USDC", "XLM", "MYTOKEN12").
 * @returns ok(code) when valid, err(VALIDATION) with an actionable message otherwise.
 */
export function validateAssetCode(code: string): SorokitResult<string> {
  if (typeof code !== "string" || code.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `assetCode — asset code is empty or not a string. Fix: Provide a 1–12 character alphanumeric asset code (e.g. "USDC", "XLM").`,
    );
  }

  if (code.length > STELLAR_MAX_ASSET_CODE_LENGTH) {
    return err(
      SorokitErrorCode.VALIDATION,
      `assetCode — "${code}" is ${code.length} characters, which exceeds the maximum of ${STELLAR_MAX_ASSET_CODE_LENGTH}. Fix: Shorten the asset code to 12 characters or fewer.`,
    );
  }

  if (!/^[A-Za-z0-9]+$/.test(code)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `assetCode — "${code}" contains non-alphanumeric characters. Fix: Asset codes may only contain letters (A–Z, a–z) and digits (0–9). Remove spaces, hyphens, underscores, and any other symbols.`,
    );
  }

  return ok(code);
}

/**
 * Validate a Stellar asset issuer address.
 *
 * Delegates to validateStellarAddress — issuers are standard G-prefixed
 * Stellar public keys. Keeping this as a separate export makes call sites
 * self-documenting and allows issuer-specific error messages.
 *
 * @param issuer - The issuer address string to validate.
 * @returns ok(issuer) when valid, err(INVALID_ADDRESS) with an actionable message otherwise.
 */
export function validateAssetIssuer(issuer: string): SorokitResult<string> {
  if (typeof issuer !== "string" || issuer.length === 0) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `assetIssuer — issuer address is empty or not a string. Fix: Provide the G-prefixed Stellar public key of the asset issuer account.`,
    );
  }

  // Delegate to validateStellarAddress for the core format/checksum check,
  // but rephrase the error to be issuer-specific.
  const result = validateStellarAddress(issuer);
  if (result.status === "error") {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `assetIssuer — "${issuer}" is not a valid issuer address. Fix: The asset issuer must be a valid 56-character G-prefixed Stellar public key. ${result.error.message.split(". Fix: ")[1] ?? ""}`.trimEnd(),
    );
  }

  return ok(issuer);
}

/**
 * Validate a Stellar transaction amount.
 *
 * Rules enforced (match the Stellar protocol and @stellar/stellar-base):
 * - Must be a finite positive number (zero and negative values are rejected).
 * - Must not exceed 7 decimal places (1 stroop = 0.0000001 XLM).
 * - Must not exceed the Stellar network's maximum representable amount:
 *   922337203685.4775807 XLM (derived from MAX_INT64 / ONE in stellar-base).
 *
 * Accepts both string and number inputs to be compatible with existing call
 * sites that use either type.
 *
 * @param amt - The amount to validate. Either a numeric string like "10.5" or a number.
 * @returns ok(string) — the amount as a normalised string — when valid, or err(VALIDATION).
 */
export function validateAmount(amt: string | number): SorokitResult<string> {
  // Normalise to string for uniform processing
  const raw = typeof amt === "number" ? String(amt) : amt;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — amount is empty or not a valid value. Fix: Provide a positive numeric string, e.g. "10" or "0.5".`,
    );
  }

  const trimmed = raw.trim();

  // Must be a valid finite decimal number
  // Accepts: "1", "1.5", "0.0000001" — rejects: "abc", "1e5", "Infinity", "NaN"
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" is not a valid amount format. Fix: Provide a plain decimal number string without exponent notation (e.g. "10", "0.5", "100.25").`,
    );
  }

  if (trimmed.startsWith("-") || /^0(?:\.0*)?$/.test(trimmed)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" must be greater than zero. Fix: Use a positive amount. Zero and negative values are not valid Stellar payment amounts.`,
    );
  }

  // Check decimal precision (max 7 places = 1 stroop)
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex !== -1) {
    const decimals = trimmed.length - dotIndex - 1;
    if (decimals > STELLAR_MAX_DECIMAL_PLACES) {
      return err(
        SorokitErrorCode.VALIDATION,
        `amount — "${trimmed}" has ${decimals} decimal places, which exceeds the maximum of ${STELLAR_MAX_DECIMAL_PLACES}. Fix: Round or truncate to at most 7 decimal places (1 stroop = 0.0000001 XLM).`,
      );
    }
  }

  // Check maximum supply bound.
  // Compare using BigInt arithmetic to avoid floating-point precision loss.
  // Both operands are normalised to 7-decimal fixed-point integers (stroops).
  const ONE = 10_000_000n; // stroops per XLM
  const MAX_INT64 = 9_223_372_036_854_775_807n; // MAX_INT64 in stroops

  const [wholePart = "0", fracPart = ""] = trimmed.split(".");
  const paddedFrac = fracPart.padEnd(STELLAR_MAX_DECIMAL_PLACES, "0").slice(0, STELLAR_MAX_DECIMAL_PLACES);
  const stroops = BigInt(wholePart) * ONE + BigInt(paddedFrac);

  if (stroops > MAX_INT64) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amount — "${trimmed}" exceeds the Stellar network maximum of ${STELLAR_MAX_AMOUNT} XLM. Fix: Use an amount at or below ${STELLAR_MAX_AMOUNT}.`,
    );
  }

  return ok(trimmed);
}

/**
 * Validate that a numeric amount string does not exceed a given decimal precision.
 *
 * Useful for per-asset enforcement where different assets may allow fewer than
 * the Stellar maximum. The function only checks precision; it does not check
 * sign, range, or whether the value is a valid payment amount — use
 * `validateAmount` for the full set of business rules.
 *
 * @param amount   - The amount string to inspect (e.g. "1.1234567", "100", "-5").
 * @param decimals - Maximum number of decimal places allowed.
 *                   Defaults to 7 (Stellar's maximum, 1 stroop = 0.0000001 XLM).
 * @returns ok(undefined) when the precision is within the limit,
 *          err(VALIDATION) when it exceeds the limit or the input is not a
 *          plain decimal string.
 */
export function validateAmountPrecision(
  amount: string,
  decimals: number = STELLAR_MAX_DECIMAL_PLACES,
): SorokitResult<void> {
  if (typeof amount !== "string" || amount.trim().length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amountPrecision — amount is empty or not a string. Fix: Provide a plain decimal number string (e.g. "10", "0.5").`,
    );
  }

  const trimmed = amount.trim();

  // Must be a valid plain decimal (integer or fractional, optionally negative)
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `amountPrecision — "${trimmed}" is not a valid decimal string. Fix: Provide a plain decimal number without exponent notation (e.g. "10", "0.5", "-1.23").`,
    );
  }

  const dotIndex = trimmed.indexOf(".");
  if (dotIndex !== -1) {
    const actualDecimals = trimmed.length - dotIndex - 1;
    if (actualDecimals > decimals) {
      return err(
        SorokitErrorCode.VALIDATION,
        `amountPrecision — "${trimmed}" has ${actualDecimals} decimal place${actualDecimals === 1 ? "" : "s"}, which exceeds the limit of ${decimals}. Fix: Round or truncate to at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
      );
    }
  }

  return ok(undefined);
}

/**
 * Validate a Stellar network passphrase.
 *
 * Accepted passphrases:
 * - Mainnet: "Public Global Stellar Network ; September 2015"
 * - Testnet: "Test SDF Network ; September 2015"
 *
 * Any other value is rejected with INVALID_NETWORK to catch mainnet/testnet
 * mismatches before a transaction is built or signed.
 *
 * @param passphrase - The network passphrase string to validate.
 * @returns ok(undefined) for a known passphrase, err(INVALID_NETWORK) otherwise.
 */
export function validateNetworkPassphrase(passphrase: string): SorokitResult<void> {
  if (passphrase === STELLAR_MAINNET_PASSPHRASE || passphrase === STELLAR_TESTNET_PASSPHRASE) {
    return ok(undefined);
  }
  const known = `"${STELLAR_MAINNET_PASSPHRASE}" (mainnet) or "${STELLAR_TESTNET_PASSPHRASE}" (testnet)`;
  return err(
    SorokitErrorCode.INVALID_NETWORK,
    `networkPassphrase — "${passphrase}" is not a recognised Stellar network passphrase. Fix: Use one of the known passphrases: ${known}.`,
  );
}
