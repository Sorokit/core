<div align="center">

<h1>sorokit-core</h1>

<p><strong>Framework-agnostic TypeScript SDK for Stellar.</strong></p>

<p>
  The execution layer for wallet connection, transaction handling,<br/>
  and Soroban smart contract interaction — with a no-throw result model throughout.
</p>

<p>
  <a href="https://github.com/Just-Bamford/sorokit-core/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  </a>
  <img src="https://img.shields.io/badge/typescript-%5E5.0-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/stellar-mainnet%20%7C%20testnet%20%7C%20futurenet-6f42c1" alt="Stellar Networks" />
  <img src="https://img.shields.io/badge/runtime-node%20%7C%20browser-brightgreen" alt="Node + Browser" />
</p>

<p>Part of the <a href="https://github.com/Just-Bamford">sorokit</a> ecosystem.</p>

<br/>

</div>

---

## Overview

`sorokit-core` gives you a single typed client for everything you need to build on Stellar: connecting wallets, reading accounts, building and submitting transactions, and invoking Soroban contracts. Every function returns a `SorokitResult<T>` — no try/catch, no uncaught promise rejections, no surprises.

It is deliberately stateless and framework-agnostic. It runs in Node, the browser, React, Vue, Svelte, or any environment that can execute TypeScript — with no opinion about how you manage state.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Modules](#modules)
- [API Reference](#api-reference)
  - [wallet](#wallet)
  - [account](#account)
  - [transaction](#transaction)
  - [soroban](#soroban)
- [Result Type](#result-type)
- [Wallet Adapters](#wallet-adapters)
- [Network Management](#network-management)
- [Streaming](#streaming)
- [Networks](#networks)
- [Testing Utilities](#testing-utilities)
- [Examples](#examples)
- [Workflow and Architecture Guides](#workflow-and-architecture-guides)
- [New in This Release](#new-in-this-release)
- [Design Principles](#design-principles)
- [License](#license)

---

## Installation

```bash
npm install sorokit-core @creit.tech/stellar-wallets-kit
```

`@creit.tech/stellar-wallets-kit` is a required peer dependency. It provides the underlying wallet adapter infrastructure that `sorokit-core` builds on.

---

## Quick Start

```ts
import { createSorokitClient, FreighterAdapter } from "sorokit-core";

// 1. Create a client
const result = createSorokitClient({ network: "testnet" });
if (result.status === "error") throw new Error(result.error.message);

const client = result.data;

// 2. Connect a wallet
const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);

const { publicKey } = conn.data;

// 3. Fetch account balances
const account = await client.account.get(publicKey);
if (account.status === "ok") {
  console.log(account.data.balances);
}

// 4. Build, sign, and submit a payment
const tx = await client.transaction.buildPayment(publicKey, {
  destination: "GDEST...WXYZ",
  amount: "10",
});

if (tx.status === "ok") {
  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: tx.data,
    networkPassphrase: client.networkConfig.networkPassphrase,
  });

  if (signed.status === "ok") {
    await client.transaction.submit(signed.data);
  }
}
```

---

## Modules

| Module        | Responsibility                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `wallet`      | Connect/disconnect wallets, sign transactions, offline signing, wallet status tracking                        |
| `account`     | Fetch account info, balances, stream state, balance alerts, activity summaries, key rotation, sponsorship     |
| `transaction` | Build/submit/track transactions, fee estimation, multi-sig support, path payments, history export, webhooks   |
| `soroban`     | Read/invoke contracts, simulate transactions, contract interaction builder, event decoding, deploy validation |
| `network`     | Network configuration, circuit breaker, dynamic network switching, network resolution                         |
| `shared`      | Logging, tracing, caching, configuration, validation, server factory                                          |

---

## API Reference

The [hosted API reference](https://tochukwujustice.github.io/core/) is published by
GitHub Actions after a successful deployment. It documents the public exports from
`src/index.ts`, including parameter descriptions, return values, and examples.

Generate and view it locally:

```bash
npm ci --legacy-peer-deps
npm run docs
```

Open `docs/api/index.html` in a browser. Generated HTML is ignored by Git.

The documentation workflow validates pull requests, and publishes on pushes to
`main`, published releases, and manual runs. To enable hosting for this repository,
select **Settings → Pages → Build and deployment → Source → GitHub Actions**,
then run the workflow. The workflow also preserves generated HTML on `gh-pages`.
Ensure the `github-pages` environment permits the branches and release tags you
intend to deploy. For a fork, use
`https://<owner>.github.io/<repository>/` and update the hosted link above.
Documentation is only live after the workflow and GitHub Pages deployment succeed.

### `wallet`

```ts
client.wallet.connect(adapter); // → SorokitResult<WalletState>
client.wallet.disconnect(adapter); // → SorokitResult<WalletState>
client.wallet.signTransaction(adapter, input); // → SorokitResult<string>
client.wallet.emptyState(); // → SorokitResult<WalletState>
```

### `account`

```ts
// Fetch full account info
client.account.get(publicKey); // → SorokitResult<AccountInfo>

// Fetch all balances
client.account.getBalances(publicKey); // → SorokitResult<AssetBalance[]>

// Filter balances by asset code, issuer, type, or exclude zero balances
client.account.getAssetBalances(publicKey, {
  assetCode: "USDC",
  assetIssuer: "GA5Z...",
  excludeZero: true,
}); // → SorokitResult<AssetBalance[]>

// Get account activity summary (new)
client.account.getAccountActivitySummary(publicKey); // → SorokitResult<ActivitySummary>

// Create balance alerts (new)
client.account.createBalanceAlert(publicKey, {
  minBalance: "100",
  onAlert: (balance) => console.log("Low balance alert"),
});

// Rotate account keys (new)
client.account.rotateKey(publicKey, params); // → SorokitResult<Transaction>

// Manage account sponsorship (new)
client.account.sponsorAccount(publicKey, sponsorKey); // → SorokitResult<Transaction>

// Poll Horizon and stream account state changes
for await (const result of client.account.stream(publicKey)) {
  if (result.status === "ok") console.log(result.data.balances);
}
```

### `transaction`

```ts
// Build common transaction types (returns XDR string)
client.transaction.buildPayment(sourceKey, params); // → SorokitResult<string>
client.transaction.buildCreateAccount(sourceKey, params); // → SorokitResult<string>
client.transaction.buildTrustline(sourceKey, params); // → SorokitResult<string>

// Build multi-signature transactions (new)
client.transaction.buildMultiSigTransaction(sourceKey, params); // → SorokitResult<string>

// Build path payments (new)
client.transaction.buildPathPayment(sourceKey, params); // → SorokitResult<string>

// Submit and query
client.transaction.submit(signedXdr); // → SorokitResult<TransactionResult>
client.transaction.getStatus(hash); // → SorokitResult<TransactionResult>

// Estimate fee from a pre-built XDR
client.transaction.estimateFee({ kind: "xdr", transactionXdr: xdr });

// Or estimate from payment params directly
client.transaction.estimateFee({
  kind: "payment",
  publicKey,
  destination: "GDEST...",
  amount: "10",
}); // → SorokitResult<FeeEstimate>

// Get fee analytics (new)
client.transaction.getFeeAnalytics(params); // → SorokitResult<FeeAnalytics>

// Query transaction history (new)
client.transaction.queryTransactionHistory(publicKey, { limit: 50 }); // → SorokitResult<Transaction[]>

// Export transaction history (new)
client.transaction.exportTransactionHistory(publicKey, format); // → SorokitResult<string>

// Validate destination (new)
client.transaction.validateDestination("GDEST..."); // → SorokitResult<boolean>

// Validate transaction offline (new)
client.transaction.validateTransactionOffline(transactionXdr); // → SorokitResult<ValidationResult>

// Stream transactions for an account
for await (const result of client.transaction.stream(publicKey)) {
  if (result.status === "ok") console.log(result.data.transactions);
}
```

### Smaller imports

The SDK also exposes module bundles for applications that only need one part of the API:

```ts
import { FreighterAdapter } from "sorokit-core/wallet";
import { buildSetOptionsTransaction } from "sorokit-core/transaction";
import { getOffers } from "sorokit-core/account";
```

These subpaths emit independent ESM, CommonJS, and declaration files while the root import remains backward compatible.

### `soroban`

```ts
client.soroban.simulate(transactionXdr)         // → SorokitResult<SimulateTransactionResult>
client.soroban.prepare(params)                  // → SorokitResult<PreparedContractCall>
client.soroban.execute(signedXdr)               // → SorokitResult<string> (tx hash)
client.soroban.read(params)                     // → SorokitResult<ContractCallResult>

// Contract interaction builder (new)
const builder = new ContractInteractionBuilder(client, contractId);
builder
  .method('transfer')
  .arg('to', destination)
  .arg('amount', amount)
  .build();

// Contract state tracking (new)
client.soroban.trackContractState(contractId, keys); // → AsyncGenerator

// Decode contract events (new)
client.soroban.decodeContractEvent(event); // → DecodedEvent | null

// Get contract call identity (new)
client.soroban.getCallIdentity(contractId); // → SorokitResult<ContractIdentity>

// Parse contract results (new)
client.soroban.parseContractResult(result); // → SorokitResult<ParsedResult>

// Simulate before execution (new)
client.soroban.simulator.simulate(transaction); // → SorokitResult<SimulationResult>

// Get factory statistics (new)
client.soroban.getFactoryStatistics(factoryId); // → SorokitResult<FactoryStats>

// Full invoke pipeline: prepare → sign → execute in one call
client.soroban.invoke(params, (xdr) =>
  adapter.signTransaction({ transactionXdr: xdr, ... })
)
```

#### Contract deployment

`buildContractDeploy` validates its configuration before any network call, so a
missing endpoint or a malformed deployer address fails immediately with an
`INVALID_CONFIG` error naming every offending field and how to fix it. Call the
same check directly from a deployment script to fail before you spend a build:

```ts
import { validateDeployConfig, collectDeployConfigIssues } from "sorokit-core";

const check = validateDeployConfig({
  rpcUrl,
  horizonUrl,
  networkConfig,
  deployer,
});
if (check.status === "error") {
  console.error(check.error.message);
  // Deployment configuration is invalid — 2 problems found:
  //   1. rpcUrl — rpcUrl is missing. Fix: Set rpcUrl to the Soroban RPC endpoint …
  //   2. deployer — deployer is not a valid Stellar public key: "GNOPE". Fix: …
  process.exit(1);
}

// Or render the issues yourself — each has { field, reason, hint }
const issues = collectDeployConfigIssues({
  rpcUrl,
  horizonUrl,
  networkConfig,
  deployer,
});
```

---

## Result Type

Every function in `sorokit-core` returns a `SorokitResult<T>`. Nothing throws. Nothing rejects silently.

```ts
type SorokitResult<T> =
  | { status: "ok"; data: T; error: null }
  | { status: "error"; data: null; error: SorokitError };
```

**Usage:**

```ts
const result = await client.account.get(publicKey);

if (result.status === "ok") {
  console.log(result.data.balances);
} else {
  console.error(result.error.code, result.error.message);
}
```

This pattern means you handle errors where they happen, without wrapping everything in try/catch blocks or risking unhandled rejections propagating through your application.

---

## Wallet Adapters

Four adapters ship with `sorokit-core`. All require a [Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit) instance initialised separately:

```ts
import {
  FreighterAdapter,
  XBullAdapter,
  LobstrAdapter,
  HanaAdapter,
  SWKSignAdapter,
} from "sorokit-core";

const adapter = new FreighterAdapter(swkInstance);
const adapter = new XBullAdapter(swkInstance);
const adapter = new LobstrAdapter(swkInstance);
const adapter = new HanaAdapter(swkInstance); // NEW
const adapter = new SWKSignAdapter(swkInstance); // NEW
```

**New Features:**

- `HanaAdapter` - Support for Hana wallet integration
- `SWKSignAdapter` - Custom SWK-based signing adapter
- `signTransactionOffline()` - Sign transactions without wallet connection (NEW)
- `walletStatusTracker` - Real-time wallet connection monitoring (NEW)

Pass the adapter to `client.wallet.connect()` and `client.wallet.signTransaction()`. The adapter is the only stateful object in the system — the client itself remains stateless.

---

## Network Management

The SDK now includes circuit breaker and dynamic network switching:

```ts
// Circuit breaker for resilience (automatic)
const client = createSorokitClient({
  network: "testnet",
  enableCircuitBreaker: true, // Retries failed requests intelligently
});

// Dynamic network switching (new)
client.network.switchNetwork("mainnet"); // Switch at runtime

// Network resolution (new)
const resolved = await client.network.resolveNetwork("testnet");
if (resolved.status === "ok") {
  console.log(resolved.data.horizonUrl, resolved.data.rpcUrl);
}
```

**Features:**

- `circuitBreaker` - Automatic retry logic with exponential backoff
- `networkSwitcher` - Switch between networks without recreating client
- `resolveNetwork` - Programmatic network endpoint resolution

---

## Streaming

Account and transaction streams use async generators and poll Horizon at a configurable interval. Use an `AbortController` to stop a stream at any point:

```ts
const ac = new AbortController();

for await (const result of client.account.stream(
  publicKey,
  { intervalMs: 3000 },
  ac.signal,
)) {
  if (result.status === "ok") {
    // handle state update
  }
}

// Stop the stream from anywhere
ac.abort();
```

The same pattern applies to `client.transaction.stream()`.

### Real-time transaction SSE

Transaction streams can use Horizon Server-Sent Events to avoid polling latency.
The `sse` and `auto` transports fall back to polling when the endpoint is
unavailable or closes before emitting an event:

```ts
for await (const result of client.transaction.stream(publicKey, {
  transport: "auto",
})) {
  if (result.status === "ok") console.log(result.data.transactions);
}
```

### HTTP connection pooling

Configure a bounded per-origin pool before creating Horizon or Soroban servers.
Default behavior is unchanged when no pool is configured:

```ts
import { createConnectionPool, setConnectionPool } from "sorokit-core";

setConnectionPool(createConnectionPool({
  maxPoolSize: 10,
  keepAliveTimeoutMs: 30_000,
  socketTimeoutMs: 30_000,
}));
```

### Metrics and profiling

Use `Counter` for event counts and `Timer` for operation latency. Timers write to
the existing bounded metrics collector and can be exported with
`getPerformanceMetrics()` or `exportPerformanceMetrics()`:

```ts
const cacheHits = new Counter("cache.hit");
cacheHits.increment();
const timer = startTimer("transaction.submit");
try {
  await submit();
  timer.stop(true);
} catch (error) {
  timer.stop(false);
  throw error;
}
```

Applications that only need one subsystem can use the tree-shakeable
`sorokit-core/wallet` and `sorokit-core/account` entry points.

---

## Networks

```ts
// Preset networks
createSorokitClient({ network: "mainnet" });
createSorokitClient({ network: "testnet" });
createSorokitClient({ network: "futurenet" });

// Override Horizon or RPC URLs for self-hosted infrastructure
createSorokitClient({
  network: "mainnet",
  horizonUrl: "https://my-horizon.example.com",
  rpcUrl: "https://my-rpc.example.com",
});
```

---

## Testing Utilities

A mock client is provided for writing tests without hitting real network endpoints:

```ts
import {
  createMockClient,
  createMockWalletAdapter,
} from "sorokit-core/testing";

const client = createMockClient();

// Every method is a vi.fn() stub — override per test
client.account.get.mockResolvedValueOnce(
  ok({ publicKey: "G...", balances: [] }),
);

// Mock wallet adapter for signing flows
const adapter = createMockWalletAdapter();
```

> Requires `vitest` as a peer dependency.

---

## Examples

| Example | Shows |
| --- | --- |
| [`examples/router-swap`](examples/router-swap) | DEX swap: path discovery, quote, sign, submit, track |
| [`examples/react-wallet-connect`](examples/react-wallet-connect) | React: connect wallet, fetch balances, build + sign + submit payment |
| [`examples/vue-soroban`](examples/vue-soroban) | Vue 3: contract method selection, invoke with progress, account streaming |
| [`examples/next-serverless`](examples/next-serverless) | Next.js + Lambda: server-side signing, batch account ops, Vercel/AWS handler |

Examples are type-checked against the SDK source with `npm run typecheck:examples`.

For a side-by-side comparison of `stellar-sdk` patterns vs `sorokit-core`, see [docs/migration-guide.md](docs/migration-guide.md).

---

## Design Principles

**Stateless** — no internal state, no singleton, no side effects beyond network calls. Create as many clients as you need.

**No-throw** — every function returns `SorokitResult<T>`. Errors are values, not exceptions.

**Framework-agnostic** — zero dependency on React, Vue, or any UI framework. Works in Node, the browser, and server-side rendering environments.

**Adapter-based wallets** — wallet integration is delegated to [Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit), keeping `sorokit-core` decoupled from wallet implementation details.

---

## Examples

| Example                                        | Shows                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`examples/router-swap`](examples/router-swap) | Frontend router integration: quote → swap → transaction tracking, with wallet signing and router error handling |

Examples are type-checked against the SDK source with `npm run typecheck:examples`.

---

## New in This Release

### Major Features

- ✅ **Circuit Breaker** - Automatic resilience for failed network requests
- ✅ **Dynamic Network Switching** - Change networks without recreating the client
- ✅ **Transaction Simulation** - Test transactions before sending (simulator module)
- ✅ **Contract Interaction Builder** - Fluent API for complex contract calls
- ✅ **Event Decoding** - Programmatic contract event parsing
- ✅ **Deploy Validation** - Pre-flight validation for contract deployments with actionable error messages
- ✅ **Offline Signing** - Sign transactions without wallet connection
- ✅ **Multi-Signature Support** - Build and manage multi-sig transactions
- ✅ **Path Payments** - Advanced path payment calculations
- ✅ **Transaction History** - Export and query historical transactions with flexible formats
- ✅ **Wallet Adapters** - Hana and SWK signing adapters for extended wallet support
- ✅ **Balance Alerts** - Monitor account balance changes in real-time
- ✅ **Activity Summaries** - Aggregate account activity metrics and analytics
- ✅ **Key Rotation** - Rotate account keys securely
- ✅ **Sponsorship** - Manage account sponsorships
- ✅ **Distributed Tracing** - Debug transactions and calls with detailed tracing
- ✅ **Advanced Logging** - Structured logging with multiple levels and configurable output
- ✅ **Configuration Management** - Centralized config validation with per-field guidance

### Testing Enhancements

- 30+ new test files with comprehensive coverage
- Property-based testing for transaction building
- Router integration tests with real-world scenarios
- Network resilience and circuit breaker tests
- Contract deployment validation tests

### Performance

- Bundle size tracking with 50 KB gzipped budget
- Optimized network calls with circuit breaker
- Efficient contract state tracking
- Reduced memory footprint with streaming

---

## Contributing

Pull requests are welcome. For significant changes, please open an issue first to discuss what you'd like to change.

---

## Workflow and Architecture Guides

The documentation now includes task-oriented, executable workflows and a contributor-facing architecture guide:

| Guide | Use it for |
| --- | --- |
| [`docs/workflows.md`](docs/workflows.md) | Complete transaction lifecycle, wallet signing, multisignature signing, Soroban calls, trustline approval, cost planning, refunds, and recovery patterns |
| [`docs/architecture.md`](docs/architecture.md) | Module boundaries, data flow, result/error conventions, extension guidance, and migration from direct Stellar SDK usage |

Both guides use the current exported API shape and keep policy, construction, signing, submission, and recovery concerns separate.

---

## License

[MIT](LICENSE)

# Factory statistics

API servers can expose `getFactoryStatistics` at a route such as
`GET /factory/:id/statistics`. Supply an adapter that reads the factory pair
count and deployment metadata; the function returns Sorokit's standard
structured JSON result.

# Decode factory and router events

```ts
import { decodeContractEvent, queryContractEvents } from "sorokit-core";

const events = await queryContractEvents(factoryId, undefined, { horizonUrl });
for (const event of events) {
  const decoded = decodeContractEvent(event);
  if (decoded?.type === "factory.pair_created") {
    console.log(decoded.data);
  }
}
```

Pass custom decoders as the second argument to support application-specific
events. Custom decoders run first, so adding new built-in event types remains
backward-compatible.

### Mainnet transaction safety

Mainnet submissions require explicit confirmation when native XLM exposure exceeds
1,000 XLM (configurable). Both `client.transaction.submit` and its
`submitTransaction` alias return `MAINNET_SAFETY_LIMIT` before contacting Horizon
unless `bypassMainnetSafety` is exactly `true`:

```ts
const result = await client.transaction.submitTransaction(signedXdr, {
  mainnetSafetyThresholdXlm: 1000,
  bypassMainnetSafety: true, // Set only after reviewing the transaction.
});
```

Warnings include the native amount, threshold, source account, operation count,
and operation types whose exposure cannot be determined from XDR. Account merges,
balance claims, liquidity pools, and contract calls require confirmation even when
no large amount is visible in the envelope. Native offers and payment spend limits
are counted with exact stroop arithmetic. Fees, reserve changes, and non-native
asset valuations are outside this guard. Other networks are unaffected.

Soroban submissions use the same guard. Pass safety options as the fourth argument
to `client.soroban.execute`, or the fifth to `client.soroban.invoke`:

```ts
await client.soroban.execute(signedXdr, undefined, undefined, {
  bypassMainnetSafety: true,
});
```
