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

export const SOROBAN_MAX_METHOD_NAME_LEN = 32;

/**
 * Reserved keywords in Soroban / Rust smart contracts that cannot be used as contract entrypoints.
 * Per the Soroban Specification and Rust language reference.
 */
export const SOROBAN_RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  // Rust keywords
  "as", "break", "const", "continue", "crate", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
  "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct",
  "super", "trait", "true", "type", "unsafe", "use", "where", "while",
  "async", "await", "dyn",
  // Rust reserved for future use
  "abstract", "become", "box", "do", "final", "macro", "override", "priv",
  "typeof", "unsized", "virtual", "yield", "try",
  // Soroban internal/reserved entrypoints
  "__constructor",
]);

/**
 * Valid Soroban scalar types per the Soroban Environment Specification (ScSpecTypeDef / ScVal / CAP-0046).
 */
export const SOROBAN_SCALAR_TYPES: ReadonlySet<string> = new Set([
  "u32", "i32",
  "u64", "i64",
  "u128", "i128",
  "u256", "i256",
  "bool",
  "void", "()", "unit",
  "string",
  "symbol",
  "bytes", "bytes32",
  "address",
]);

/**
 * Valid Soroban container / composite types per the Soroban Specification.
 */
export const SOROBAN_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "vec",
  "map",
  "tuple",
  "option",
  "result",
]);

/**
 * Special / dynamic Soroban types.
 */
export const SOROBAN_SPECIAL_TYPES: ReadonlySet<string> = new Set([
  "val",
  "custom",
  "error",
]);

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

export interface ContractMethodParamSpec {
  name?: string;
  type: string | Record<string, unknown>;
}

export interface ContractMethodSpecInput {
  name: string;
  inputs?: Array<ContractMethodParamSpec | string>;
  parameters?: Array<ContractMethodParamSpec | string>;
  params?: Array<ContractMethodParamSpec | string>;
  args?: Array<ContractMethodParamSpec | string>;
  returnType?: string | Record<string, unknown> | null;
  returns?: string | Record<string, unknown> | null;
  return_type?: string | Record<string, unknown> | null;
}

export interface ContractMethodValidationData {
  value: unknown;
  name: string;
  inputs: Array<{ name: string; type: string }>;
  returnType: string | null;
}

export type ValidationData =
  | AddressValidationData
  | AmountValidationData
  | AssetCodeValidationData
  | UrlValidationData
  | ContractMethodValidationData;

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

// ─── Soroban Contract Method Validation (#769) ────────────────────────────────

/**
 * Parse a potentially generic Soroban type string (e.g. "vec<u32>", "map<string, i64>").
 * Returns null if the syntax is malformed or brackets are unbalanced.
 */
function parseGenericType(typeStr: string): { base: string; params: string[] } | null {
  const match = typeStr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:<(.+)>)?$/);
  if (!match) return null;
  const base = match[1]!.toLowerCase();
  const inner = match[2];
  if (!inner) return { base, params: [] };

  const params: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === "<") depth++;
    else if (char === ">") depth--;
    else if (char === "," && depth === 0) {
      if (!current.trim()) return null; // empty parameter like "vec<,>"
      params.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (depth !== 0) return null; // unbalanced brackets
  if (!current.trim()) return null; // trailing empty parameter
  params.push(current.trim());
  return { base, params };
}

/**
 * Validate a Soroban type against the Soroban Environment Specification (ScSpecTypeDef / ScVal / CAP-0046).
 */
export function validateSorobanType(typeInput: unknown, fieldName: string): SorokitResult<string> {
  if (typeInput === null || typeInput === undefined) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Type for ${fieldName} is missing or undefined. Per the Soroban specification (ScSpecTypeDef / CAP-0046), a valid scalar or container type is required.`,
    );
  }

  let typeStr: string;
  if (typeof typeInput === "string") {
    typeStr = typeInput.trim();
  } else if (typeof typeInput === "object" && typeInput !== null && "type" in typeInput) {
    const inner = (typeInput as { type: unknown }).type;
    if (typeof inner !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        `Type for ${fieldName} must be a string. Per the Soroban specification, valid types include: u32, i64, string, bool, bytes, address, vec, map.`,
      );
    }
    typeStr = inner.trim();
  } else {
    return err(
      SorokitErrorCode.VALIDATION,
      `Type for ${fieldName} must be a string or type descriptor. Per the Soroban specification, valid types include: u32, i64, string, bool, bytes, address, vec, map.`,
    );
  }

  if (typeStr.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Type for ${fieldName} cannot be empty. Per the Soroban specification (ScSpecTypeDef / CAP-0046), valid scalar types include: u32, i32, u64, i64, u128, i128, u256, i256, bool, void, string, symbol, bytes, address.`,
    );
  }

  // Handle void / unit notations
  if (typeStr === "()" || typeStr.toLowerCase() === "void" || typeStr.toLowerCase() === "unit") {
    return ok("void");
  }

  const parsed = parseGenericType(typeStr);
  if (!parsed) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Malformed Soroban type "${typeStr}" for ${fieldName}: invalid or unbalanced generic syntax. Per the Soroban type specification (ScSpecTypeDef / CAP-0046), types must follow canonical identifier or container<T> syntax.`,
    );
  }

  const { base, params } = parsed;

  // Check fixed-size byte array patterns like bytes32, bytes_32, bytes16, bytes64
  const isBytesN = /^bytes_?(\d+)$/i.exec(base);
  const isValidBytesN = isBytesN && Number(isBytesN[1]) >= 1 && Number(isBytesN[1]) <= 64;

  if (params.length === 0) {
    const isValidScalar = SOROBAN_SCALAR_TYPES.has(base) || isValidBytesN;
    const isValidContainer = SOROBAN_CONTAINER_TYPES.has(base);
    const isValidSpecial = SOROBAN_SPECIAL_TYPES.has(base);

    if (["vec", "map", "option", "result"].includes(base)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Container type "${base}" requires type arguments. Per the Soroban specification (ScSpecTypeDef), use ${base}<...> with the required argument count.`,
      );
    }

    if (isValidScalar || isValidContainer || isValidSpecial) {
      return ok(typeStr);
    }

    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid Soroban type "${typeStr}" for ${fieldName}. Per the Soroban type specification (ScSpecTypeDef / ScVal / CAP-0046), valid scalar types include: u32, i32, u64, i64, u128, i128, u256, i256, bool, void, string, symbol, bytes, address, and container types: vec, map, tuple, option, result.`,
    );
  }

  // If params are present, verify container legality and arity
  if (SOROBAN_SCALAR_TYPES.has(base) || isValidBytesN) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Scalar type "${base}" cannot have generic type parameters in "${typeStr}". Per the Soroban type specification (ScSpecTypeDef / CAP-0046), only container types (vec, map, tuple, option, result) accept type arguments.`,
    );
  }

  if (!SOROBAN_CONTAINER_TYPES.has(base)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Unknown container type "${base}" in "${typeStr}". Per the Soroban type specification (ScSpecTypeDef / CAP-0046), valid container types are: vec, map, tuple, option, result.`,
    );
  }

  if (base === "option" && params.length !== 1) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Option type requires exactly 1 type argument, received ${params.length} in "${typeStr}". Per the Soroban specification (ScSpecTypeDef), syntax is option<T>.`,
    );
  }

  if (base === "vec" && params.length !== 1) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Vector type requires exactly 1 type argument, received ${params.length} in "${typeStr}". Per the Soroban specification (ScSpecTypeDef), syntax is vec<T>.`,
    );
  }

  if (base === "map" && params.length !== 2) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Map type requires exactly 2 type arguments (key and value), received ${params.length} in "${typeStr}". Per the Soroban specification (ScSpecTypeDef), syntax is map<Key, Value>.`,
    );
  }

  if (base === "result" && (params.length < 1 || params.length > 2)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Result type requires 1 or 2 type arguments, received ${params.length} in "${typeStr}". Per the Soroban specification (ScSpecTypeDef), syntax is result<Ok, Err>.`,
    );
  }

  // Recursively validate each inner parameter
  for (let i = 0; i < params.length; i++) {
    const innerResult = validateSorobanType(params[i], `${fieldName} <${base} arg ${i + 1}>`);
    if (innerResult.status === "error") return innerResult;
  }

  return ok(typeStr);
}

/**
 * Validate a Soroban contract method identifier name.
 */
function validateMethodName(rawName: unknown): SorokitResult<string> {
  if (typeof rawName !== "string") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Method name must be a string. Per the Soroban method specification (CAP-0046 / ScSymbol), method names must be valid ASCII string identifiers.",
    );
  }

  const name = rawName;
  if (name.length === 0) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Method name cannot be empty. Per the Soroban method specification (CAP-0046 / ScSymbol), method names must be between 1 and 32 characters.",
    );
  }

  if (name.length > SOROBAN_MAX_METHOD_NAME_LEN) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Method name "${name}" exceeds the maximum Soroban symbol limit of ${SOROBAN_MAX_METHOD_NAME_LEN} characters (actual: ${name.length}). Per the Soroban specification (CAP-0046 / ScSymbol), method names must be at most 32 bytes.`,
    );
  }

  if (/^[0-9]/.test(name)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Method name "${name}" is invalid because it starts with a digit. Per the Soroban method specification (CAP-0046 / ScSymbol), method identifiers must begin with an ASCII letter or underscore.`,
    );
  }

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Method name "${name}" contains invalid characters. Per the Soroban method specification (CAP-0046 / ScSymbol), method identifiers may only contain alphanumeric characters and underscores.`,
    );
  }

  if (SOROBAN_RESERVED_KEYWORDS.has(name.toLowerCase()) || SOROBAN_RESERVED_KEYWORDS.has(name)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Method name "${name}" is a reserved keyword in Soroban / Rust smart contracts. Per the Soroban specification, reserved keywords cannot be used as contract entrypoint identifiers.`,
    );
  }

  return ok(name);
}

/**
 * Validate a Soroban contract method specification.
 *
 * Verifies that:
 * 1. The method object is well-formed with a valid name.
 * 2. The method name follows Soroban identifier naming rules (non-alphanumeric, leading digits, and reserved keywords rejected).
 * 3. All input/parameter types are valid Soroban scalar or container types (u32, i64, string, vec, map, etc.).
 * 4. Return type (if specified) is a valid Soroban type or void.
 *
 * @param method - The contract method specification object.
 * @returns ok(ContractMethodValidationData) when valid, err(SorokitErrorCode.VALIDATION) otherwise.
 */
export function validateContractMethodSpec(
  method: unknown,
): SorokitResult<ContractMethodValidationData> {
  if (typeof method !== "object" || method === null || Array.isArray(method)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Contract method specification must be an object. Per the Soroban specification, methods require a valid name, inputs array, and returnType.",
    );
  }

  const rawMethod = method as Record<string, unknown>;
  const nameResult = validateMethodName(rawMethod.name);
  if (nameResult.status === "error") return nameResult;
  const cleanName = nameResult.data;

  // Extract inputs / parameters / params / args
  const rawInputs = rawMethod.inputs ?? rawMethod.parameters ?? rawMethod.params ?? rawMethod.args;
  let validatedInputs: Array<{ name: string; type: string }> = [];

  if (rawInputs !== undefined && rawInputs !== null) {
    if (!Array.isArray(rawInputs)) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Method inputs/parameters for "${cleanName}" must be an array. Per the Soroban method specification, inputs are defined as an ordered list of typed parameters.`,
      );
    }

    validatedInputs = [];
    for (let i = 0; i < rawInputs.length; i++) {
      const entry = rawInputs[i];
      let paramName = `arg${i}`;
      let paramTypeInput: unknown;

      if (typeof entry === "string") {
        paramTypeInput = entry;
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.name === "string" && obj.name.trim().length > 0) {
          paramName = obj.name.trim();
          if (/^[0-9]/.test(paramName) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(paramName)) {
            return err(
              SorokitErrorCode.VALIDATION,
              `Parameter name "${paramName}" at index ${i} of method "${cleanName}" is invalid. Per the Soroban specification, parameter identifiers must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
            );
          }
        }
        paramTypeInput = obj.type;
      } else {
        return err(
          SorokitErrorCode.VALIDATION,
          `Parameter at index ${i} of method "${cleanName}" must be a type string or parameter descriptor object.`,
        );
      }

      const typeResult = validateSorobanType(paramTypeInput, `parameter "${paramName}" (index ${i}) of method "${cleanName}"`);
      if (typeResult.status === "error") return typeResult;
      validatedInputs.push({ name: paramName, type: typeResult.data });
    }
  }

  // Validate return type
  let validatedReturnType: string | null = null;
  const returnTypeVal = rawMethod.returnType ?? rawMethod.returns ?? rawMethod.return_type;
  if (returnTypeVal !== undefined && returnTypeVal !== null) {
    let retStr: unknown;
    if (typeof returnTypeVal === "string") {
      retStr = returnTypeVal;
    } else if (typeof returnTypeVal === "object" && "type" in returnTypeVal) {
      retStr = (returnTypeVal as { type: unknown }).type;
    } else {
      return err(
        SorokitErrorCode.VALIDATION,
        `Return type of method "${cleanName}" must be a type string or type descriptor object.`,
      );
    }
    if (
      retStr === null ||
      retStr === undefined ||
      retStr === "()" ||
      String(retStr).toLowerCase() === "void" ||
      String(retStr).toLowerCase() === "unit"
    ) {
      validatedReturnType = null;
    } else {
      if (typeof retStr !== "string") {
        return err(
          SorokitErrorCode.VALIDATION,
          `Return type of method "${cleanName}" must be a string.`,
        );
      }
      const retCheck = validateSorobanType(retStr, `returnType of method "${cleanName}"`);
      if (retCheck.status === "error") return retCheck;
      validatedReturnType = retCheck.data === "void" ? null : retCheck.data;
    }
  }

  return ok({
    value: method,
    name: cleanName,
    inputs: validatedInputs,
    returnType: validatedReturnType,
  });
}

/**
 * Convenience helper returning boolean validity for a Soroban contract method specification.
 */
export function isValidContractMethodSpec(method: unknown): boolean {
  return validateContractMethodSpec(method).status === "ok";
}
