# ADR-002: Stateless Client Design

**Status:** Accepted

## Problem

SDKs that hold mutable internal state — a singleton connection, a cached
"current account," a module-level config object — are convenient for a
single-tenant script but hostile to every other environment this SDK targets:
a server handling many users' requests concurrently, a test suite that needs
isolated instances per test, a browser app that wants more than one wallet
context alive at once (e.g. previewing a transaction as a different account),
and SSR, where module-level mutable state leaks between requests handled by
the same process. `sorokit-core` is explicitly framework-agnostic
(Node, browser, and SSR), which rules out any design that assumes exactly one
active "session" per process.

## Options Considered

1. **A module-level singleton client**, configured once (e.g. `Sorokit.init(config)`)
   and used via static imports thereafter. Simple call sites, but impossible
   to run two independently-configured clients in the same process — a
   blocker for a server handling multiple users, or a test suite running
   in parallel.
2. **A class instance holding mutable session state** (current account,
   cached sequence numbers, open subscriptions) that call sites mutate over
   the instance's lifetime. Familiar OOP shape, but reintroduces the same
   per-process contention problem as a singleton once more than one logical
   session needs to coexist, and makes testing harder (state must be reset
   between tests).
3. **A stateless factory**: `createSorokitClient(config)` returns a plain
   object of bound functions closing over `config` (network URLs, defaults),
   with no mutable internal session state and no singleton.

## Decision

`createSorokitClient` (`src/client/createSorokitClient.ts`) is a factory, not
a class with mutable session state. Every call creates an independent client
closed over its own `NetworkConfig` and options (timeouts, dedup/cache
settings, custom endpoints); nothing is shared across clients unless the
caller explicitly shares it (e.g. passing the same `SorokitCache` instance to
two clients). The functions each client exposes (`client.account.get`,
`client.transaction.build`, etc.) are themselves stateless — each call is
independent, takes what it needs as arguments, and returns a fresh
`SorokitResult` (ADR-001) with no side effect on the client object itself.
The one file that's allowed to import from multiple modules is
`createSorokitClient.ts` itself (see the boundary comment at the top of that
file, and ADR-006) — every other module stays self-contained specifically so
this factory can compose them without hidden shared state.

```ts
// Two independently-configured clients, safely concurrent in one process:
const mainnetClient = await createSorokitClient({ network: "mainnet" });
const testnetClient = await createSorokitClient({ network: "testnet" });
```

Where genuine caching or in-flight-request coalescing is useful for
performance (ADR shared elsewhere; see `src/network/requestDedup.ts` and
`src/shared/cache.ts`), it's opt-in, explicit, and scoped to the client
instance that requested it — never ambient, global, or on by default.

## Consequences

**Positive:**
- Multiple clients — different networks, different users, different test
  cases — coexist safely in the same process with no risk of cross-talk.
- Testing is simple: create a fresh client per test, no teardown/reset step
  required for shared state, because there isn't any.
- SSR-safe by construction: no module-level mutable state to leak between
  requests handled by the same server process.

**Trade-offs accepted:**
- Call sites that want session-like conveniences (a "current account", an
  open subscription list) must hold that state themselves, above the SDK —
  `sorokit-core` deliberately doesn't provide it. `WalletAccountManager`
  (`src/wallet/accountManager.ts`) is the one exception worth naming: it's an
  explicit, opt-in stateful helper an application can construct and hold
  itself, not something the client carries implicitly.
- Nothing is cached across calls unless the caller explicitly configures a
  cache/dedup layer — every call is a fresh network round trip by default.
  This is the right default for correctness (no stale reads by surprise) at
  the cost of requiring explicit opt-in for the common "avoid duplicate
  concurrent requests" case (see `dedupe` client option).
