/**
 * Contract error decoding (#391).
 *
 * Generic error-code extraction lives here; the contract-specific mappings
 * (factory/router) are plain data so applications can supply their own maps
 * without modifying the core decoder.
 */
import { SorobanErrorDecoder } from "./sorobanErrorDecoder";

export interface ContractErrorInfo {
  /** Human-readable description of what went wrong. */
  message: string;
  /** Optional guidance on how the caller can recover or avoid the failure. */
  remediation?: string;
}

/** Maps known contract error identifiers (symbolic or numeric) to structured info. */
export type ContractErrorMap = Record<string, ContractErrorInfo>;

export interface DecodedContractError {
  /** `true` when the code was resolved through a known error map. */
  decoded: boolean;
  /** Resolved error identifier, or `null` when the input carried none. */
  code: string | null;
  /** Decoded message, the original message for unknown codes, or a fallback for malformed inputs. */
  message: string;
  /** Remediation guidance when the code is mapped and guidance exists. */
  remediation?: string;
  /** The original, untouched error value. */
  raw: unknown;
}

// ─── Factory contract (#391) ──────────────────────────────────────────────────

/** Stable numeric codes emitted by the supported factory contracts. */
export const FACTORY_ERROR_CODES = {
  PAIR_ALREADY_EXISTS: 1,
  INVALID_FIRST_TOKEN: 2,
  INVALID_SECOND_TOKEN: 3,
  IDENTICAL_TOKENS: 4,
  UNAUTHORIZED: 5,
} as const;

/** Stable numeric codes emitted by the supported router contracts. */
export const ROUTER_ERROR_CODES = {
  ROUTER_INVALID_PATH: 1,
  ROUTER_INSUFFICIENT_LIQUIDITY: 2,
  ROUTER_SLIPPAGE_EXCEEDED: 3,
  EXPIRED_DEADLINE: 4,
  EXCESSIVE_INPUT_AMOUNT: 5,
  EXCESSIVE_OUTPUT_AMOUNT: 6,
  K_INVARIANT_VIOLATED: 7,
  MINIMUM_LIQUIDITY: 8,
} as const;

function entry(message: string, remediation?: string): ContractErrorInfo {
  return remediation === undefined ? { message } : { message, remediation };
}

/**
 * Standard mappings for the supported factory contracts.
 * Keyed by symbolic name, by namespaced numeric code ("FACTORY_<code>"), and by
 * bare numeric code — the bare form is unambiguous inside a single family map.
 */
export const FACTORY_CONTRACT_ERRORS: ContractErrorMap = (() => {
  const byName: Record<string, ContractErrorInfo> = {
    PAIR_ALREADY_EXISTS: entry(
      "A pair for this token combination already exists.",
      "Query the factory for the existing pair address instead of deploying again.",
    ),
    INVALID_FIRST_TOKEN: entry(
      "The first token address is not a valid token contract.",
      "Verify the token A contract ID before retrying.",
    ),
    INVALID_SECOND_TOKEN: entry(
      "The second token address is not a valid token contract.",
      "Verify the token B contract ID before retrying.",
    ),
    IDENTICAL_TOKENS: entry(
      "Cannot create a pair where both tokens are identical.",
      "Provide two distinct token addresses.",
    ),
    UNAUTHORIZED: entry(
      "Caller is not authorized to perform this factory operation.",
      "Ensure the signing account has the required admin privileges.",
    ),
  };
  const map: ContractErrorMap = {};
  for (const [name, info] of Object.entries(byName)) {
    const code = FACTORY_ERROR_CODES[name as keyof typeof FACTORY_ERROR_CODES];
    map[name] = info;
    map[`FACTORY_${code}`] = info;
    map[String(code)] = info;
  }
  return map;
})();

/**
 * Standard mappings for the supported router contracts.
 * Keyed by symbolic name, by namespaced numeric code ("ROUTER_<code>"), and by
 * bare numeric code — the bare form is unambiguous inside a single family map.
 */
export const ROUTER_CONTRACT_ERRORS: ContractErrorMap = (() => {
  const byName: Record<string, ContractErrorInfo> = {
    ROUTER_INVALID_PATH: entry(
      "The swap path is invalid — it must contain at least two assets.",
      "Supply a path of [tokenIn, ..., tokenOut] with valid intermediate hops.",
    ),
    ROUTER_INSUFFICIENT_LIQUIDITY: entry(
      "Insufficient liquidity in one or more pools along the route.",
      "Reduce the amount or choose a different route.",
    ),
    ROUTER_SLIPPAGE_EXCEEDED: entry(
      "The realized swap price exceeded the allowed slippage tolerance.",
      "Increase amountOutMin/slippage tolerance or retry when volatility subsides.",
    ),
    EXPIRED_DEADLINE: entry(
      "The transaction deadline expired before execution.",
      "Resubmit with a later deadline timestamp.",
    ),
    EXCESSIVE_INPUT_AMOUNT: entry(
      "Required input amount exceeds the user's maximum input.",
      "Raise maxAmountIn or lower the desired output amount.",
    ),
    EXCESSIVE_OUTPUT_AMOUNT: entry(
      "Obtained output amount is below the user's minimum output.",
      "Lower amountOutMin or split the trade into smaller swaps.",
    ),
    K_INVARIANT_VIOLATED: entry(
      "Swap would violate the pool's x·y=k invariant.",
      "Use amounts consistent with current reserves; refresh pool quotes.",
    ),
    MINIMUM_LIQUIDITY: entry(
      "Requested liquidity removal would leave the pool below the minimum liquidity threshold.",
      "Leave at least the protocol-defined MINIMUM_LIQUIDITY in the pool.",
    ),
  };
  const map: ContractErrorMap = {};
  for (const [name, info] of Object.entries(byName)) {
    const code = ROUTER_ERROR_CODES[name as keyof typeof ROUTER_ERROR_CODES];
    map[name] = info;
    map[`ROUTER_${code}`] = info;
    map[String(code)] = info;
  }
  return map;
})();

/** Matches keys that are purely numeric, e.g. "3". */
const BARE_NUMERIC_KEY = /^\d+$/;

/**
 * Combined default mapping used when no custom map is supplied.
 *
 * Namespaced numeric keys ("FACTORY_<code>", "ROUTER_<code>") are used in the
 * merged map because the factory and router families share the same numeric
 * code space. Bare numeric keys are intentionally absent from the merged map:
 * a bare code carries no family information, so resolving one here would
 * silently guess a family (#726). Callers who know the contract family and
 * need to decode bare numeric codes must pass FACTORY_CONTRACT_ERRORS or
 * ROUTER_CONTRACT_ERRORS explicitly.
 *
 * (Disambiguation strategy: numeric key namespace prefixes. See #391, #726.)
 */
export const DEFAULT_CONTRACT_ERROR_MAP: ContractErrorMap = Object.fromEntries(
  Object.entries({
    ...FACTORY_CONTRACT_ERRORS,
    ...ROUTER_CONTRACT_ERRORS,
  }).filter(([key]) => !BARE_NUMERIC_KEY.test(key)),
);

// ─── Generic code extraction ──────────────────────────────────────────────────

/** Matches Soroban host-style codes embedded in messages, e.g. `Error(Contract, #12)`. */
const NUMERIC_CODE_IN_MESSAGE = /#(-?\d+)/;

/** Matches bare symbolic contract error names such as `ROUTER_SLIPPAGE_EXCEEDED`. */
const SYMBOLIC_NAME = /^[A-Z][A-Z0-9_]{2,78}$/;

function pushNumeric(codes: string[], value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    codes.push(String(value));
    return;
  }
  if (typeof value === "bigint" || typeof value === "string") {
    const str = String(value).trim();
    if (/^-?\d+$/.test(str)) codes.push(str);
  }
}

/**
 * Extract candidate error identifiers from an arbitrary error value.
 * Handles stellar-sdk HostError instances (`codes()`), `{code}` shapes,
 * SorokitResult-style envelopes, and message-embedded codes. Never throws.
 */
function extractCandidateCodes(error: unknown): string[] {
  const codes: string[] = [];

  try {
    if (typeof error === "number" || typeof error === "bigint") {
      pushNumeric(codes, error);
      return dedupe(codes);
    }

    if (typeof error === "string") {
      const trimmed = error.trim();
      if (/^-?\d+$/.test(trimmed)) codes.push(trimmed);
      const embedded = NUMERIC_CODE_IN_MESSAGE.exec(trimmed);
      if (embedded?.[1]) codes.push(embedded[1]);
      const upper = trimmed.toUpperCase();
      if (SYMBOLIC_NAME.test(upper)) codes.push(upper);
      return dedupe(codes);
    }

    if (error instanceof Error) {
      // stellar-sdk HostError exposes codes(): e.g. ["Contract", 1234]
      const codesFn = (error as { codes?: unknown }).codes;
      if (typeof codesFn === "function") {
        const hostCodes = codesFn.call(error) as unknown;
        if (Array.isArray(hostCodes)) {
          for (const c of hostCodes) pushNumeric(codes, c);
        }
      }
      const codeProp = (error as { code?: unknown }).code;
      if (codeProp !== undefined) pushNumericOrSymbol(codes, codeProp);
      if (error.message) collectFromMessage(codes, error.message);
      return dedupe(codes);
    }

    if (error !== null && typeof error === "object") {
      const obj = error as Record<string, unknown>;
      if (obj.code !== undefined) pushNumericOrSymbol(codes, obj.code);
      if (obj.errorCode !== undefined)
        pushNumericOrSymbol(codes, obj.errorCode);
      if (
        typeof obj.status === "string" &&
        obj.status === "error" &&
        obj.error !== null &&
        typeof obj.error === "object"
      ) {
        const inner = obj.error as Record<string, unknown>;
        if (inner.code !== undefined) pushNumericOrSymbol(codes, inner.code);
        if (typeof inner.message === "string")
          collectFromMessage(codes, inner.message);
      }
      if (typeof obj.message === "string")
        collectFromMessage(codes, obj.message);
    }
  } catch {
    // Malformed input must never break decoding.
  }

  return dedupe(codes);
}

function pushNumericOrSymbol(codes: string[], value: unknown): void {
  if (typeof value === "number" || typeof value === "bigint") {
    pushNumeric(codes, value);
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      codes.push(trimmed);
      return;
    }
    const embedded = NUMERIC_CODE_IN_MESSAGE.exec(trimmed);
    if (embedded?.[1]) codes.push(embedded[1]);
    const upper = trimmed.toUpperCase();
    if (SYMBOLIC_NAME.test(upper)) codes.push(upper);
  }
}

function collectFromMessage(codes: string[], message: string): void {
  const embedded = NUMERIC_CODE_IN_MESSAGE.exec(message);
  if (embedded?.[1]) codes.push(embedded[1]);
  for (const word of message.split(/[^A-Za-z0-9_]+/)) {
    const upper = word.toUpperCase();
    if (SYMBOLIC_NAME.test(upper)) codes.push(upper);
  }
}

function dedupe(codes: string[]): string[] {
  return [...new Set(codes)];
}

/**
 * Resolve an arbitrary contract failure into structured information.
 *
 * - Known codes resolve to the mapped message plus optional remediation.
 * - Unknown/unmapped codes preserve the original message and raw value.
 * - Malformed inputs never throw; they return `decoded: false`.
 *
 * @param error     - Raw failure value (HostError, Error, string, envelope…)
 * @param errorMap  - Custom mapping; defaults to the bundled factory/router map.
 *
 * (issue #391)
 */
export function decodeContractError(
  error: unknown,
  errorMap: ContractErrorMap = DEFAULT_CONTRACT_ERROR_MAP,
): DecodedContractError {
  const candidates = extractCandidateCodes(error);

  let originalMessage = "";
  if (typeof error === "string") {
    originalMessage = error;
  } else if (error instanceof Error) {
    originalMessage = error.message;
  } else if (error !== null && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    const innerMsg = (error as { error?: { message?: unknown } }).error
      ?.message;
    if (typeof msg === "string") originalMessage = msg;
    else if (typeof innerMsg === "string") originalMessage = innerMsg;
  }

  for (const code of candidates) {
    const info = errorMap[code];
    if (info) {
      return {
        decoded: true,
        code,
        message: info.message,
        ...(info.remediation !== undefined
          ? { remediation: info.remediation }
          : {}),
        raw: error,
      };
    }
  }

  const panic = SorobanErrorDecoder.decode(error);
  if (panic.isPanic) {
    return {
      decoded: true,
      code: candidates[0] ?? (panic.code ? String(panic.code) : null),
      message: panic.description,
      raw: error,
    };
  }

  if (candidates.length > 0) {
    return {
      decoded: false,
      code: candidates[0] ?? null,
      message: originalMessage || `Unmapped contract error: ${candidates[0]}`,
      raw: error,
    };
  }

  return {
    decoded: false,
    code: null,
    message: originalMessage || "No decodable contract error information",
    raw: error,
  };
}
