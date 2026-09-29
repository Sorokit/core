# ADR-004: Error Code Classification

**Status:** Accepted

## Problem

Given the no-throw model (ADR-001), every failure surfaces as a
`SorokitError` — but a raw Horizon HTTP error, a Soroban RPC JSON-RPC error,
a WalletConnect rejection, and this SDK's own input validation all fail in
completely different shapes at their source. Without normalization, a caller
would need to know whether a given operation talks to Horizon, RPC, or a
wallet, and handle each's native error format separately — defeating the
point of a single result type. There's also a real difference in kind
between failures: some are safe to retry immediately (a 503 from an
overloaded Horizon node), some are retryable only after a fix (a sequence
conflict, fixable by refreshing the account), and some are never retryable
as-is (an invalid destination address). A single flat error code, or a
generic "network error" bucket, loses that distinction.

## Options Considered

1. **Pass underlying SDK/HTTP errors through unchanged.** Zero mapping code,
   but pushes the entire classification problem onto every caller, for every
   one of Horizon's, Soroban RPC's, and each wallet's distinct error shapes.
2. **One flat error code enum with no category or recovery metadata** —
   simpler than the chosen design, but doesn't let a caller ask "is this
   worth retrying" or "what class of problem is this" without a lookup
   table maintained outside the SDK.
3. **A stable `SorokitErrorCode` enum, grouped into `SorokitErrorCategory`
   buckets, with attached `recovery` guidance**, populated by mapping
   functions at each network boundary.

## Decision

`src/shared/response.ts` defines `SorokitErrorCode` (e.g.
`ACCOUNT_NOT_FOUND`, `TX_SEQUENCE_CONFLICT`, `CONTRACT_INVOKE_FAILED`,
`WALLET_SIGN_REJECTED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`,
`INVALID_ADDRESS`, ...) and `SorokitErrorCategory`
(`validation | network | timeout | contract | wallet | transaction |
internal | unknown`). Every `SorokitError` carries both: `code` for precise,
programmatic branching: `category` for coarse-grained handling (e.g. "show a
retry button for any `network`-category error" without enumerating every
code). Optional `recovery: { retryable, action, retryAfterMs? }` lets a
caller implement generic retry logic without hard-coding which specific
codes are retryable.

Mapping from a raw source error to this shape happens once, at each network
boundary, not ad hoc at every call site:

- `src/shared/horizonErrorMapper.ts`'s `mapHorizonError` inspects the HTTP
  status (and, as a fallback, the message text for a couple of
  Horizon-specific phrasings) and maps: `400`/"bad transaction" →
  `INVALID_TRANSACTION`; `404` → a resource-specific not-found code
  (`ACCOUNT_NOT_FOUND` vs. `TX_NOT_FOUND`, via a `resource` hint the caller
  provides); `408`/`429` → `SERVICE_UNAVAILABLE` with `retryable: true`
  (429 additionally sets `retryAfterMs`); `5xx` → `SERVICE_UNAVAILABLE`,
  retryable.
- `src/soroban/rpcErrorMapper.ts` does the equivalent for Soroban RPC's
  JSON-RPC error shape, mapping into the `contract`-category codes
  (`CONTRACT_INVOKE_FAILED`, `CONTRACT_SIMULATE_FAILED`,
  `SOROBAN_SIMULATION_FAILED`, ...).
- Wallet adapters (ADR-003) map connection/signing failures into the
  `wallet`-category codes (`WALLET_NOT_FOUND`, `WALLET_SIGN_REJECTED`,
  `WALLET_CONNECT_FAILED`, ...) at the adapter boundary, so shared wallet
  code never sees a raw wallet-extension exception.

A caller never pattern-matches on `error.message` for control flow — only
for display/logging. `message` is free-form and can improve over time
without being a breaking change; `code` is the stable contract.

## Consequences

**Positive:**
- A caller can write one generic retry helper against `result.error.recovery`
  that works for a rate-limited Horizon call, a timed-out RPC call, and any
  future retryable source this SDK adds, without enumerating codes.
- Adding support for a new failure source (a new wallet, a new RPC method)
  means writing a mapping function at that one boundary — everything
  downstream (retry logic, UI error handling) already understands the
  resulting `SorokitError` shape.
- `category` gives a coarse fallback for generic UI (e.g. a global "network
  issue" banner) without every call site needing to enumerate every
  `network`-category code by name.

**Trade-offs accepted:**
- The code list (`SorokitErrorCode`) is a single shared enum rather than
  per-module error types — a genuinely new failure kind means extending one
  central enum rather than adding a module-local type, which is a
  deliberate constraint keeping the set of codes a caller has to learn
  small and centrally documented, at the cost of that file being a common
  edit point when a module needs a new distinct code.
- Mapping functions make a best-effort classification from HTTP status
  codes and message-text heuristics (e.g. Horizon's own error payloads
  aren't always precise about the exact failure); a genuinely novel
  Horizon/RPC error shape falls back to a generic code
  (`NETWORK_ERROR`/`fallbackCode`) rather than a wrong specific one.
