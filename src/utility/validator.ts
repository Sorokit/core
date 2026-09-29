/**
 * Data Validation and Sanitization Framework for Sorokit.
 *
 * Provides centralized, robust validation and sanitization for:
 * - Stellar addresses (Ed25519 G-keys, Soroban C-contracts, and M-muxed accounts)
 * - Transaction amounts (decimal scale, bounds, asset limits)
 * - Asset codes (1–12 alphanumeric chars, native)
 * - URLs (safe web protocols, SSRF/XSS protection)
 * - User string inputs (XSS stripping, HTML sanitization, control char removal)
 *
 * All validators return `SorokitResult<ValidationData>` without throwing.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Constants ────────────────────────────────────────────────────────────────

export const STELLAR_MAX_DECIMALS = 7;
export const STELLAR_MAX_AMOUNT = "922337203685.4775807";
export const STELLAR_MIN_ASSET_CODE_LEN = 1;
export const STELLAR_MAX_ASSET_CODE_LEN = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

export type StellarAddressType =
  | "ed25519_public_key"
  | "contract"
  | "muxed_account";

export interface AddressValidationData {
  value: string;
  address: string;
  type: StellarAddressType;
}

export interface AmountValidationData {
  value: string;
  amount: string;
  asset?: string;
  decimals: number;
}

export interface AssetCodeValidationData {
  value: string;
  code: string;
}

export interface UrlValidationData {
  value: string;
  url: string;
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
}

export type ValidationData =
  | AddressValidationData
  | AmountValidationData
  | AssetCodeValidationData
  | UrlValidationData;

export interface AmountValidationOptions {
  maxDecimals?: number;
  maxAmount?: string;
  minAmount?: string;
  allowZero?: boolean;
}

export interface UrlValidationOptions {
  allowedProtocols?: string[];
  allowCredentials?: boolean;
  requireTld?: boolean;
}

export interface SanitizeInputOptions {
  stripHtml?: boolean;
  trim?: boolean;
  stripControlChars?: boolean;
  maxLength?: number;
}

// ─── Address Validation ───────────────────────────────────────────────────────

/**
 * Validate a Stellar address.
 *
 * Supports:
 * - Standard Ed25519 public keys ('G...', 56 chars)
 * - Soroban contract addresses ('C...', 56 chars)
 * - Muxed account addresses ('M...', 69 chars)
 *
 * @param addr - The address string to validate.
 * @returns ok(AddressValidationData) when valid, err(INVALID_ADDRESS) otherwise.
 */
export function validateAddress(
  addr: unknown,
): SorokitResult<AddressValidationData> {
  if (typeof addr !== "string" || addr.trim().length === 0) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Address is empty or not a string. Fix: Provide a valid Stellar address (G..., C..., or M...).`,
    );
  }

  const cleanAddr = addr.trim();

  // Ed25519 Public Key
  if (cleanAddr.startsWith("G")) {
    if (cleanAddr.length === 56 && StrKey.isValidEd25519PublicKey(cleanAddr)) {
      return ok({
        value: cleanAddr,
        address: cleanAddr,
        type: "ed25519_public_key",
      });
    }
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Address "${cleanAddr}" is not a valid Stellar Ed25519 public key. Fix: Ensure it is a valid 56-character Base32 string starting with G.`,
    );
  }

  // Soroban Contract Address
  if (cleanAddr.startsWith("C")) {
    if (cleanAddr.length === 56 && StrKey.isValidContract(cleanAddr)) {
      return ok({
        value: cleanAddr,
        address: cleanAddr,
        type: "contract",
      });
    }
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Address "${cleanAddr}" is not a valid Soroban contract address. Fix: Ensure it is a valid 56-character Base32 contract identifier starting with C.`,
    );
  }

  // Muxed Account Address
  if (cleanAddr.startsWith("M")) {
    if (cleanAddr.length === 69 && StrKey.isValidMed25519PublicKey(cleanAddr)) {
      return ok({
        value: cleanAddr,
        address: cleanAddr,
        type: "muxed_account",
      });
    }
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Address "${cleanAddr}" is not a valid Stellar muxed account address. Fix: Ensure it is a valid 69-character Base32 string starting with M.`,
    );
  }

  return err(
    SorokitErrorCode.INVALID_ADDRESS,
    `Address "${cleanAddr}" has an unsupported prefix. Fix: Stellar addresses must start with G (account), C (contract), or M (muxed account).`,
  );
}

/**
 * Boolean helper checking whether an address is valid.
 */
export function isValidAddress(addr: unknown): boolean {
  return validateAddress(addr).status === "ok";
}

// ─── Amount Validation ────────────────────────────────────────────────────────

/**
 * Validate an asset amount and decimal precision.
 *
 * Enforces:
 * - Positive finite decimal format (no exponent notation, hex, or non-numeric tokens)
 * - Decimals within allowed bounds (default 7 places for Stellar)
 * - Maximum supply cap (default 922337203685.4775807 XLM)
 *
 * @param amount - The amount as a string or number.
 * @param asset - Optional asset identifier (e.g. "XLM", "USDC").
 * @param options - Optional custom limits and precision.
 * @returns ok(AmountValidationData) when valid, err(VALIDATION) otherwise.
 */
export function validateAmount(
  amount: unknown,
  asset?: string,
  options?: AmountValidationOptions,
): SorokitResult<AmountValidationData> {
  const raw =
    typeof amount === "number"
      ? Number.isFinite(amount)
        ? String(amount)
        : null
      : typeof amount === "string"
        ? amount.trim()
        : null;

  if (raw === null || raw.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Amount is empty or not a valid number. Fix: Provide a positive numeric string or number (e.g. "10.5").`,
    );
  }

  // Validate format: digits with optional decimal part
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Amount "${raw}" is not a valid decimal amount. Fix: Provide a plain decimal number without scientific notation (e.g. "10", "0.5").`,
    );
  }

  const allowZero = options?.allowZero ?? false;
  const isZero = /^0(?:\.0*)?$/.test(raw);

  if (raw.startsWith("-") || (isZero && !allowZero)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Amount "${raw}" must be greater than zero. Fix: Provide a positive amount.`,
    );
  }

  const maxDecimals = options?.maxDecimals ?? STELLAR_MAX_DECIMALS;
  const dotIndex = raw.indexOf(".");
  const decimals = dotIndex !== -1 ? raw.length - dotIndex - 1 : 0;

  if (decimals > maxDecimals) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Amount "${raw}" has ${decimals} decimal places, which exceeds the maximum of ${maxDecimals}. Fix: Round or truncate to at most ${maxDecimals} decimal places.`,
    );
  }

  // Upper bound check (compare stroops using BigInt to prevent floating-point inaccuracy)
  const maxAmountStr = options?.maxAmount ?? STELLAR_MAX_AMOUNT;
  if (maxAmountStr) {
    const ONE = 10_000_000n;
    const MAX_INT64 = 9_223_372_036_854_775_807n;

    const [wholePart = "0", fracPart = ""] = raw.split(".");
    const paddedFrac = fracPart.padEnd(STELLAR_MAX_DECIMALS, "0").slice(0, STELLAR_MAX_DECIMALS);
    const stroops = BigInt(wholePart) * ONE + BigInt(paddedFrac);

    if (maxAmountStr === STELLAR_MAX_AMOUNT) {
      if (stroops > MAX_INT64) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Amount "${raw}" exceeds the maximum representable Stellar amount (${STELLAR_MAX_AMOUNT}). Fix: Provide an amount at or below ${STELLAR_MAX_AMOUNT}.`,
        );
      }
    } else {
      const [maxWhole = "0", maxFrac = ""] = maxAmountStr.split(".");
      const paddedMaxFrac = maxFrac.padEnd(STELLAR_MAX_DECIMALS, "0").slice(0, STELLAR_MAX_DECIMALS);
      const maxStroops = BigInt(maxWhole) * ONE + BigInt(paddedMaxFrac);
      if (stroops > maxStroops) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Amount "${raw}" exceeds the configured maximum of ${maxAmountStr}. Fix: Lower the amount.`,
        );
      }
    }
  }

  // Validate asset if provided
  if (asset) {
    const assetCheck = validateAssetCode(asset);
    if (assetCheck.status === "error") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid asset specified for amount: ${assetCheck.error.message}`,
      );
    }
  }

  return ok({
    value: raw,
    amount: raw,
    ...(asset !== undefined ? { asset } : {}),
    decimals,
  });
}

// ─── Asset Code Validation ────────────────────────────────────────────────────

/**
 * Validate a Stellar asset code.
 *
 * Rules:
 * - 1 to 12 alphanumeric characters (A–Z, a–z, 0–9)
 * - "native" or "XLM" are allowed aliases
 *
 * @param code - The asset code to validate.
 * @returns ok(AssetCodeValidationData) when valid, err(VALIDATION) otherwise.
 */
export function validateAssetCode(
  code: unknown,
): SorokitResult<AssetCodeValidationData> {
  if (typeof code !== "string" || code.trim().length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Asset code is empty or not a string. Fix: Provide a 1–12 character alphanumeric asset code (e.g. "USDC", "XLM").`,
    );
  }

  const clean = code.trim();

  if (clean.toLowerCase() === "native") {
    return ok({
      value: "native",
      code: "native",
    });
  }

  if (clean.length < STELLAR_MIN_ASSET_CODE_LEN) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Asset code cannot be empty. Fix: Provide an asset code of at least 1 character.`,
    );
  }

  if (clean.length > STELLAR_MAX_ASSET_CODE_LEN) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Asset code "${clean}" is ${clean.length} characters long, exceeding the maximum of ${STELLAR_MAX_ASSET_CODE_LEN}. Fix: Shorten the asset code to 12 characters or fewer.`,
    );
  }

  if (!/^[A-Za-z0-9]+$/.test(clean)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Asset code "${clean}" contains non-alphanumeric characters. Fix: Use only letters (A–Z, a–z) and numbers (0–9).`,
    );
  }

  return ok({
    value: clean,
    code: clean,
  });
}

// ─── URL Validation ───────────────────────────────────────────────────────────

/**
 * Validate a URL for safety and structure.
 *
 * Defends against:
 * - Dangerous schemes (javascript:, data:, vbscript:, file:)
 * - Malformed domains and protocol confusion
 * - Embedded credentials (phishing vectors)
 *
 * @param url - The URL string to validate.
 * @param options - Custom URL options (allowed protocols, etc.).
 * @returns ok(UrlValidationData) when valid, err(VALIDATION) otherwise.
 */
export function validateUrl(
  url: unknown,
  options?: UrlValidationOptions,
): SorokitResult<UrlValidationData> {
  if (typeof url !== "string" || url.trim().length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `URL is empty or not a string. Fix: Provide a valid URL (e.g. "https://example.com").`,
    );
  }

  const cleanUrl = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return err(
      SorokitErrorCode.VALIDATION,
      `URL "${cleanUrl}" is malformed. Fix: Ensure the URL contains a valid scheme and host (e.g. "https://horizon.stellar.org").`,
    );
  }

  const allowedProtocols = options?.allowedProtocols ?? ["http:", "https:"];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `URL protocol "${parsed.protocol}" is not permitted. Fix: Use one of the allowed protocols: ${allowedProtocols.join(", ")}.`,
    );
  }

  if (!options?.allowCredentials && (parsed.username || parsed.password)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `URL contains user authentication credentials, which is prohibited. Fix: Remove username/password from the URL.`,
    );
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `URL "${cleanUrl}" does not specify a valid hostname. Fix: Provide a domain name or IP address.`,
    );
  }

  if (options?.requireTld && !parsed.hostname.includes(".")) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Hostname "${parsed.hostname}" must include a top-level domain. Fix: Provide a fully-qualified domain name (e.g. "stellar.org").`,
    );
  }

  return ok({
    value: parsed.toString(),
    url: parsed.toString(),
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
  });
}

// ─── Input Sanitization ───────────────────────────────────────────────────────

/**
 * Sanitize untrusted input strings to prevent XSS, script injection, and control char attacks.
 *
 * Removes:
 * - Active script tags (<script>...</script>)
 * - Dangerous embed elements (<iframe>, <object>, <embed>, <style>, <link>, <meta>)
 * - Inline event handlers (onload=, onerror=, onclick=, etc.)
 * - Javascript pseudoprotocols (javascript:, vbscript:, data:text/html)
 * - Non-printable ASCII control characters
 *
 * @param input - The raw input to sanitize.
 * @param options - Options for controlling sanitization behaviour.
 * @returns Clean, sanitized string.
 */
export function sanitizeInput(
  input: unknown,
  options?: SanitizeInputOptions,
): string {
  if (input === null || input === undefined) {
    return "";
  }

  let text = typeof input === "string" ? input : String(input);

  // Strip control characters (excluding standard whitespace \t, \n, \r)
  if (options?.stripControlChars !== false) {
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  }

  // Remove dangerous script & embedded blocks along with their contents
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  text = text.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  text = text.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "");

  // Remove inline JS event handlers (e.g. onclick="...", onerror=...)
  text = text.replace(/on\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, "");

  // Remove javascript: and vbscript: pseudoprotocols
  text = text.replace(/(?:javascript|vbscript|data\s*:\s*text\/html):/gi, "");

  // Strip all remaining HTML tags if stripHtml is enabled (default: true)
  if (options?.stripHtml !== false) {
    text = text.replace(/<\/?[^>]+(>|$)/g, "");
  }

  // Trim whitespace by default
  if (options?.trim !== false) {
    text = text.trim();
  }

  // Enforce max length if specified
  if (options?.maxLength && options.maxLength > 0) {
    text = text.slice(0, options.maxLength);
  }

  return text;
}
