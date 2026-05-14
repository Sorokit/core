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
- [Streaming](#streaming)
- [Networks](#networks)
- [Testing Utilities](#testing-utilities)
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

| Module        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `wallet`      | Connect and disconnect wallets, sign transactions via SWK adapters    |
| `account`     | Fetch account info, balances, and stream account state                |
| `transaction` | Build, submit, and track transactions; estimate fees; stream activity |
| `soroban`     | Read and invoke Soroban smart contracts                               |
| `network`     | Network configuration for mainnet, testnet, and futurenet             |

---

## API Reference

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

// Stream transactions for an account
for await (const result of client.transaction.stream(publicKey)) {
  if (result.status === "ok") console.log(result.data.transactions);
}
```

### `soroban`

```ts
client.soroban.simulate(transactionXdr)         // → SorokitResult<SimulateTransactionResult>
client.soroban.prepare(params)                  // → SorokitResult<PreparedContractCall>
client.soroban.execute(signedXdr)               // → SorokitResult<string> (tx hash)
client.soroban.read(params)                     // → SorokitResult<ContractCallResult>

// Full invoke pipeline: prepare → sign → execute in one call
client.soroban.invoke(params, (xdr) =>
  adapter.signTransaction({ transactionXdr: xdr, ... })
)
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

Three adapters ship with `sorokit-core`. All require a [Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit) instance initialised separately:

```ts
import { FreighterAdapter, XBullAdapter, LobstrAdapter } from "sorokit-core";

const adapter = new FreighterAdapter(swkInstance);
const adapter = new XBullAdapter(swkInstance);
const adapter = new LobstrAdapter(swkInstance);
```

Pass the adapter to `client.wallet.connect()` and `client.wallet.signTransaction()`. The adapter is the only stateful object in the system — the client itself remains stateless.

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

## Design Principles

**Stateless** — no internal state, no singleton, no side effects beyond network calls. Create as many clients as you need.

**No-throw** — every function returns `SorokitResult<T>`. Errors are values, not exceptions.

**Framework-agnostic** — zero dependency on React, Vue, or any UI framework. Works in Node, the browser, and server-side rendering environments.

**Adapter-based wallets** — wallet integration is delegated to [Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit), keeping `sorokit-core` decoupled from wallet implementation details.

---

## Contributing

Pull requests are welcome. For significant changes, please open an issue first to discuss what you'd like to change.

---

## License

[MIT](LICENSE)
