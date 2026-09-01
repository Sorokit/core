/**
 * Contract state optimization (fix.md).
 *
 * Utilities that reduce the serialization overhead of large contract state
 * payloads before storage or transmission, while keeping compression
 * transparent to consumers: callers write optimized state and read back the
 * original logical representation without manually handling decompression.
 *
 * Design principles
 * -----------------
 * - Correctness and compatibility take priority over maximum compression.
 *   Not every Soroban storage value should be shrunk: unsupported values
 *   fail safely instead of producing corrupted output.
 * - Serialization is deterministic: object keys are canonicalized (sorted) at
 *   every depth so two structurally equal states encode byte-for-byte the
 *   same regardless of insertion order.
 * - Caller-owned state is never mutated. Encoding only reads the input, and
 *   decoding builds entirely new objects.
 * - Metadata identifies the encoding and compression strategy, the measured
 *   sizes, and a fingerprint so integrity can be verified on read.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";
import { err, ok } from "../shared/response";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The compact, tagged encoding used for optimized state. */
export type StateEncoding = "tagged";

/** Compression applied to the encoded bytes before returning them. */
export type StateCompression = "none" | "gzip";

export interface ContractStateOptimizeOptions {
  /**
   * Whether to gzip the encoded bytes. `"auto"` (default) compresses only
   * when the optimized encoding is at least `minCompressBytes` long, so tiny
   * payloads stay uncompressed and deterministic. `"none"` never compresses.
   */
  compression?: "none" | "auto";
  /** Minimum encoded byte length before `"auto"` applies gzip (default: 64). */
  minCompressBytes?: number;
  /** Gzip compression level 0-9 (default: 6). Only used when compressing. */
  level?: number;
}

/**
 * Describes how an optimized state payload was encoded and how much smaller
 * it is than the canonical representation of the original state.
 */
export interface ContractStateMetadata {
  /** Fixed format marker so readers can detect the payload kind. */
  format: "contract-state-optimized";
  /** Format version. Bumping this invalidates decoding of older payloads. */
  version: 1;
  /** The state-encoding strategy that produced `data`. */
  encoding: StateEncoding;
  /** The compression applied to the encoding. */
  compression: StateCompression;
  /** Byte length of the canonical (order-independent) representation. */
  originalBytes: number;
  /** Byte length of the optimized encoding before compression. */
  encodedBytes: number;
  /** Byte length actually stored in `data` (after compression). */
  finalBytes: number;
  /** `finalBytes / originalBytes`; 0 means fully compressed, 1 means none. */
  ratio: number;
  /** Percentage of the original size saved, floored at 0 (0-100). */
  savingsPercent: number;
  /** Deterministic fingerprint of the canonical state for integrity checks. */
  hash: string;
  /** Number of top-level state entries. */
  entries: number;
}

/** The compressed/encoded payload returned by {@link compressContractState}. */
export interface OptimizedContractState {
  /** Encoded (and optionally compressed) bytes. */
  data: Uint8Array;
  /** Metadata needed to decode `data` and report size savings. */
  metadata: ContractStateMetadata;
}

// ─── Error helpers ────────────────────────────────────────────────────────────

const UNSUPPORTED = (value: unknown, path: string): SorokitResult<never> => {
  const type = value === null ? "null" : typeof value;
  const desc =
    typeof value === "object"
      ? value instanceof Uint8Array
        ? "bytes"
        : "non-serializable object"
      : type;
  return err(
    SorokitErrorCode.INVALID_CONFIG,
    `compressContractState: unsupported value of kind "${desc}" at "${path}". ` +
      "Supported values are null, booleans, finite numbers, bigints, strings, " +
      "byte arrays, arrays, and plain objects. Refusing rather than corrupting state.",
    undefined,
  );
};

// ─── Canonical representation (deterministic size + fingerprint) ──────────────

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "bigint") return `"#bigint:${value.toString()}#"`;
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return `"#bytes:${Buffer.from(value).toString("base64")}#"`;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5n;
  const PRIME = 0x01000193n;
  const MASK = 0xffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash ^ BigInt(input.charCodeAt(index))) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── Byte writer / reader ─────────────────────────────────────────────────────

class ByteWriter {
  private buf = new Uint8Array(64);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < this.len + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }

  /** Unsigned base-128 little-endian varint (arbitrary precision bigint). */
  varint(value: bigint): void {
    let v = value < 0n ? 0n : value;
    if (v < 0n) v = BigInt.asUintN(64, v);
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        this.byte(byte);
        break;
      }
      this.byte(byte | 0x80);
    }
  }

  /** Zigzag then varint (arbitrary precision). */
  zzvarint(value: bigint): void {
    const zig = value < 0n ? ((-value) << 1n) - 1n : value << 1n;
    this.varint(zig);
  }

  float64(value: number): void {
    const tmp = new Uint8Array(8);
    new DataView(tmp.buffer).setFloat64(0, value, true);
    this.bytes(tmp);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("unexpected end of payload");
    const value = this.buf[this.pos];
    if (value === undefined) throw new Error("unexpected end of payload");
    this.pos += 1;
    return value;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("unexpected end of payload");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.byte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  zzvarint(): bigint {
    const zz = this.varint();
    return (zz >> 1n) ^ -(zz & 1n);
  }

  float64(): number {
    const value = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
    ).getFloat64(0, true);
    this.pos += 8;
    return value;
  }
}

// ─── Tagged encoder ───────────────────────────────────────────────────────────

const TAG_NULL = 0x00;
const TAG_TRUE = 0x01;
const TAG_FALSE = 0x02;
const TAG_STRING = 0x03;
const TAG_INT = 0x04;
const TAG_BIGINT = 0x05;
const TAG_BYTES = 0x06;
const TAG_DOUBLE = 0x07;
const TAG_ARRAY = 0x08;
const TAG_OBJECT = 0x09;

type EncodeResult = SorokitResult<Uint8Array>;

function encodeTagged(state: Record<string, unknown>): EncodeResult {
  const writer = new ByteWriter();
  const seen = new Set<object>();

  const encodeValue = (value: unknown, path: string): string | null => {
    if (value === null) {
      writer.byte(TAG_NULL);
      return null;
    }
    if (typeof value === "boolean") {
      writer.byte(value ? TAG_TRUE : TAG_FALSE);
      return null;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return UNSUPPORTED(value, path).error!.message;
      }
      if (Number.isInteger(value) && Number.isSafeInteger(value)) {
        writer.byte(TAG_INT);
        writer.zzvarint(BigInt(value));
      } else {
        writer.byte(TAG_DOUBLE);
        writer.float64(value);
      }
      return null;
    }
    if (typeof value === "bigint") {
      writer.byte(TAG_BIGINT);
      writer.zzvarint(value);
      return null;
    }
    if (typeof value === "string") {
      const bytes = Buffer.from(value, "utf8");
      writer.byte(TAG_STRING);
      writer.varint(BigInt(bytes.length));
      writer.bytes(bytes);
      return null;
    }
    if (typeof value !== "object") {
      return UNSUPPORTED(value, path).error!.message;
    }
    if (value instanceof Uint8Array) {
      writer.byte(TAG_BYTES);
      writer.varint(BigInt(value.length));
      writer.bytes(value);
      return null;
    }
    if (seen.has(value)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `compressContractState: circular reference detected at "${path}".`,
      ).error!.message;
    }

    seen.add(value);
    let result: string | null = null;
    if (Array.isArray(value)) {
      writer.byte(TAG_ARRAY);
      writer.varint(BigInt(value.length));
      for (let i = 0; i < value.length; i++) {
        result = encodeValue(value[i], `${path}[${i}]`);
        if (result !== null) break;
      }
    } else {
      const proxy = value as Record<string, unknown>;
      const keys = Object.keys(proxy).sort();
      writer.byte(TAG_OBJECT);
      writer.varint(BigInt(keys.length));
      for (const key of keys) {
        result = encodeKey(key) ?? encodeValue(proxy[key], `${path}.${key}`);
        if (result !== null) break;
      }
    }
    seen.delete(value);
    return result;
  };

  const encodeKey = (key: string): string | null => {
    const bytes = Buffer.from(key, "utf8");
    writer.byte(TAG_STRING);
    writer.varint(BigInt(bytes.length));
    writer.bytes(bytes);
    return null;
  };

  const entries = Object.keys(state).sort();
  writer.byte(TAG_OBJECT);
  writer.varint(BigInt(entries.length));
  for (const key of entries) {
    const keyError = encodeKey(key);
    if (keyError !== null) return err(SorokitErrorCode.INVALID_CONFIG, keyError);
    const valueError = encodeValue(state[key], key);
    if (valueError !== null) {
      return err(SorokitErrorCode.INVALID_CONFIG, valueError);
    }
  }

  return ok(writer.finish());
}

// ─── Tagged decoder ───────────────────────────────────────────────────────────

type DecodeResult = SorokitResult<unknown>;

function decodeTagged(data: Uint8Array): DecodeResult {
  const reader = new ByteReader(data);

  const decodeValue = (): { value: unknown; error?: string } => {
    const tag = reader.byte();
    switch (tag) {
      case TAG_NULL:
        return { value: null };
      case TAG_TRUE:
        return { value: true };
      case TAG_FALSE:
        return { value: false };
      case TAG_INT:
        return { value: Number(reader.zzvarint()) };
      case TAG_BIGINT:
        return { value: reader.zzvarint() };
      case TAG_DOUBLE:
        return { value: reader.float64() };
      case TAG_STRING: {
        const len = Number(reader.varint());
        return { value: Buffer.from(reader.bytes(len)).toString("utf8") };
      }
      case TAG_BYTES: {
        const len = Number(reader.varint());
        return { value: reader.bytes(len) };
      }
      case TAG_ARRAY: {
        const count = Number(reader.varint());
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) {
          const item = decodeValue();
          if (item.error !== undefined) return item;
          arr.push(item.value);
        }
        return { value: arr };
      }
      case TAG_OBJECT: {
        const count = Number(reader.varint());
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const keyResult = decodeValue();
          if (keyResult.error !== undefined) return keyResult;
          if (typeof keyResult.value !== "string") {
            return { value: undefined, error: "decodeContractState: invalid object key in payload." };
          }
          const valueResult = decodeValue();
          if (valueResult.error !== undefined) return valueResult;
          obj[keyResult.value] = valueResult.value;
        }
        return { value: obj };
      }
      default:
        return {
          value: undefined,
          error: `decodeContractState: unknown tag ${tag}; payload may be corrupted or from a newer version.`,
        };
    }
  };

  try {
    const root = decodeValue();
    if (root.error !== undefined) {
      return err(SorokitErrorCode.CONTRACT_READ_FAILED, root.error);
    }
    if (typeof root.value !== "object" || root.value === null || Array.isArray(root.value)) {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        "decodeContractState: root value is not a state object.",
      );
    }
    return ok(root.value as Record<string, unknown>);
  } catch {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      "decodeContractState: truncated or corrupted payload.",
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DEFAULT_MIN_COMPRESS_BYTES = 64;
const DEFAULT_GZIP_LEVEL = 6;

/**
 * Optimize a contract state payload for storage or transmission.
 *
 * The state is first deterministically encoded with a compact tagged binary
 * encoding that efficiently represents common primitive and structured values
 * (integers, bigints, strings, byte arrays, arrays, objects). When
 * `compression` is `"auto"` and the encoding is large enough, the bytes are
 * then gzipped. The returned metadata records the strategy and the measured
 * sizes so savings can be reported and the payload decoded later.
 *
 * The input state is never mutated, and unsupported values cause a safe error
 * rather than corrupted output.
 *
 * @param state - The contract state to optimize. Must be a plain object of
 *   deterministic values.
 * @param options - Optimization options.
 * @returns The encoded bytes plus descriptive metadata, or an error.
 */
export function compressContractState(
  state: Readonly<Record<string, unknown>>,
  options: ContractStateOptimizeOptions = {},
): SorokitResult<OptimizedContractState> {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "compressContractState: state must be a plain object.",
    );
  }

  // Validate and encode first. The encoder rejects unsupported values and
  // circular references, guaranteeing canonicalize below only ever sees safe
  // (deterministic) input.
  const encodedResult = encodeTagged(state as Record<string, unknown>);
  if (encodedResult.status === "error") return encodedResult;
  const encoded = encodedResult.data;
  const encodedBytes = encoded.length;
  const canonical = canonicalize(state);
  const originalBytes = new TextEncoder().encode(canonical).byteLength;

  const compressionMode = options.compression ?? "auto";
  const minCompressBytes = Math.max(0, options.minCompressBytes ?? DEFAULT_MIN_COMPRESS_BYTES);
  const shouldCompress = compressionMode === "none" ? false : encodedBytes >= minCompressBytes;

  let finalBytes = encodedBytes;
  let data = encoded;
  let compression: StateCompression = "none";
  if (shouldCompress) {
    try {
      data = gzipSync(encoded, {
        level: options.level ?? DEFAULT_GZIP_LEVEL,
        // mtime: 0 keeps gzip output deterministic across runs.
        mtime: 0,
      } as ZlibOptions);
      compression = "gzip";
      finalBytes = data.length;
    } catch {
      // Compression must never corrupt output; fall back to uncompressed.
      data = encoded;
      compression = "none";
      finalBytes = encodedBytes;
    }
  }

  const ratio = originalBytes === 0 ? 0 : finalBytes / originalBytes;
  const savingsPercent = originalBytes === 0 ? 0 : Math.max(0, (1 - ratio) * 100);

  return ok({
    data,
    metadata: {
      format: "contract-state-optimized",
      version: 1,
      encoding: "tagged",
      compression,
      originalBytes,
      encodedBytes,
      finalBytes,
      ratio,
      savingsPercent,
      hash: fnv1a(canonical),
      entries: Object.keys(state).length,
    },
  });
}

/**
 * Restore the original logical state from an optimized payload.
 *
 * Decoding uses the strategy recorded in the metadata and verifies the payload
 * against the stored fingerprint, failing safely (with an error) rather than
 * returning corrupted state when the payload is damaged, truncated, or from an
 * unsupported format version.
 *
 * @param data - The bytes produced by {@link compressContractState}.
 * @param metadata - The metadata returned alongside those bytes.
 * @returns The restored state object, or an error.
 */
export function decompressContractState(
  data: Uint8Array,
  metadata: ContractStateMetadata,
): SorokitResult<Record<string, unknown>> {
  if (metadata.format !== "contract-state-optimized") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "decompressContractState: unrecognized payload format.",
    );
  }
  if (metadata.version !== 1) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `decompressContractState: unsupported format version ${metadata.version}.`,
    );
  }
  if (metadata.encoding !== "tagged") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `decompressContractState: unsupported encoding "${metadata.encoding}".`,
    );
  }

  let encoded: Uint8Array;
  if (metadata.compression === "gzip") {
    try {
      encoded = gunzipSync(data);
    } catch {
      return err(
        SorokitErrorCode.CONTRACT_READ_FAILED,
        "decompressContractState: failed to decompress gzip payload; data may be corrupted.",
      );
    }
  } else if (metadata.compression === "none") {
    encoded = data;
  } else {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `decompressContractState: unsupported compression "${metadata.compression}".`,
    );
  }

  const decoded = decodeTagged(encoded);
  if (decoded.status === "error") return decoded;
  const state = decoded.data as Record<string, unknown>;

  // Integrity check: the decoded state must match the recorded fingerprint.
  const actualHash = fnv1a(canonicalize(state));
  if (actualHash !== metadata.hash) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      "decompressContractState: payload fingerprint mismatch; state does not match the recorded metadata.",
    );
  }

  return ok(state);
}

// ─── Measurement + benchmarks ─────────────────────────────────────────────────

export interface ContractStateSizeReport {
  originalBytes: number;
  encodedBytes: number;
  compressedBytes: number;
  ratio: number;
  savingsPercent: number;
  entries: number;
}

/**
 * Measure the size of a contract state under the optimized encoding and the
 * savings it would yield versus its canonical representation, without writing
 * state. See {@link compressContractState} for supported value types.
 */
export function measureContractState(
  state: Readonly<Record<string, unknown>>,
): SorokitResult<ContractStateSizeReport> {
  const encodedResult = encodeTagged(state as Record<string, unknown>);
  if (encodedResult.status === "error") return encodedResult;
  const encodedBytes = encodedResult.data.length;
  const canonicalBytes = new TextEncoder().encode(canonicalize(state)).byteLength;

  let compressedBytes = encodedBytes;
  try {
    compressedBytes = gzipSync(encodedResult.data, {
      level: DEFAULT_GZIP_LEVEL,
      mtime: 0,
    } as ZlibOptions).length;
  } catch {
    compressedBytes = encodedBytes;
  }

  const ratio = canonicalBytes === 0 ? 0 : compressedBytes / canonicalBytes;
  return ok({
    originalBytes: canonicalBytes,
    encodedBytes,
    compressedBytes,
    ratio,
    savingsPercent: canonicalBytes === 0 ? 0 : Math.max(0, (1 - ratio) * 100),
    entries: Object.keys(state).length,
  });
}

export interface CompressionBenchmark {
  /** Number of compress/decompress iterations measured. */
  iterations: number;
  compressMs: number;
  decompressMs: number;
  /** Total round-trip time in ms. */
  totalMs: number;
  /** Optimized payload size in bytes. */
  payloadBytes: number;
  /** Compressed size ratio (final / canonical original). */
  ratio: number;
  /** Per-operation mean latency in milliseconds. */
  compressMeanMs: number;
  decompressMeanMs: number;
}

/**
 * Benchmark {@link compressContractState} and {@link decompressContractState}
 * against a representative state payload.
 *
 * @param state - The state to benchmark.
 * @param iterations - Number of compress/decompress rounds (default: 100).
 * @returns Aggregate timing and size statistics.
 */
export function benchmarkContractState(
  state: Readonly<Record<string, unknown>>,
  iterations = 100,
): SorokitResult<CompressionBenchmark> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "benchmarkContractState: iterations must be a positive integer.",
    );
  }

  let compressed: OptimizedContractState | undefined;
  const compressStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = compressContractState(state);
    if (result.status === "error") return result;
    compressed = result.data;
  }
  const compressMs = performance.now() - compressStart;

  const decompressStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = decompressContractState(compressed!.data, compressed!.metadata);
    if (result.status === "error") return result;
  }
  const decompressMs = performance.now() - decompressStart;

  const metadata = compressed!.metadata;
  return ok({
    iterations,
    compressMs,
    decompressMs,
    totalMs: compressMs + decompressMs,
    payloadBytes: metadata.finalBytes,
    ratio: metadata.ratio,
    compressMeanMs: compressMs / iterations,
    decompressMeanMs: decompressMs / iterations,
  });
}
