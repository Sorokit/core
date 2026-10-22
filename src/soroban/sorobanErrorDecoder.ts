/**
 * Soroban panic and VM trap decoder (#859).
 *
 * Decodes cryptic serialized Soroban panics, WebAssembly traps, and host errors
 * into human-readable descriptions, enabling easier contract debugging.
 */

export type PanicType =
  | "wasm_trap"
  | "host_trap"
  | "rust_panic"
  | "budget_exceeded"
  | "auth_failed"
  | "storage_error"
  | "unknown";

export interface DecodedPanic {
  /** True when a recognized or generic panic/trap format was detected. */
  isPanic: boolean;
  /** Categorized panic/trap type. */
  type: PanicType;
  /** Human-readable explanation of the panic or trap. */
  description: string;
  /** Extracted contract or host error code if present. */
  code?: string | number;
  /** Original unparsed error or message. */
  raw: unknown;
}

/** Known WebAssembly trap message patterns and their readable descriptions. */
const KNOWN_WASM_TRAPS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /unreachable/i,
    description: "WebAssembly unreachable instruction executed (contract assertion failed or explicit panic).",
  },
  {
    pattern: /(integer\s+overflow|arithmetic\s+overflow|overflow\s+during\s+arithmetic|attempt to (add|subtract|multiply|divide) with overflow)/i,
    description: "Arithmetic overflow or underflow detected during contract execution.",
  },
  {
    pattern: /(division\s+by\s+zero|divide\s+by\s+zero|remainder\s+by\s+zero)/i,
    description: "Division or remainder by zero in contract execution.",
  },
  {
    pattern: /(out\s+of\s+bounds|memory\s+access\s+out\s+of\s+bounds|table\s+index\s+out\s+of\s+bounds)/i,
    description: "WebAssembly memory or table access out of bounds.",
  },
  {
    pattern: /(stack\s+overflow|call\s+stack\s+exhausted|call\s+stack\s+overflow)/i,
    description: "WebAssembly call stack exhausted (deep recursion or excessive stack frames).",
  },
  {
    pattern: /unaligned\s+memory/i,
    description: "Unaligned memory access in WebAssembly execution.",
  },
  {
    pattern: /indirect\s+call\s+type\s+mismatch/i,
    description: "Indirect function call type mismatch in WebAssembly module.",
  },
];

/** Known host error patterns and their readable descriptions. */
const KNOWN_HOST_TRAPS: Array<{ pattern: RegExp; description: string; type: PanicType }> = [
  {
    pattern: /Error\s*\(\s*WasmVm\s*,\s*(?:Trapped|#\d+)\s*\)/i,
    description: "WebAssembly VM execution trapped.",
    type: "wasm_trap",
  },
  {
    pattern: /Error\s*\(\s*Context\s*,\s*(?:Trap|#\d+)\s*\)/i,
    description: "Soroban host context trap occurred during contract execution.",
    type: "host_trap",
  },
  {
    pattern: /Error\s*\(\s*Budget\s*,\s*(?:ExceededLimit|#\d+)\s*\)|budget\s+exceeded|cpu\s+instructions\s+exceeded|memory\s+bytes\s+exceeded/i,
    description: "Soroban compute or memory resource budget exceeded.",
    type: "budget_exceeded",
  },
  {
    pattern: /Error\s*\(\s*Storage\s*,\s*(?:MissingValue|#\d+)\s*\)|storage\s+entry\s+not\s+found/i,
    description: "Contract attempted to access missing or expired storage key.",
    type: "storage_error",
  },
  {
    pattern: /Error\s*\(\s*Auth\s*,\s*(?:Invalid|#\d+)\s*\)|authorization\s+failed|bad\s+auth/i,
    description: "Contract invocation authorization failed or invalid credentials.",
    type: "auth_failed",
  },
];

/** Matches Rust panic text, e.g. `panicked at 'assertion failed: x > 0', src/lib.rs:42:5`. */
const RUST_PANIC_REGEX = /panicked at (?:'([^']+)'|([^,\n]+))(?:,\s*([^\n]+))?/i;

/** Matches Soroban Contract custom error codes, e.g. `Error(Contract, #123)`. */
const CONTRACT_CODE_REGEX = /Error\s*\(\s*Contract\s*,\s*#?(-?\d+)\s*\)/i;

function extractRawString(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (obj.error && typeof (obj.error as Record<string, unknown>).message === "string") {
      return (obj.error as Record<string, unknown>).message as string;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? "");
}

/**
 * SorobanErrorDecoder decodes Soroban panic and VM trap messages into readable descriptions.
 */
export class SorobanErrorDecoder {
  /**
   * Determine whether an error represents a Soroban panic or trap.
   */
  static isPanic(error: unknown): boolean {
    const raw = extractRawString(error);
    if (!raw) return false;
    if (/panic|trap|unreachable|overflow|hosterror|error\s*\(\s*(wasmvm|context|budget|contract|storage|auth)/i.test(raw)) {
      return true;
    }
    return false;
  }

  /**
   * Decode a Soroban panic or VM trap into structured info.
   * If the panic format is unknown, falls back to a generic invocation failed message.
   */
  static decode(error: unknown): DecodedPanic {
    const rawStr = extractRawString(error);

    // 1. Check for contract error code: Error(Contract, #123)
    const codeMatch = CONTRACT_CODE_REGEX.exec(rawStr);
    const code = codeMatch?.[1];

    // 2. Check for Rust panic syntax: panicked at '...'
    const rustMatch = RUST_PANIC_REGEX.exec(rawStr);
    if (rustMatch) {
      const reason = rustMatch[1] || rustMatch[2] || "explicit panic";
      const location = rustMatch[3] ? ` at ${rustMatch[3]}` : "";
      return {
        isPanic: true,
        type: "rust_panic",
        description: `Contract panicked${location}: "${reason.trim()}"`,
        ...(code !== undefined ? { code } : {}),
        raw: error,
      };
    }

    // 3. Check for specific WASM VM traps
    for (const trap of KNOWN_WASM_TRAPS) {
      if (trap.pattern.test(rawStr)) {
        return {
          isPanic: true,
          type: "wasm_trap",
          description: trap.description,
          ...(code !== undefined ? { code } : {}),
          raw: error,
        };
      }
    }

    // 4. Check for known Host error codes / traps
    for (const host of KNOWN_HOST_TRAPS) {
      if (host.pattern.test(rawStr)) {
        return {
          isPanic: true,
          type: host.type,
          description: host.description,
          ...(code !== undefined ? { code } : {}),
          raw: error,
        };
      }
    }

    // 5. Check if it explicitly contains "panic" or "trap" or "HostError"
    if (this.isPanic(error)) {
      return {
        isPanic: true,
        type: "unknown",
        description: rawStr
          ? `Contract trapped with panic: ${rawStr}`
          : "Contract invocation failed (unknown panic format).",
        ...(code !== undefined ? { code } : {}),
        raw: error,
      };
    }

    // 6. Fallback for generic/unknown errors
    return {
      isPanic: false,
      type: "unknown",
      description: rawStr || "Contract invocation failed.",
      ...(code !== undefined ? { code } : {}),
      raw: error,
    };
  }

  /**
   * Convenience helper to return just the human-readable decoded description.
   */
  static decodePanic(error: unknown): string {
    return this.decode(error).description;
  }
}

/**
 * Functional wrapper for SorobanErrorDecoder.decode.
 */
export function decodeSorobanPanic(error: unknown): DecodedPanic {
  return SorobanErrorDecoder.decode(error);
}
