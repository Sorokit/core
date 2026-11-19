# Recipe: Single-Operation Transaction Builders

## Problem

You need to build one of three operations that carry extra risk or require
careful validation: merging an account, bumping a sequence, or clawing back an
issued asset. The standalone `buildAccountMerge`, `buildBumpSequenceTransaction`
and `buildClawbackTransaction` helpers are convenient, but you want a fluent API
that returns the Stellar SDK `Transaction` object so you can inspect operations
before signing.

## Solution

Use the fluent builders from `sorokit-core`:

- `AccountMergeBuilder` (#911)
- `BumpSequenceBuilder` (#910)
- `ClawbackBuilder` (#909)

All three share the constructor shape
`(sourcePublicKey, networkConfig, options?)`, expose chainable setters, and
return `Promise<SorokitResult<Transaction>>` from `.build()`. They never throw.
Supplying `options.sequenceNumber` makes them fully offline, which is useful for
tests and for workflows that already prefetch the sequence.

## Code

```ts
import {
  AccountMergeBuilder,
  BumpSequenceBuilder,
  ClawbackBuilder,
  resolveNetwork,
} from "sorokit-core";

const resolved = resolveNetwork("testnet");
if (resolved.status === "error") throw new Error(resolved.error.message);
const networkConfig = resolved.data;

const source = "GSOURCE...";
const destination = "GDESTINATION...";
const issuer = "GISSUER...";
const holder = "GHOLDER...";

// ── Account merge ────────────────────────────────────────────────────────────

const merge = await new AccountMergeBuilder(source, networkConfig, {
  sequenceNumber: "100",
})
  .destination(destination)
  .build();

// ── Bump sequence: cancel pending transactions ───────────────────────────────
// A transaction signed at sequence 100 can only be submitted while the account
// is still at 100. Bumping to 101 invalidates it. Pending transactions signed
// at 101 or above remain valid.

const current = "100";
const bump = await new BumpSequenceBuilder(source, networkConfig, {
  sequenceNumber: current,
})
  .bumpTo(101n)
  .build();

// ── Clawback ─────────────────────────────────────────────────────────────────

const clawback = await new ClawbackBuilder(issuer, networkConfig, {
  sequenceNumber: "100",
})
  .asset({ assetCode: "USDC", assetIssuer: issuer })
  .from(holder)
  .amount("25.5")
  .build();
```

On success, `result.data` is a Stellar SDK `Transaction`. Serialise it with
`result.data.toXDR()` before handing it to your signer. On failure,
`result.error` is a structured `SorokitError` with a stable `code`, `category`,
and message.

## ⚠ Data loss warning for account merge

Account merge is **irreversible**. The source account is deleted from the
ledger, including its signers, trustlines, offers and data entries. Only its
native XLM balance is transferred to the destination. Assets held in trustlines
must be moved out first or they are lost. The builder rejects a self-merge and a
malformed destination, but it deliberately does **not** verify that the
destination exists, so double-check the address before signing.

## Validation boundaries

- `AccountMergeBuilder`: destination must be a valid Stellar G-address and must
  not equal the source. No ledger lookup is performed.
- `BumpSequenceBuilder`: target must be an unsigned 64-bit integer, and must be
  strictly greater than `options.sequenceNumber` when that option is supplied.
  The builder never fetches the current sequence from Horizon.
- `ClawbackBuilder`: the asset must be issued (native XLM is rejected), the
  issuer and holder must be valid G-addresses, and the amount must be positive
  with at most seven decimal places. The builder validates the *structure* of
  the asset but does not query the ledger to confirm the issuer's clawback flag
  is enabled.

## See also

- [Migration guide](../migration-guide.md)
- [Workflows reference](../workflows.md)
- [Fee estimation](15-fee-estimation.md)
