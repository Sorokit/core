/**
 * Tests for contract state optimization (#514):
 * compressContractState / decompressContractState, along with measurement and
 * benchmark helpers.
 *
 * Covers: primitives, structured values, repetitive data, empty and oversized
 * payloads, unsupported-value safety, no caller-state mutation, deterministic
 * serialization, metadata correctness, round-trip integrity, and performance.
 */

import { describe, it, expect } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import {
  compressContractState,
  decompressContractState,
  measureContractState,
  benchmarkContractState,
} from "../soroban/contractStateOptimization";
import type { ContractStateMetadata } from "../soroban/contractStateOptimization";

function roundTrip(state: Record<string, unknown>, options?: Parameters<typeof compressContractState>[1]) {
  const compressed = compressContractState(state, options);
  if (compressed.status === "error") return compressed;
  const decompressed = decompressContractState(compressed.data.data, compressed.data.metadata);
  return decompressed;
}

function expectOk<T>(result: { status: string; data?: T }): T {
  expect(result.status).toBe("ok");
  return result.data as T;
}

const REPETITIVE_STATE: Record<string, unknown> = {};
for (let i = 0; i < 200; i++) {
  REPETITIVE_STATE[`entry_${i}`] = {
    token: "USDC:GAUY4MS4VJXWU4G7XZQ6YQYQ6YQYQ6YQYQ6YQYQ6YQYQ6YQYQ6YQYQ6YQ",
    amount: "1000000",
    owner: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    active: true,
  };
}

describe("compressContractState / decompressContractState", () => {
  it("round-trips a primitive-only state", () => {
    const state = {
      counter: 42,
      decimal: 3.5,
      big: 123456789012345678901234567890n,
      enabled: true,
      disabled: false,
      empty: null,
      name: "hello",
    };
    const result = roundTrip(state);
    expect(result.status).toBe("ok");
    expect(result.data).toEqual(state);
  });

  it("round-trips nested structured state", () => {
    const state = {
      config: { fee: 100n, pct: 0.05, label: "swap" },
      tags: ["a", "b", "c"],
      matrix: [
        [1, 2],
        [3, 4],
      ],
    };
    const result = roundTrip(state);
    expect(result.status).toBe("ok");
    expect(result.data).toEqual(state);
  });

  it("round-trips byte array values", () => {
    const state = { blob: new Uint8Array([1, 2, 3, 255]), nested: { raw: new Uint8Array([10]) } };
    const result = roundTrip(state);
    expect(result.status).toBe("ok");
    expect(result.data?.blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.data!.blob as Uint8Array)).toEqual([1, 2, 3, 255]);
    expect(Array.from((result.data!.nested as { raw: Uint8Array }).raw)).toEqual([10]);
  });

  it("restores object key order independently (logical equality)", () => {
    const a = roundTrip({ top: { x: 1, y: 2 } });
    const b = roundTrip({ top: { y: 2, x: 1 } });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(a.data).toEqual(b.data);
    expect(a.data).toEqual({ top: { x: 1, y: 2 } });
  });

  it("round-trips an empty state object", () => {
    const result = roundTrip({});
    expect(result.status).toBe("ok");
    expect(result.data).toEqual({});
    expect(expectOk(compressContractState({}))?.metadata.entries).toBe(0);
  });

  it("round-trips a large repetitive payload", () => {
    const result = roundTrip(REPETITIVE_STATE);
    expect(result.status).toBe("ok");
    expect(Object.keys(result.data!).length).toBe(200);
    expect(result.data).toEqual(REPETITIVE_STATE);
  });

  it("randomized large state round-trips exactly", () => {
    const state: Record<string, unknown> = { seed: 1n, list: [], nested: {} };
    for (let i = 0; i < 500; i++) {
      state[`k${i}`] = i % 2 === 0 ? { v: i, s: `str-${i}` } : i;
    }
    const result = roundTrip(state);
    expect(result.status).toBe("ok");
    expect(result.data).toEqual(state);
  });
});

describe("metadata and measurement", () => {
  it("records encoding and compression strategy", () => {
    const metadata = expectOk(compressContractState({ a: 1 }))?.metadata;
    expect(metadata.format).toBe("contract-state-optimized");
    expect(metadata.version).toBe(1);
    expect(metadata.encoding).toBe("tagged");
    expect(metadata.compression).toMatch(/^(none|gzip)$/);
    expect(metadata.entries).toBe(1);
    expect(metadata.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("reports size savings and ratio", () => {
    const compressed = expectOk(compressContractState(REPETITIVE_STATE, { compression: "auto" }));
    const m = compressed.metadata;
    expect(m.originalBytes).toBeGreaterThan(0);
    expect(m.encodedBytes).toBeGreaterThan(0);
    expect(m.finalBytes).toBeGreaterThan(0);
    expect(m.ratio).toBeGreaterThan(0);
    expect(m.ratio).toBeLessThanOrEqual(1);
    expect(m.savingsPercent).toBeGreaterThanOrEqual(0);
    expect(m.savingsPercent).toBeLessThanOrEqual(100);
  });

  it("compresses eligible repetitive payloads (ratio < 1)", () => {
    const compressed = expectOk(compressContractState(REPETITIVE_STATE));
    expect(compressed.metadata.compression).toBe("gzip");
    expect(compressed.metadata.savingsPercent).toBeGreaterThan(0);
  });

  it("leaves tiny payloads uncompressed under auto", () => {
    const compressed = expectOk(compressContractState({ a: 1 }, { compression: "auto" }));
    expect(compressed.metadata.compression).toBe("none");
    expect(compressed.metadata.encodedBytes).toBe(compressed.metadata.finalBytes);
  });

  it("honors the minCompressBytes threshold", () => {
    const compressed = expectOk(
      compressContractState(REPETITIVE_STATE, { compression: "auto", minCompressBytes: 10_000_000 }),
    );
    expect(compressed.metadata.compression).toBe("none");
  });

  it("can be forced to never compress", () => {
    const compressed = expectOk(compressContractState(REPETITIVE_STATE, { compression: "none" }));
    expect(compressed.metadata.compression).toBe("none");
    expect(compressed.metadata.finalBytes).toBe(compressed.metadata.encodedBytes);
    // Still decodable.
    const decoded = decompressContractState(compressed.data, compressed.metadata);
    expect(decoded.status).toBe("ok");
    expect(decoded.data).toEqual(REPETITIVE_STATE);
  });

  it("measureContractState reports sizes without writing state", () => {
    const clean = expectOk(measureContractState(REPETITIVE_STATE));
    expect(clean.originalBytes).toBeGreaterThan(0);
    expect(clean.encodedBytes).toBeGreaterThan(0);
    expect(clean.compressedBytes).toBeGreaterThan(0);
    expect(clean.ratio).toBeGreaterThanOrEqual(0);
    expect(clean.savingsPercent).toBeGreaterThanOrEqual(0);
  });
});

describe("determinism", () => {
  it("produces identical encoded bytes for the same logical state", () => {
    const a = expectOk(compressContractState({ b: 2, a: { x: 1, y: 2 } }, { compression: "none" }));
    const b = expectOk(compressContractState({ a: { y: 2, x: 1 }, b: 2 }, { compression: "none" }));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(a.metadata.hash).toBe(b.metadata.hash);
  });

  it("python-style deterministic gzip output for identical payloads", () => {
    const state = { msg: "hello ".repeat(50) };
    const a = expectOk(compressContractState(state));
    const b = expectOk(compressContractState(state));
    expect(a.metadata.compression).toBe("gzip");
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("changes when a value changes", () => {
    const a = expectOk(compressContractState({ v: 1 }, { compression: "none" }));
    const b = expectOk(compressContractState({ v: 2 }, { compression: "none" }));
    expect(a.metadata.hash).not.toBe(b.metadata.hash);
  });
});

describe("safety and error handling", () => {
  it.each([
    ["function", { fn: () => 1 }],
    ["symbol", { sym: Symbol("x") }],
    ["non-finite number", { n: NaN }],
    ["infinity", { n: Infinity }],
    ["undefined value", { u: undefined }],
  ])("fails safely on unsupported value: %s", (_label, state) => {
    const result = compressContractState(state);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
  });

  it("rejects circular references", () => {
    const a: Record<string, unknown> = { name: "self" };
    a.self = a;
    const result = compressContractState(a);
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("circular");
  });

  it("rejects a non-object state root", () => {
    const result = compressContractState([] as unknown as Record<string, unknown>);
    expect(result.status).toBe("error");
  });

  it("fails safely when decompress gets corrupt bytes", () => {
    const good = expectOk(compressContractState({ a: 1 }, { compression: "none" }));
    const bad = good.data.slice();
    bad[0] = 0xff;
    // Corrupting the first byte changes the tag -> decode error or fingerprint mismatch.
    const result = decompressContractState(bad, good.metadata);
    expect(result.status).toBe("error");
  });

  it("fails safely on fingerprint mismatch", () => {
    const compressed = expectOk(compressContractState({ a: 1 }, { compression: "none" }));
    const tamperedMeta: ContractStateMetadata = { ...compressed.metadata, hash: "deadbeef" };
    const result = decompressContractState(compressed.data, tamperedMeta);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
  });

  it("rejects a payload with unsupported format or version", () => {
    const compressed = expectOk(compressContractState({ a: 1 }, { compression: "none" }));
    expect(
      decompressContractState(compressed.data, { ...compressed.metadata, format: "other" as never })
        .status,
    ).toBe("error");
    expect(
      decompressContractState(compressed.data, {
        ...compressed.metadata,
        version: 99 as unknown as 1,
      }).status,
    ).toBe("error");
    expect(
      decompressContractState(compressed.data, {
        ...compressed.metadata,
        compression: "lz4" as never,
      }).status,
    ).toBe("error");
  });
});

describe("no mutation of caller-owned state", () => {
  it("does not mutate the input state or nested values", () => {
    const nested = { keep: 1n, tags: ["x"] };
    const state: Record<string, unknown> = { a: 1, nested, bytes: new Uint8Array([1, 2]) };

    compressContractState(state, { compression: "auto" });

    expect(state.a).toBe(1);
    expect(state.nested).toBe(nested);
    expect(nested.keep).toBe(1n);
    expect(nested.tags).toEqual(["x"]);
    expect(Array.from(state.bytes as Uint8Array)).toEqual([1, 2]);
  });

  it("does not retain references to input objects in the encoded form", () => {
    const state: Record<string, unknown> = { a: { inner: 1 } };
    const compressed = expectOk(compressContractState(state, { compression: "none" }));
    // Mutating the source after encoding must not affect the stored bytes.
    (state.a as { inner: number }).inner = 999;
    const decoded = decompressContractState(compressed.data, compressed.metadata);
    expect(decoded.status).toBe("ok");
    expect(decoded.data).toEqual({ a: { inner: 1 } });
  });

  it("does not mutate the metadata object passed to decompress", () => {
    const compressed = expectOk(compressContractState({ a: 1 }));
    const meta = compressed.metadata;
    const before = JSON.stringify(meta);
    decompressContractState(compressed.data, meta);
    expect(JSON.stringify(meta)).toBe(before);
  });
});

describe("performance", () => {
  it("benchmarks compress/decompress for a representative payload", () => {
    const bench = expectOk(benchmarkContractState(REPETITIVE_STATE, 50));
    expect(bench.iterations).toBe(50);
    expect(bench.compressMs).toBeGreaterThanOrEqual(0);
    expect(bench.decompressMs).toBeGreaterThanOrEqual(0);
    expect(bench.compressMeanMs).toBeGreaterThan(0);
    expect(bench.decompressMeanMs).toBeGreaterThanOrEqual(0);
    expect(bench.payloadBytes).toBeGreaterThan(0);
    expect(bench.ratio).toBeGreaterThan(0);
  });

  it("benchmarks a large primitive payload too", () => {
    const state: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) state[`v${i}`] = i * 7;
    const bench = expectOk(benchmarkContractState(state, 20));
    expect(bench.compressMeanMs).toBeGreaterThan(0);
    expect(bench.totalMs).toBeGreaterThanOrEqual(bench.compressMs);
  });

  it("rejects an invalid iteration count", () => {
    const result = benchmarkContractState({ a: 1 }, 0);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(SorokitErrorCode.INVALID_CONFIG);
  });
});
