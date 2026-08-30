/**
 * Transaction XDR encoding optimization types.
 * Supports compression and delta-based representations for bandwidth efficiency.
 */

/**
 * Encoding strategy for XDR payloads.
 */
export enum EncodingStrategy {
  /** No compression applied */
  NONE = "none",
  /** DEFLATE compression for large payloads */
  DEFLATE = "deflate",
  /** Delta-based encoding for similar transactions */
  DELTA = "delta",
  /** Composite strategy (best fit selection) */
  AUTO = "auto",
}

/**
 * Metadata describing how a payload was encoded.
 */
export interface EncodingMetadata {
  /** Strategy used for encoding */
  strategy: EncodingStrategy;
  /** Original payload size in bytes */
  originalSize: number;
  /** Encoded payload size in bytes */
  encodedSize: number;
  /** Compression ratio (encodedSize / originalSize) */
  compressionRatio: number;
  /** Whether compression resulted in savings */
  worthCompressing: boolean;
  /** Optional base payload ID for delta encoding */
  basePayloadId?: string;
}

/**
 * Encoded transaction payload.
 */
export interface EncodedTransaction {
  /** The encoded payload (bytes) */
  payload: Buffer;
  /** Metadata describing the encoding */
  metadata: EncodingMetadata;
}

/**
 * Delta representation between two similar transactions.
 */
export interface TransactionDelta {
  /** ID of the base transaction */
  basePayloadId: string;
  /** Differences from base transaction (compressed) */
  differences: Buffer;
  /** Hash of the base transaction for validation */
  baseHash: string;
}

/**
 * Configuration for encoding operations.
 */
export interface EncodingConfig {
  /** Minimum payload size to consider for compression (bytes) */
  minCompressionSize?: number;
  /** Maximum compression overhead threshold (percentage) */
  maxCompressionOverhead?: number;
  /** Enable delta-based encoding for similar payloads */
  enableDeltaEncoding?: boolean;
  /** Compression level (0-9) for DEFLATE */
  compressionLevel?: number;
}

/**
 * Result of encoding operation.
 */
export interface EncodingResult {
  encoded: EncodedTransaction;
  /** Whether encoding resulted in smaller payload */
  optimized: boolean;
  /** Original XDR (if fallback to uncompressed) */
  originalXdr?: string;
}

/**
 * Decoding result.
 */
export interface DecodingResult {
  /** Decoded XDR string */
  xdr: string;
  /** Verification status */
  verified: boolean;
  /** Error message if verification failed */
  verificationError?: string;
}
