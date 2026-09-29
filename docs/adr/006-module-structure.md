# ADR-006: Module Structure (wallet, account, transaction, soroban, network, shared)

**Status:** Accepted

## Problem

An SDK covering wallet connection, account queries, transaction building,
Soroban contract interaction, and network resilience can either grow as one
undifferentiated pile of functions, or be organized so each concern can be
understood, tested, and evolved on its own. Without an enforced boundary,
it's easy for a transaction builder to casually reach into wallet internals,
or a network-resilience helper to assume knowledge of Soroban-specific
types — coupling that's invisible until someone tries to change one module
and breaks another they didn't know depended on it.

## Options Considered

1. **A single flat module** exporting every function from one large file
   (or a handful of large files with no clear ownership boundary). Nothing
   to navigate for a trivial SDK, but this one is not trivial — dozens of
   account/transaction/soroban operations, several wallet adapters, and a
   growing set of network-resilience primitives — and a flat structure
   gives no signal about what depends on what.
2. **Organize by technical layer** (e.g. `http/`, `parsers/`, `builders/`)
   instead of by domain. Common in some codebases, but scatters one
   domain's logic (e.g. everything about accounts) across multiple
   directories, so understanding "how does account fetching work end to
   end" means jumping between unrelated technical-layer folders.
3. **Organize by domain, one directory per responsibility, with an
   explicit, enforced import-direction rule**: `wallet/`, `account/`,
   `transaction/`, `soroban/`, `network/`, `shared/`, composed only by one
   entry-point file.

## Decision

Six top-level domains under `src/`, matching `docs/architecture.md`'s module
table:

| Module | Responsibility |
|---|---|
| `wallet/` | Detect wallets, connect, sign, adapter implementations (ADR-003), signing history/rate limiting |
| `network/` | Resolve network config, endpoint failover, circuit breaker, connection pooling, request dedup |
| `account/` | Read account state, balances, activity, sponsorship, trustline policy |
| `transaction/` | Build, validate, estimate, submit, monitor, analyze transactions |
| `soroban/` | Prepare, simulate, invoke, and recover Soroban contract calls |
| `shared/` | `SorokitResult`/error types (ADR-001, ADR-004), constants, server factories, logging, metrics, cache |

The boundary rule (stated at the top of
`src/client/createSorokitClient.ts`, the one file allowed to violate it) is:
*only `createSorokitClient.ts` imports from multiple domain modules; every
other module imports only from `shared/` or its own files.* Concretely,
`transaction/` and `soroban/` never import from `network/` directly — network
concerns (endpoint resolution, retries, circuit-breaking) are either
injected in or handled by the shared server factory
(`src/shared/serverFactory.ts`), and `NetworkConfig` itself is typed in
`shared/types.ts`, not owned by the `network/` module, specifically so
non-network modules can reference the config shape without importing
`network/`'s implementation. Each domain's public surface is also
independently exposed via `package.json`'s `exports` map (`sorokit-core/wallet`,
`sorokit-core/account`, `sorokit-core/transaction`, `sorokit-core/soroban`,
`sorokit-core/network`, `sorokit-core/shared`), so a consumer who only needs
account reads can import just that subpath without pulling in wallet or
Soroban code.

```ts
import { getAccount } from "sorokit-core/account"; // no wallet/soroban code pulled in
```

## Consequences

**Positive:**
- A contributor working in `account/` can reason about that module without
  reading `wallet/` or `soroban/` — the import-direction rule makes "what
  can this file possibly depend on" answerable by looking at its own
  directory plus `shared/`.
- Per-domain subpath exports keep bundle size down for consumers who use a
  subset of the SDK (a server that only submits pre-built transactions
  doesn't need wallet-adapter code in its bundle) — this is part of what the
  README's bundle-size budget (50 KB gzipped, tracked via
  `scripts/check-bundle-size.mjs`) depends on being achievable.
- New functionality has an obvious home: a new Soroban helper goes in
  `soroban/`, a new resilience primitive goes in `network/` — reducing
  bikeshedding about file placement and keeping related code discoverable
  in one place.

**Trade-offs accepted:**
- The single-entry-point rule means `createSorokitClient.ts` is
  unavoidably large (it imports and re-exposes most of the SDK's surface) —
  it trades a large-but-flat composition file for small, focused domain
  modules, rather than distributing the composition responsibility.
- A genuinely cross-cutting concern that doesn't belong to exactly one
  domain (e.g. `network/`'s request deduplication being used by
  `account/getAccountsBatch.ts`) has to either live in `shared/` if it's
  truly generic, or be threaded through the composition layer — the
  boundary rule doesn't eliminate cross-cutting concerns, it just forces an
  explicit decision about where each one lives instead of letting it leak
  in ad hoc via convenient imports.
