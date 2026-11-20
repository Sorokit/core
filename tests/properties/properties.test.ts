import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { formatAmount } from '../../src/shared/amountFormatter';
import {
  validateStellarAddress,
  validateAssetCode,
} from '../../src/shared/validation';
import {
  canonicalAssetId,
  getAssetInfo,
} from '../../src/shared/assetRegistry';

/**
 * Property-based tests using fast-check.
 *
 * These tests complement the existing unit tests by generating randomized
 * inputs to surface edge cases that hand-written examples may miss.
 *
 * Patterns used here:
 *  - `fc.assert(fc.property(...))` for each invariant.
 *  - Arbitraries are kept small and bounded so runs stay fast and deterministic
 *    in behavior (fast-check seeds are reproducible via `seed`/`path` on failure).
 *  - Round-trip properties (encode -> decode) are preferred where possible.
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary bigint stroop amount, bounded to a sane range for formatting. */
const stroopsArb = fc.bigInt({
  min: 0n,
  max: 10n ** 30n,
});

/** Arbitrary decimal precision in the supported 0–20 range. */
const decimalsArb = fc.integer({ min: 0, max: 20 });

/** Arbitrary Stellar asset code: 1–12 alphanumeric characters. */
const assetCodeArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,12}$/)
  .filter((s) => s.length >= 1 && s.length <= 12);

/** Arbitrary Stellar issuer: G-prefixed StrKey-shaped string (56 chars). */
const issuerArb = fc
  .tuple(
    fc.constant('G'),
    fc.stringMatching(/^[A-Z2-7]{55}$/),
  )
  .map(([prefix, rest]) => `${prefix}${rest}`);

/** Arbitrary non-Stellar strings, used to check rejection paths. */
const arbitraryStringArb = fc.string();

// ---------------------------------------------------------------------------
// 1. formatAmount never throws for arbitrary stroops and decimals 0–20
// ---------------------------------------------------------------------------

describe('formatAmount properties', () => {
  it('never throws for arbitrary bigint stroops and decimals 0–20', () => {
    fc.assert(
      fc.property(stroopsArb, decimalsArb, (stroops, decimals) => {
        expect(() => formatAmount(stroops, decimals)).not.toThrow();
        const out = formatAmount(stroops, decimals);
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // 2. formatAmount output parses back to the original stroop value (en-US)
  // -------------------------------------------------------------------------

  it('round-trips stroops through formatted en-US output', () => {
    fc.assert(
      fc.property(stroopsArb, decimalsArb, (stroops, decimals) => {
        const formatted = formatAmount(stroops, decimals, 'en-US');

        // Strip grouping separators, then re-parse to stroops.
        const normalized = formatted.replace(/,/g, '');
        const [whole, fraction = ''] = normalized.split('.');

        // Pad/truncate the fractional part to the requested precision.
        const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);

        const reconstructed =
          BigInt(whole || '0') * 10n ** BigInt(decimals) +
          BigInt(paddedFraction || '0');

        expect(reconstructed).toBe(stroops);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. validateStellarAddress accepts only G-prefix + StrKey checksum shape
// ---------------------------------------------------------------------------

describe('validateStellarAddress properties', () => {
  it('rejects arbitrary strings that are not valid Stellar addresses', () => {
    fc.assert(
      fc.property(arbitraryStringArb, (input) => {
        // Only assert rejection for strings that clearly cannot be a valid
        // StrKey address (wrong length or wrong prefix). This keeps the
        // property meaningful without depending on checksum internals.
        const looksLikeAddress =
          input.length === 56 && input.startsWith('G');
        if (!looksLikeAddress) {
          expect(validateStellarAddress(input)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('accepts only strings matching the G-prefix + 56-char StrKey shape', () => {
    fc.assert(
      fc.property(arbitraryStringArb, (input) => {
        const accepted = validateStellarAddress(input);
        if (accepted) {
          expect(input.startsWith('G')).toBe(true);
          expect(input.length).toBe(56);
          // StrKey base32 alphabet: A-Z and 2-7.
          expect(/^G[A-Z2-7]{55}$/.test(input)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. validateAssetCode accepts exactly 1–12 alphanumeric chars
// ---------------------------------------------------------------------------

describe('validateAssetCode properties', () => {
  it('accepts exactly 1–12 alphanumeric characters', () => {
    fc.assert(
      fc.property(assetCodeArb, (code) => {
        expect(validateAssetCode(code)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects strings that are empty, too long, or contain non-alphanumerics', () => {
    const invalidArb = fc.oneof(
      fc.constant(''),
      fc.stringMatching(/^[A-Za-z0-9]{13,20}$/),
      fc.stringMatching(/^[A-Za-z0-9]{0,11}[^A-Za-z0-9][A-Za-z0-9]{0,11}$/),
    );

    fc.assert(
      fc.property(invalidArb, (code) => {
        expect(validateAssetCode(code)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. canonicalAssetId / getAssetInfo round-trip for valid asset codes
// ---------------------------------------------------------------------------

describe('assetRegistry properties', () => {
  it('round-trips canonicalAssetId through getAssetInfo for valid assets', () => {
    fc.assert(
      fc.property(assetCodeArb, issuerArb, (code, issuer) => {
        const id = canonicalAssetId(code, issuer);
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);

        const info = getAssetInfo(id);
        expect(info).not.toBeNull();
        if (info) {
          expect(info.code).toBe(code);
          expect(info.issuer).toBe(issuer);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('produces a stable canonical id for identical inputs', () => {
    fc.assert(
      fc.property(assetCodeArb, issuerArb, (code, issuer) => {
        const a = canonicalAssetId(code, issuer);
        const b = canonicalAssetId(code, issuer);
        expect(a).toBe(b);
      }),
      { numRuns: 100 },
    );
  });
});