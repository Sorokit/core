import type { xdr } from "@stellar/stellar-sdk";

export interface ArgumentEncodingStats {
  argumentCount: number;
  encodedBytes: number;
  uniqueEncodedBytes: number;
  repeatedValues: number;
  reusedValues: number;
}

export interface OptimizedContractArgs {
  args: readonly xdr.ScVal[];
  stats: ArgumentEncodingStats;
}

function encodedKey(value: xdr.ScVal): string {
  return value.toXDR("base64");
}

/**
 * Optimize a positional ScVal argument list without changing its meaning.
 *
 * Soroban arguments are positional, so duplicate values cannot be removed from
 * the wire payload. The safe optimization is to canonicalize and reuse the
 * same immutable ScVal instance during preparation, while exposing the exact
 * repetition overhead so callers can choose a compact contract-level struct
 * when the ABI permits it.
 */
export function optimizeContractArgs(args: readonly xdr.ScVal[]): OptimizedContractArgs {
  const cache = new Map<string, xdr.ScVal>();
  const optimized: xdr.ScVal[] = [];
  let encodedBytes = 0;
  let uniqueEncodedBytes = 0;
  let repeatedValues = 0;

  for (const arg of args) {
    const key = encodedKey(arg);
    const bytes = Buffer.byteLength(key, "base64");
    encodedBytes += bytes;
    const existing = cache.get(key);
    if (existing) {
      optimized.push(existing);
      repeatedValues += 1;
    } else {
      cache.set(key, arg);
      optimized.push(arg);
      uniqueEncodedBytes += bytes;
    }
  }

  return {
    args: Object.freeze(optimized),
    stats: {
      argumentCount: args.length,
      encodedBytes,
      uniqueEncodedBytes,
      repeatedValues,
      reusedValues: repeatedValues,
    },
  };
}

export function analyzeArgumentEncoding(args: readonly xdr.ScVal[]): ArgumentEncodingStats {
  return optimizeContractArgs(args).stats;
}
