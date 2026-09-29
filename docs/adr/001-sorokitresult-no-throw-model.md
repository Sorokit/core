# ADR-001: SorokitResult No-Throw Model

**Status:** Accepted

## Problem

Traditional SDK methods signal failure by throwing. Stellar operations fail in
many distinct, recoverable ways — an account that doesn't exist yet, a stale
sequence number, a Horizon endpoint that's temporarily down, a transaction
that fails simulation — and a caller needs to branch on *which* of these
happened to decide what to do next (refresh and rebuild, retry, surface a
message, fall back to another endpoint). A thrown exception collapses all of
that into a single control-flow path: every call site needs its own
`try/catch`, and distinguishing failure kinds means parsing an error
`.message` string or an SDK-specific exception subclass, which is brittle and
differs across the underlying `@stellar/stellar-sdk` and Horizon/RPC error
shapes this SDK wraps.

## Options Considered

1. **Throw on failure**, matching most JavaScript SDK conventions. Familiar,
   but pushes every caller into `try/catch`, encourages swallowing errors
   silently, and gives no structured way to distinguish a validation problem
   from a network outage from a contract revert without inspecting message
   text.
2. **Callback-style `(error, data)`**, Node's historical convention. Solves
   the structured-error problem but is awkward with `async`/`await`, and this
   SDK is framework-agnostic and promise-based throughout.
3. **Return a discriminated result object**, `SorokitResult<T>`, from every
   public function instead of throwing.

## Decision

Every public function returns `SorokitResult<T>`
(`src/shared/response.ts`):

```ts
export type SorokitResult<T> =
  | { status: "ok"; data: T; error: null }
  | { status: "error"; data: null; error: SorokitError };
```

`SorokitError` carries a stable `code` (`SorokitErrorCode`, e.g.
`ACCOUNT_NOT_FOUND`, `TX_SEQUENCE_CONFLICT`, `SERVICE_UNAVAILABLE`), a
`category` (`SorokitErrorCategory` — validation, network, timeout, contract,
wallet, transaction, internal, unknown), a human-readable `message`, and
optional `recovery` guidance (`{ retryable, action, retryAfterMs? }`) and
`context`. Callers branch on `result.status` (or the `isOk`/`isErr` guards
exported alongside it) and, on the error path, on `result.error.code` —
never on parsing `result.error.message`, which exists for display/logging
only.

```ts
const result = await buildPaymentTransaction(/* ... */);
if (result.status === "error") {
  if (result.error.code === SorokitErrorCode.TX_SEQUENCE_CONFLICT) {
    // refresh the account and rebuild
  } else if (result.error.recovery?.retryable) {
    // retry per result.error.recovery.action / retryAfterMs
  } else {
    // surface result.error.message to the user
  }
}
```

Errors originating from the underlying Stellar SDK, Horizon, or Soroban RPC
are normalized into this shape at the boundary (see ADR-004 and
`src/shared/horizonErrorMapper.ts` / `src/soroban/rpcErrorMapper.ts`) rather
than left as raw SDK exceptions, so a caller never needs to know whether a
given error originated from Horizon, RPC, or this SDK's own validation.

## Consequences

**Positive:**
- No `try/catch` required around SDK calls; failure is an ordinary,
  type-checked branch (TypeScript narrows `result.data` to non-null only
  after checking `result.status === "ok"`).
- Failure categorization is uniform across every module — a caller learns
  the pattern once and reuses it everywhere, rather than each function
  having its own throw/reject conventions.
- Retry and recovery logic can be written generically against
  `result.error.recovery`, rather than re-deriving "is this retryable" from
  message text per call site.

**Trade-offs accepted:**
- Every call site must remember to check `result.status` — nothing forces
  it the way an uncaught exception would surface a bug loudly. This SDK
  mitigates it with TypeScript's discriminated-union narrowing (accessing
  `result.data` when `status` hasn't been checked is a type error) rather
  than a runtime guarantee.
- Genuinely unexpected/programmer errors (a bug in this SDK itself, not a
  Stellar-network condition) still throw rather than being wrapped — the
  no-throw contract is for *expected, operational* failure modes, not for
  masking bugs as data.
