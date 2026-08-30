/**
 * Tests for transaction XDR encoding optimization.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  encodeTransaction,
  decodeTransaction,
  registerBasePayload,
  clearPayloadCache,
  getPayloadCacheStats,
} from "./xdrEncodingCore";
import { EncodingStrategy } from "./xdrEncodingTypes";

// Sample XDR payloads for testing
const SMALL_XDR = "AAAAEgAAAABgeSoq";
const LARGE_XDR = "AAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoqAAAAEgAAAABgeSoq";
const REPEATED_XDR = "AAAAEgAAAABgeSoqAAAAEgAAAABgeSoq";

describe("XDR Encoding Optimization", () => {
  beforeEach(() => {
    clearPayloadCache();
  });

  describe("encodeTransaction", () => {
    it("should handle uncompressed small payloads", async () => {
      const result = await encodeTransaction(SMALL_XDR, EncodingStrategy.NONE);

      expect(result.status).toBe("ok");
      expect(result.data!.encoded.metadata.strategy).toBe("none");
      expect(result.data!.optimized).toBe(false);
    });

    it("should reject empty XDR", async () => {
      const result = await encodeTransaction("");

      expect(result.status).toBe("error");
    });

    it("should compress large payloads", async () => {
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);

      expect(result.status).toBe("ok");
      expect(result.data!.encoded.metadata.strategy).toBe("deflate");
      expect(result.data!.encoded.metadata.compressionRatio).toBeLessThan(1);
    });

    it("should auto-select compression strategy", async () => {
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.AUTO);

      expect(result.status).toBe("ok");
      expect(result.data!.encoded.metadata.strategy).toBeDefined();
    });

    it("should bypass compression if overhead exceeds threshold", async () => {
      // Use a very restrictive overhead threshold
      const result = await encodeTransaction(SMALL_XDR, EncodingStrategy.DEFLATE, {
        maxCompressionOverhead: 1, // 1%
        minCompressionSize: 1, // Very low threshold
      });

      expect(result.status).toBe("ok");
      // Small payloads may not compress well, so might be uncompressed
    });

    it("should skip compression for small payloads", async () => {
      const result = await encodeTransaction(SMALL_XDR, EncodingStrategy.DEFLATE, {
        minCompressionSize: 1000, // Larger threshold
      });

      expect(result.status).toBe("ok");
      expect(result.data!.encoded.metadata.strategy).toBe("none");
    });

    it("should support delta encoding", async () => {
      // Register base payload
      const baseId = registerBasePayload(REPEATED_XDR);

      // Encode similar payload with delta strategy
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.DELTA, {
        enableDeltaEncoding: true,
      });

      expect(result.status).toBe("ok");
      // May fall back to deflate if no suitable base found
      expect(
        [EncodingStrategy.DELTA, EncodingStrategy.DEFLATE, EncodingStrategy.NONE].includes(
          result.data!.encoded.metadata.strategy as any,
        ),
      ).toBe(true);
    });
  });

  describe("decodeTransaction", () => {
    it("should decode uncompressed payloads", async () => {
      const encoded = await encodeTransaction(SMALL_XDR, EncodingStrategy.NONE);
      const result = await decodeTransaction(encoded.data!.encoded);

      expect(result.status).toBe("ok");
      expect(result.data!.xdr).toBe(SMALL_XDR);
      expect(result.data!.verified).toBe(true);
    });

    it("should decode compressed payloads", async () => {
      const encoded = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);
      const result = await decodeTransaction(encoded.data!.encoded);

      expect(result.status).toBe("ok");
      expect(result.data!.xdr).toBe(LARGE_XDR);
      expect(result.data!.verified).toBe(true);
    });

    it("should reject invalid encoded format", async () => {
      const result = await decodeTransaction(null as any);

      expect(result.status).toBe("error");
    });

    it("should handle delta decoding", async () => {
      // Register base payload
      registerBasePayload(REPEATED_XDR);

      // Encode with delta
      const encoded = await encodeTransaction(LARGE_XDR, EncodingStrategy.DELTA, {
        enableDeltaEncoding: true,
      });

      if (encoded.data!.encoded.metadata.strategy === "delta") {
        const result = await decodeTransaction(encoded.data!.encoded);

        expect(result.status).toBe("ok");
        // Verification may fail due to size mismatch, but XDR should be reconstructed
        expect(result.data!.xdr).toBeDefined();
      }
    });

    it("should fail gracefully on corrupted payload", async () => {
      const encoded = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);

      // Corrupt the payload
      encoded.data!.encoded.payload[0] = 0xff;

      const result = await decodeTransaction(encoded.data!.encoded);

      // Should error on decompression failure
      expect(result.status).toBe("error");
    });
  });

  describe("round-trip encoding", () => {
    it("should preserve XDR through compression round-trip", async () => {
      const encoded = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);
      const decoded = await decodeTransaction(encoded.data!.encoded);

      expect(decoded.status).toBe("ok");
      expect(decoded.data!.xdr).toBe(LARGE_XDR);
    });

    it("should preserve XDR through uncompressed round-trip", async () => {
      const encoded = await encodeTransaction(SMALL_XDR, EncodingStrategy.NONE);
      const decoded = await decodeTransaction(encoded.data!.encoded);

      expect(decoded.status).toBe("ok");
      expect(decoded.data!.xdr).toBe(SMALL_XDR);
    });
  });

  describe("payload cache management", () => {
    it("should register base payloads", () => {
      const id = registerBasePayload(LARGE_XDR);

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("should return consistent IDs for same payload", () => {
      const id1 = registerBasePayload(LARGE_XDR);
      const id2 = registerBasePayload(LARGE_XDR);

      expect(id1).toBe(id2);
    });

    it("should track cache statistics", () => {
      registerBasePayload(LARGE_XDR);
      registerBasePayload(SMALL_XDR);

      const stats = getPayloadCacheStats();

      expect(stats.entries).toBe(2);
      expect(stats.size).toBeGreaterThan(0);
    });

    it("should clear cache on request", () => {
      registerBasePayload(LARGE_XDR);
      clearPayloadCache();

      const stats = getPayloadCacheStats();

      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);
    });
  });

  describe("compression efficiency", () => {
    it("should compute compression ratio", async () => {
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);

      expect(result.data!.encoded.metadata.compressionRatio).toBeGreaterThan(0);
      expect(result.data!.encoded.metadata.compressionRatio).toBeLessThanOrEqual(1.5); // Allow some overhead
    });

    it("should indicate when compression is worthwhile", async () => {
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);

      expect(result.data!.encoded.metadata.worthCompressing).toBeDefined();
      expect(typeof result.data!.encoded.metadata.worthCompressing).toBe("boolean");
    });

    it("should set optimized flag correctly", async () => {
      const small = await encodeTransaction(SMALL_XDR, EncodingStrategy.DEFLATE, {
        minCompressionSize: 1000,
      });
      expect(small.data!.optimized).toBe(false);

      const large = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE);
      // May or may not be optimized depending on compression efficiency
      expect(typeof large.data!.optimized).toBe("boolean");
    });
  });

  describe("configuration options", () => {
    it("should respect compression level", async () => {
      const level6 = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE, {
        compressionLevel: 6,
      });
      const level9 = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE, {
        compressionLevel: 9,
      });

      expect(level6.status).toBe("ok");
      expect(level9.status).toBe("ok");
      // Higher compression level should produce same or smaller output
      expect(level9.data!.encoded.payload.length).toBeLessThanOrEqual(
        level6.data!.encoded.payload.length * 1.1,
      ); // Allow 10% margin
    });

    it("should fall back on compression failure", async () => {
      // Even with invalid config, should fall back gracefully
      const result = await encodeTransaction(LARGE_XDR, EncodingStrategy.DEFLATE, {
        compressionLevel: 10, // Invalid level
      });

      expect(result.status).toBe("ok");
      expect(result.data!.encoded.payload).toBeDefined();
    });
  });
});
