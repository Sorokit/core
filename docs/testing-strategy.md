# Testing strategy

This document describes how sorokit-core is tested and what's expected of a new
contribution. It reflects the conventions already in use across `src/tests/` —
every example below is adapted from a real test file in this repo, not
aspirational.

## Test types

### Unit tests

- **Location:** `src/tests/*.test.ts`, one file per module under test (e.g.
  `amountValidation.test.ts` tests `src/shared/amountValidation.ts`).
- **Scope:** a single exported function or a small cluster of closely related
  functions. Assert on `SorokitResult` shape (`status`, `data`, `error.code`),
  not on incidental implementation details.
- **Mocking:** `vi.mock()` for the module's own dependencies (`@stellar/stellar-sdk`,
  `../account/getAccount`, `../shared/serverFactory`, etc.), using `vi.hoisted()`
  when a mock needs to be referenced inside the `vi.mock()` factory itself.
  Prefer mocking at the narrowest boundary that makes the test deterministic —
  mock `TransactionBuilder.fromXDR`, not the whole SDK, when only XDR parsing
  needs to be controlled.

  ```ts
  // src/tests/validateTransaction.test.ts
  const mocks = vi.hoisted(() => ({ fromXDR: vi.fn() }));

  vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
    return {
      ...actual,
      TransactionBuilder: { ...actual.TransactionBuilder, fromXDR: mocks.fromXDR },
    };
  });
  ```

- **Network-touching functions** (anything that calls `getAccount`,
  `submitTransaction`, `simulateTransaction`, etc.) mock the underlying
  module rather than making real HTTP calls:

  ```ts
  // src/tests/accountManager.test.ts style
  vi.mock("../account/getAccount", () => ({ getAccount: vi.fn() }));
  vi.mocked(getAccount).mockResolvedValueOnce(ok(accountFixture));
  ```

### Integration tests

- **Location:** `src/tests/integration/*.test.ts`.
- **Scope:** multi-step flows that cross module boundaries — building a
  transaction, signing it through a wallet adapter, then submitting it
  (`transaction-flow.test.ts`); a full wallet-connect-to-account-fetch
  sequence (`wallet-account.test.ts`); contract deployment plus invocation
  (`soroban-contract.test.ts`).
- **Mocking:** Horizon and Soroban RPC are mocked at the HTTP layer via MSW
  (`src/tests/integration/msw-setup.ts`, `src/testing/mockServer.ts`) rather
  than by mocking individual SDK calls, since the point of an integration
  test is to exercise the real request/response wiring between modules.
  Wallet adapters are still mocked directly (`FreighterAdapter`,
  `LobstrAdapter`) since there's no extension to talk to in CI.

  ```ts
  import { setupMockServer, teardownMockServer } from "../../testing/mockServer";

  beforeAll(() => setupMockServer());
  afterAll(() => teardownMockServer());
  ```

### End-to-end (testnet) tests

There is no dedicated `e2e.test.ts` suite in this repo today, and none should
be added to `src/tests/` — a test that depends on Friendbot funding, real
ledger close times, or Horizon uptime is not deterministic enough to run on
every PR. If a future contribution adds real-testnet coverage, it should:

- live under its own `src/tests/e2e/` directory, excluded from the default
  `npm test` run and from coverage (mirror the existing
  `coverage.exclude` list in `vitest.config.ts`);
- run on a separate, opt-in CI job (nightly or manual dispatch), never as a
  required check on a PR, since testnet flakiness is outside contributors'
  control;
- always fund its own accounts via Friendbot rather than depending on
  pre-seeded state, so a run is self-contained and re-runnable.

### Property-based tests

- **Location:** files named `*.property.test.ts`, or a `describe` block
  inside a regular test file for a function whose contract is easier to
  state as a property than as fixed examples (see
  `feeCalculator.test.ts`, `priceSubscriptions.test.ts`).
- **Scope:** invariants that must hold across a whole input space, not just
  the cases a human thought to write down — amount/stroop conversions,
  arithmetic helpers, anything with a round-trip or algebraic identity.
- **Library:** [`fast-check`](https://github.com/dubzzz/fast-check), already
  a dependency.

  ```ts
  // src/tests/amounts.property.test.ts
  it("round-trips every representable stroop amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000_000n, max: 10_000_000_000_000n }),
        (stroops) => {
          expect(xlmToStroops(stroopsToXlm(stroops))).toBe(stroops);
        },
      ),
    );
  });
  ```

  Bound the generated range to values that are actually meaningful for the
  function under test (e.g. within Stellar's `MAX_STROOPS`), rather than
  letting `fast-check` generate the full `bigint` domain — an out-of-range
  failure just tells you the generator was too wide, not that the function
  is wrong.

### Performance tests

- **Bundle size:** `npm run build` reports per-entrypoint output size (see
  the `tsup` output for `dist/*/index.js`). There's no automated size budget
  enforced today; if a change adds a heavy dependency to a commonly-imported
  module (`shared/`, the package root), call out the size delta in the PR
  description so reviewers can judge whether it belongs behind a subpath
  export instead (see the "Smaller imports" section of the main README).
- **Latency/benchmarks:** `npm run bench` runs `vitest bench` for anything
  written as a `bench()` block. Use this for hot-path arithmetic or
  serialization code where a regression would be a correctness-adjacent
  concern (e.g. amount formatting called per-row in a UI list), not for
  network-bound operations whose latency is dominated by Horizon/RPC anyway.

## Conventions

- **Naming:** test files mirror the source file they test 1:1
  (`amountFormatter.ts` → `amountFormatter.test.ts`), living in `src/tests/`
  regardless of which subdirectory the source file is in. Nested/mirrored
  paths are not used — this keeps `src/tests/` greppable as a flat index of
  "what's covered."
- **Structure:** one top-level `describe()` per exported function, with
  nested `describe()` blocks for the specific behavior being grouped (error
  cases, a specific option, an edge case family). See
  `src/tests/validateTransaction.test.ts` or `src/tests/accountManager.test.ts`
  for the shape.
- **Fixtures:** prefer small inline helper functions (`makePaymentTx()`,
  `makeAccountInfo()`) defined at the top of the test file over shared
  fixture files — most fixtures here are one or two fields different per
  test, and a local helper keeps the diff between "what this test sets up"
  and "what it asserts" easy to read in one file. Reach for
  `src/testing/mockClient.ts` and `src/testing/mockServer.ts` only for
  integration tests that need a fully wired client or a running mock HTTP
  server.
- **Assertions:** assert on `result.status` first, then narrow
  (`if (result.status !== "ok") return;`) before asserting on `result.data`.
  This keeps TypeScript's control-flow narrowing working inside the test and
  avoids asserting against `undefined` when a test fixture is wrong. Prefer
  asserting on `result.error.code` (a `SorokitErrorCode`) over matching on
  `result.error.message` text, since messages are for humans and can change
  without being a behavioral regression.

## Coverage targets

`vitest.config.ts` enforces, over `src/**/*.ts` excluding test files
themselves and `src/testing/**`:

| Metric | Threshold |
| --- | --- |
| Lines | 80% |
| Functions | 80% |
| Branches | 75% |
| Statements | 80% |

Run `npm run test:coverage` to check locally before opening a PR — the same
command CI runs. A single new file with zero tests will usually fail the
global threshold even if the rest of the suite is fully covered, since
coverage here is measured repo-wide, not per-file; don't chase a green
per-file report in isolation and skip the full-suite run.

When adding a new module, add its test file in the same PR — a build that
introduces `src/foo/bar.ts` with no `src/tests/bar.test.ts` will fail the
coverage gate before a reviewer even needs to ask for tests.

## Best practices

- **Isolation:** a test should not depend on another test's side effects or
  execution order. Module-level mutable state (an in-memory cache, a
  registry) gets reset between tests, not assumed clean from a previous
  test's cleanup — `buildTransaction.ts` exports `clearSequenceCache()` for
  exactly this reason; call it in `beforeEach` rather than relying on test
  ordering.
- **Determinism:** no real network calls, no real timers where a fake one
  will do, no dependence on wall-clock time beyond what a test explicitly
  freezes or stubs. Property tests are the one place randomness is
  intentional, and `fast-check` handles seeding and shrinking for you.
- **Speed:** the unit suite should stay fast enough to run on every save.
  Prefer mocking a slow dependency over adding a real delay, and reach for
  `vi.useFakeTimers()` rather than a literal `setTimeout` in a test whenever
  a function under test schedules work.
- **One behavior per test:** a failing test name should tell you what broke
  without opening the file. Prefer several small `it()` blocks with focused
  assertions over one `it()` that exercises many behaviors and asserts on
  all of them at the end.

## Adding a new test file

1. Create `src/tests/<moduleName>.test.ts` (or `src/tests/integration/...`
   for a cross-module flow).
2. Mock only what the module under test actually calls out to — check its
   imports first.
3. Cover: the success path, at least one validation/error path per
   `SorokitErrorCode` the function can return, and any edge case called out
   in the function's own doc comment (empty input, boundary values, `null`
   vs `undefined`).
4. Run `npx vitest run src/tests/<file>.test.ts --coverage.enabled=false`
   while iterating (coverage thresholds are measured repo-wide and will
   produce spurious failures against a single file).
5. Before opening a PR, run the full local CI equivalent: `npm run
   typecheck`, `npm run lint`, `npm test`, `npm run build`.
