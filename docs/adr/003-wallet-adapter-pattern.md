# ADR-003: Wallet Adapter Pattern

**Status:** Accepted

## Problem

Stellar has many distinct wallets — Freighter, xBull, Albedo, Rabet, Lobstr,
Hana, WalletConnect-based mobile wallets, and Stellar Wallets Kit (SWK) as a
meta-wallet-picker — each with its own injected global, connection flow,
and signing API. A caller who wants to "connect a wallet and sign a
transaction" shouldn't need to learn seven different vendor APIs, and this
SDK shouldn't hard-code assumptions about any one of them into its core
transaction/account logic. New wallets also appear over time (Hana and SWK
support were both added after the SDK's initial wallet set —
`src/wallet/adapters/hana.ts`, `src/wallet/adapters/swkSign.ts`), so the
integration point needs to accept new implementations without every addition
touching unrelated code.

## Options Considered

1. **Hard-code each wallet's API directly** into `connectWallet`/
   `signTransaction`, branching on a `walletType` parameter. Fewer files
   initially, but every wallet-specific quirk leaks into shared code, and
   adding a wallet means editing functions every other wallet also depends
   on — a correctness risk as the set grows.
2. **Delegate entirely to a single third-party wallet-connection library**
   and expose nothing of this SDK's own. Minimizes code here, but couples
   every consumer to that library's API surface and release cadence, and
   this SDK explicitly aims to stay framework/vendor-agnostic at its core
   (see ADR-002).
3. **A `WalletAdapter` interface**, one implementation per wallet, with
   shared code depending only on the interface.

## Decision

`src/wallet/types.ts` defines `WalletAdapter`: `walletType`, `isAvailable()`,
`connect()`, `disconnect()`, `signTransaction(input)`, plus optional
capability-declaration and multi-account methods
(`getCapabilities?()`, `getAccounts?()`). Every supported wallet is one file
under `src/wallet/adapters/` implementing that interface —
`freighter.ts`, `xbull.ts`, `albedo.ts`, `rabet.ts`, `lobstr.ts`, `hana.ts`,
`walletconnect.ts`, plus `swkSign.ts` for signing through Stellar Wallets
Kit specifically. `src/wallet/adapters/interface.ts` re-exports the contract
types from `wallet/types.ts` so adapter files (and external consumers
writing their own adapter) have one stable, explicit import path rather
than reaching into the wallet module's other internals. `connectWallet`,
`signTransaction`, and the rest of the shared wallet code
(`src/wallet/connect.ts`, `src/wallet/signTransaction.ts`) operate only
against the `WalletAdapter` interface — never against a specific wallet's
API — matching the "Adapter-based wallets" principle already stated in the
README's Design Principles section: wallet integration is delegated to
adapters (built primarily on
[Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit)),
keeping `sorokit-core` decoupled from any one wallet implementation.

```ts
// Shared code depends only on the interface — never a concrete wallet:
async function signTransaction(adapter: WalletAdapter, input: SignTransactionInput) {
  if (!adapter.isAvailable()) return err(/* WALLET_NOT_FOUND */);
  return adapter.signTransaction(input);
}
```

Every adapter method returns `SorokitResult<T>` (ADR-001), so a wallet
rejection, a missing extension, or a signing failure all surface through the
same error-handling path a caller already uses for every other SDK call —
wallet errors are not a special case.

## Consequences

**Positive:**
- Adding a new wallet is additive: one new file implementing
  `WalletAdapter`, registered wherever adapters are discovered/listed
  (`src/wallet/discovery.ts`). No existing adapter or shared wallet code is
  touched.
- Shared logic (connection flow, signing flow, device trust evaluation) is
  written once, tested once, and automatically applies to every wallet.
- A consumer can implement `WalletAdapter` for a wallet this SDK doesn't
  ship an adapter for, and use it with the same `connectWallet`/
  `signTransaction` flow as a built-in one.

**Trade-offs accepted:**
- The interface is intentionally minimal (connect/disconnect/sign, plus
  optional capability/multi-account extensions) — a wallet with a genuinely
  unique capability outside that surface needs either an optional-method
  extension to `WalletAdapter` (as `getCapabilities`/`getAccounts` already
  were) or bespoke handling outside the adapter pattern. The interface has
  grown by addition, not by anticipating every future wallet feature
  upfront.
- Adapters that wrap another library (Stellar Wallets Kit, WalletConnect's
  sign client) still carry that library as a peer dependency
  (`package.json`'s `peerDependencies`/`peerDependenciesMeta`) — the adapter
  pattern isolates *this SDK's* code from wallet specifics, but doesn't
  eliminate the underlying library dependency for consumers who use that
  adapter.
