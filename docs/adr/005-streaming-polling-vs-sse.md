# ADR-005: Streaming — Polling by Default, Opt-in SSE for Transactions

**Status:** Accepted

## Problem

Applications need to react to account and transaction state changes without
manually re-fetching in a loop. Horizon offers Server-Sent Events (SSE) on
several endpoints, which push updates with low latency, but SSE connections
are long-lived, can be closed by intermediary proxies/load balancers without
warning, aren't supported identically in every runtime this SDK targets
(Node without a fetch/EventSource polyfill, React Native, some serverless
edge environments), and give up control over the interval — you get events
exactly as fast as Horizon emits them, with no way to intentionally slow
down or coalesce. Some Soroban-side state (contract storage, computed
account health) has no SSE endpoint at all and can only be observed by
re-querying.

## Options Considered

1. **SSE-only streaming.** Lowest latency when it works, but requires an
   `EventSource`-capable environment, silently stalls if a proxy closes the
   connection without an error event, and doesn't cover Soroban-side data
   that Horizon doesn't push at all.
2. **Polling-only streaming**, a fixed-interval loop re-fetching and
   diffing. Works identically everywhere (any environment with `fetch`),
   trivially covers non-SSE data (Soroban state, computed values), and
   gives the caller direct control over frequency — at the cost of higher
   latency than a push-based event and more request volume than strictly
   necessary.
3. **Polling as the universal default, with an opt-in SSE-aware transport
   specifically for transaction streams** (the one case where the latency
   difference matters most and Horizon's SSE support is solid), falling
   back to polling automatically if SSE is unavailable or drops.

## Decision

`client.account.stream()` and `client.transaction.stream()` are both async
generators built on a poll loop at a configurable `intervalMs`
(`src/account/streamAccount.ts`, transaction streaming equivalent), stoppable
at any point via an `AbortSignal` — this is the default and the only
transport for account streams, since account/Soroban state has no uniform
SSE source to poll instead.

```ts
for await (const result of client.account.stream(publicKey, { intervalMs: 3000 }, ac.signal)) {
  if (result.status === "ok") { /* handle state update */ }
}
```

`client.transaction.stream()` additionally accepts a `transport` option
(`"poll" | "sse" | "auto"`). `"sse"`/`"auto"` open a Horizon SSE connection
for lower-latency delivery; `"auto"` falls back to polling automatically if
the SSE endpoint is unavailable or the connection closes before emitting an
event, so a caller opting into lower latency doesn't have to also handle the
SSE-unavailable case themselves. Polling remains the unconditional default
(`transport` defaults to `"poll"`) so existing behavior doesn't change
underneath callers who don't ask for SSE.

Cursor position across reconnects/restarts is handled independently of the
transport, via `CursorStore` (`src/streaming/cursorStore.ts` —
`MemoryCursorStore` for SSR/tests, `LocalStorageCursorStore` in browsers),
and duplicate delivery after a reconnect is guarded by
`EventDeduplicationStore`, a bounded, TTL-evicted set of recently-seen event
IDs. Both apply the same way whether the underlying transport is polling or
SSE.

## Consequences

**Positive:**
- Every streaming consumer works in every environment this SDK targets by
  default (polling only needs `fetch`), including ones without a usable
  `EventSource`.
- Callers who want lower transaction latency get it by adding one option
  (`transport: "auto"`) without taking on SSE's failure modes themselves —
  the fallback is the SDK's responsibility.
- Cursor/dedup handling is transport-independent, so switching a
  transaction stream between polling and SSE (or a fallback happening
  mid-stream) doesn't risk missed or duplicated events.

**Trade-offs accepted:**
- Polling has a latency floor set by `intervalMs` and issues more requests
  than an ideal push-based design for the same freshness — callers who need
  the lowest possible transaction latency must explicitly opt into
  `transport: "auto"`/`"sse"` rather than getting it by default.
- Account and Soroban-state streams have no SSE option at all (Horizon
  doesn't expose one uniformly for that data) — polling is the only
  transport there, by necessity rather than choice, and a very low
  `intervalMs` is the only latency lever a caller has for those streams.
