import { Memo } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Maximum size of a text memo: 28 bytes of UTF-8 (not 28 characters). */
export const MEMO_TEXT_MAX_BYTES = 28;
/** A hash (or return) memo is exactly 32 bytes, given as 64 hex characters. */
export const MEMO_HASH_BYTES = 32;
/** An id memo is an unsigned 64-bit integer (0 to 2^64 - 1). */
export const MEMO_ID_MAX = 18_446_744_073_709_551_615n;

const HASH_HEX = /^[0-9a-fA-F]{64}$/;
const DIGITS_ONLY = /^\d+$/;

/** A memo ready to attach to a transaction. */
export type BuiltMemo =
  | ReturnType<typeof Memo.text>
  | ReturnType<typeof Memo.id>
  | ReturnType<typeof Memo.hash>;

const invalid = (message: string, cause?: unknown) =>
  err(SorokitErrorCode.VALIDATION, message, cause);

/**
 * Build a text memo.
 *
 * Stellar limits a text memo to {@link MEMO_TEXT_MAX_BYTES} (28) bytes of
 * UTF-8, so multi-byte characters count for more than one. An empty string is
 * allowed. Returns `VALIDATION` for a non-string or an over-long value.
 */
export function buildTextMemo(text: string): SorokitResult<BuiltMemo> {
  if (typeof text !== "string") {
    return invalid("Text memo must be a string.");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MEMO_TEXT_MAX_BYTES) {
    return invalid(
      `Text memo must be ${MEMO_TEXT_MAX_BYTES} bytes or fewer, got ${bytes} bytes.`,
    );
  }
  return ok(Memo.text(text));
}

/**
 * Build an id memo.
 *
 * The id is an unsigned 64-bit integer. Pass a digit string or a bigint for
 * values above 2^53 (a `number` that large is rejected because it cannot be
 * represented exactly). Returns `VALIDATION` for negative, fractional,
 * non-numeric (including hex and padded) or out-of-range values.
 */
export function buildIdMemo(id: string | number | bigint): SorokitResult<BuiltMemo> {
  let value: bigint;
  if (typeof id === "bigint") {
    value = id;
  } else if (typeof id === "number") {
    if (!Number.isSafeInteger(id)) {
      return invalid(
        "ID memo must be a safe integer; pass a digit string or bigint for larger values.",
      );
    }
    value = BigInt(id);
  } else if (typeof id === "string" && DIGITS_ONLY.test(id)) {
    value = BigInt(id);
  } else {
    return invalid("ID memo must be an unsigned 64-bit integer.");
  }

  if (value < 0n || value > MEMO_ID_MAX) {
    return invalid("ID memo must be an unsigned 64-bit integer.");
  }
  return ok(Memo.id(value.toString()));
}

/**
 * Build a hash memo from 32 bytes, given as a 64-character hex string, a
 * `Buffer` or a `Uint8Array`. Returns `VALIDATION` for any other length or
 * format.
 */
export function buildHashMemo(
  hash: string | Buffer | Uint8Array,
): SorokitResult<BuiltMemo> {
  if (typeof hash === "string") {
    if (!HASH_HEX.test(hash)) {
      return invalid(
        `Hash memo must be ${MEMO_HASH_BYTES} bytes as a ${MEMO_HASH_BYTES * 2}-character hex string.`,
      );
    }
    return ok(Memo.hash(hash));
  }
  if (hash instanceof Uint8Array) {
    if (hash.length !== MEMO_HASH_BYTES) {
      return invalid(
        `Hash memo must be exactly ${MEMO_HASH_BYTES} bytes, got ${hash.length}.`,
      );
    }
    return ok(Memo.hash(Buffer.from(hash).toString("hex")));
  }
  return invalid("Hash memo must be a hex string, Buffer or Uint8Array.");
}
