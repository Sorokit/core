/**
 * XDR encoding optimization for bandwidth efficiency.
 * Provides compression, delta-based encoding, and decompression utilities.
 */

import zlib from "zlib";
import crypto from "crypto";
import type {
  EncodedTransaction,
  EncodingMetadata,
  EncodingStrategy,
  EncodingConfig,
  EncodingResult,
  DecodingResult,
  TransactionDelta,
} from "./xdrEncodingTypes";
import { SorokitErrorCode, err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// Default configuration
const DEFAULT_CONFIG: Required<EncodingConfig> = {
  minCompressionSize: 256, // Only compress if larger than 256 bytes
  maxCompressionOverhead: 10, // Don't compress if overhead > 10%
  enableDeltaEncoding: true,
  compressionLevel: 6,
};

/**
 * In-memory cache for base payloads (used for delta encoding).
 * In production, this would be persisted.
 */
const payloadCache = new Map<string, { xdr: string; hash: string }>();

/**
 * Creates a hash of a payload for identification.
 */
function createPayloadHash(data: string | Buffer): string {
  if (typeof data === "string") {
    data = Buffer.from(data, "utf-8");
  }
  return crypto.createHash("sha256").update(data).digest("hex").substring(0, 16);
}

/**
 * Compresses data using DEFLATE.
 */
function deflateCompress(
  data: Buffer,
  level: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.deflate(data, { level }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Decompresses DEFLATE-compressed data.
 */
function deflateDecompress(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.inflate(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Computes differences between two XDR strings for delta encoding.
 */
function computeDelta(baseXdr: string, currentXdr: string): Buffer {
  // Simple delta representation: store differences as JSON
  const baseBuf = Buffer.from(baseXdr, "utf-8");
  const currentBuf = Buffer.from(currentXdr, "utf-8");

  // Find common prefix
  let i = 0;
  while (i < baseBuf.length && i < currentBuf.length && baseBuf[i] === currentBuf[i]) {
    i++;
  }

  // Encode: [prefix_length][changes]
  const delta = {
    prefixLen: i,
    changes: currentBuf.subarray(i).toString("base64"),
  };

  return Buffer.from(JSON.stringify(delta), "utf-8");
}

/**
 * Applies a delta to reconstruct the original XDR.
 */
function applyDelta(baseXdr: string, delta: Buffer): string {
  const deltaObj = JSON.parse(delta.toString("utf-8"));
  const baseBuf = Buffer.from(baseXdr, "utf-8");
  const changes = Buffer.from(deltaObj.changes, "base64");

  const reconstructed = Buffer.concat([
    baseBuf.subarray(0, deltaObj.prefixLen),
    changes,
  ]);

  return reconstructed.toString("utf-8");
}

/**
 * Encodes an XDR transaction using the specified strategy.
 */
export async function encodeTransaction(
  xdr: string,
  strategy: EncodingStrategy = "auto",
  config?: EncodingConfig,
): Promise<SorokitResult<EncodingResult>> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (!xdr || typeof xdr !== "string") {
    return err<EncodingResult>(
      SorokitErrorCode.INVALID_CONFIG,
      "XDR must be a non-empty string",
    );
  }

  const xdrBuffer = Buffer.from(xdr, "utf-8");
  const originalSize = xdrBuffer.length;

  // Check if compression is worth it
  if (originalSize < fullConfig.minCompressionSize) {
    return ok({
      optimized: false,
      encoded: {
        payload: xdrBuffer,
        metadata: {
          strategy: "none",
          originalSize,
          encodedSize: originalSize,
          compressionRatio: 1,
          worthCompressing: false,
        },
      },
      originalXdr: xdr,
    });
  }

  let selectedStrategy = strategy;
  if (strategy === "auto") {
    // Auto-select best strategy
    selectedStrategy = fullConfig.enableDeltaEncoding ? "deflate" : "deflate";
  }

  try {
    if (selectedStrategy === "deflate") {
      const compressed = await deflateCompress(xdrBuffer, fullConfig.compressionLevel);
      const compressionRatio = compressed.length / originalSize;
      const overhead = (compressed.length - originalSize) / originalSize;

      // Check if compression overhead is acceptable
      if (overhead > fullConfig.maxCompressionOverhead / 100 && originalSize > fullConfig.minCompressionSize) {
        return ok({
          optimized: false,
          encoded: {
            payload: xdrBuffer,
            metadata: {
              strategy: "none",
              originalSize,
              encodedSize: originalSize,
              compressionRatio: 1,
              worthCompressing: false,
            },
          },
          originalXdr: xdr,
        });
      }

      const metadata: EncodingMetadata = {
        strategy: "deflate",
        originalSize,
        encodedSize: compressed.length,
        compressionRatio,
        worthCompressing: compressed.length < originalSize,
      };

      return ok({
        optimized: compressed.length < originalSize,
        encoded: {
          payload: compressed,
          metadata,
        },
      });
    } else if (selectedStrategy === "delta" && fullConfig.enableDeltaEncoding) {
      // Find a suitable base payload
      let bestBase: { id: string; xdr: string; similarity: number } | null = null;

      for (const [id, { xdr: baseXdr }] of payloadCache.entries()) {
        // Simple similarity: count matching characters at start
        let matches = 0;
        for (let i = 0; i < Math.min(xdr.length, baseXdr.length); i++) {
          if (xdr[i] === baseXdr[i]) matches++;
          else break;
        }
        const similarity = matches / baseXdr.length;
        if (similarity > 0.8) {
          if (!bestBase || similarity > bestBase.similarity) {
            bestBase = { id, xdr: baseXdr, similarity };
          }
        }
      }

      if (bestBase) {
        const deltaBuffer = computeDelta(bestBase.xdr, xdr);
        const metadata: EncodingMetadata = {
          strategy: "delta",
          originalSize,
          encodedSize: deltaBuffer.length,
          compressionRatio: deltaBuffer.length / originalSize,
          worthCompressing: deltaBuffer.length < originalSize,
          basePayloadId: bestBase.id,
        };

        return ok({
          optimized: deltaBuffer.length < originalSize,
          encoded: {
            payload: deltaBuffer,
            metadata,
          },
        });
      }

      // Fall back to deflate if no suitable base
      const compressed = await deflateCompress(xdrBuffer, fullConfig.compressionLevel);
      const metadata: EncodingMetadata = {
        strategy: "deflate",
        originalSize,
        encodedSize: compressed.length,
        compressionRatio: compressed.length / originalSize,
        worthCompressing: compressed.length < originalSize,
      };

      return ok({
        optimized: compressed.length < originalSize,
        encoded: {
          payload: compressed,
          metadata,
        },
      });
    }

    // Default: no compression
    return ok({
      optimized: false,
      encoded: {
        payload: xdrBuffer,
        metadata: {
          strategy: "none",
          originalSize,
          encodedSize: originalSize,
          compressionRatio: 1,
          worthCompressing: false,
        },
      },
      originalXdr: xdr,
    });
  } catch (error) {
    // Compression failed, fall back to uncompressed
    return ok({
      optimized: false,
      encoded: {
        payload: xdrBuffer,
        metadata: {
          strategy: "none",
          originalSize,
          encodedSize: originalSize,
          compressionRatio: 1,
          worthCompressing: false,
        },
      },
      originalXdr: xdr,
    });
  }
}

/**
 * Decodes a previously encoded transaction.
 */
export async function decodeTransaction(
  encoded: EncodedTransaction,
): Promise<SorokitResult<DecodingResult>> {
  if (!encoded || !encoded.metadata || !encoded.payload) {
    return err<DecodingResult>(
      SorokitErrorCode.INVALID_CONFIG,
      "Invalid encoded transaction format",
    );
  }

  try {
    let xdr: string;

    if (encoded.metadata.strategy === "none") {
      xdr = encoded.payload.toString("utf-8");
    } else if (encoded.metadata.strategy === "deflate") {
      const decompressed = await deflateDecompress(encoded.payload);
      xdr = decompressed.toString("utf-8");
    } else if (encoded.metadata.strategy === "delta") {
      if (!encoded.metadata.basePayloadId) {
        return err<DecodingResult>(
          SorokitErrorCode.INVALID_CONFIG,
          "Delta encoding missing basePayloadId",
        );
      }

      const baseData = payloadCache.get(encoded.metadata.basePayloadId);
      if (!baseData) {
        return err<DecodingResult>(
          SorokitErrorCode.INVALID_CONFIG,
          `Base payload not found: ${encoded.metadata.basePayloadId}`,
        );
      }

      xdr = applyDelta(baseData.xdr, encoded.payload);
    } else {
      return err<DecodingResult>(
        SorokitErrorCode.INVALID_CONFIG,
        `Unknown encoding strategy: ${encoded.metadata.strategy}`,
      );
    }

    // Verify size
    if (xdr.length !== encoded.metadata.originalSize) {
      return ok({
        xdr,
        verified: false,
        verificationError: `Size mismatch: expected ${encoded.metadata.originalSize}, got ${xdr.length}`,
      });
    }

    return ok({
      xdr,
      verified: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err<DecodingResult>(
      SorokitErrorCode.INVALID_CONFIG,
      `Failed to decode transaction: ${message}`,
    );
  }
}

/**
 * Registers a payload as a potential base for delta encoding.
 */
export function registerBasePayload(xdr: string): string {
  const id = createPayloadHash(xdr);
  payloadCache.set(id, {
    xdr,
    hash: id,
  });
  return id;
}

/**
 * Clears the payload cache.
 */
export function clearPayloadCache(): void {
  payloadCache.clear();
}

/**
 * Gets cache statistics.
 */
export function getPayloadCacheStats(): { size: number; entries: number } {
  let size = 0;
  for (const { xdr } of payloadCache.values()) {
    size += xdr.length;
  }
  return {
    size,
    entries: payloadCache.size,
  };
}
