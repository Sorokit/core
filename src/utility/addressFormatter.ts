/**
 * Address display formatting (#963).
 *
 * Stellar addresses are 56 characters (G/C keys) or 69 (M muxed accounts),
 * which is too long for most UI surfaces. `shortenAddress` keeps the first and
 * last characters so users can still recognise and compare an address.
 *
 * Display only: this does not validate the address (use `validateAddress` for
 * that) and a shortened address must never be used as an identifier.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Characters kept at each end when `chars` is not given. */
export const DEFAULT_ADDRESS_VISIBLE_CHARS = 4;

/** Separator placed between the kept head and tail. */
export const ADDRESS_ELLIPSIS = "...";

/**
 * Shorten an address to `<first chars>...<last chars>`.
 *
 * An address that would not get shorter (its length is at most
 * `2 * chars + ellipsis length`) is returned unchanged, so the output is never
 * longer than the input. Surrounding whitespace is trimmed.
 *
 * @param address Address to shorten.
 * @param chars   Characters kept at each end. Positive integer, default 4.
 *
 * @example
 * shortenAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW");
 * // "GABC...TUVW"
 * shortenAddress("GABCDEFGH...", 6); // "GABCDE...XXXXXX"
 */
export function shortenAddress(
  address: string,
  chars: number = DEFAULT_ADDRESS_VISIBLE_CHARS,
): SorokitResult<string> {
  if (typeof address !== "string" || address.trim() === "") {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Address must be a non-empty string.",
    );
  }
  if (!Number.isInteger(chars) || chars < 1) {
    return err(
      SorokitErrorCode.VALIDATION,
      "chars must be a positive integer.",
      undefined,
      undefined,
      { context: { operation: "shortenAddress", parameters: { chars } } },
    );
  }

  const value = address.trim();
  if (value.length <= chars * 2 + ADDRESS_ELLIPSIS.length) {
    return ok(value);
  }
  return ok(`${value.slice(0, chars)}${ADDRESS_ELLIPSIS}${value.slice(-chars)}`);
}
