# Changelog

All notable changes to sorokit-core are documented in this file.

> **This file is auto-generated.** Do not edit it manually.
>
> Entries are generated from [Conventional Commits](https://www.conventionalcommits.org/)
> by [semantic-release](https://github.com/semantic-release/semantic-release) during the
> release workflow (`.github/workflows/release.yml`). Version numbers and release notes
> follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
>
> To add an entry, use a conventional commit message (`feat:`, `fix:`, `perf:`, etc.)
> in your pull request. See `CONTRIBUTING.md` for details.

## Historical Entries (pre-automation)

The entries below were maintained manually before CHANGELOG generation was automated
(#1014). They are preserved for reference and are no longer updated.

### Unreleased

### Added

- Wallet state manager (#1006): `WalletStateManager` / `saveWalletState()` in `src/wallet/stateManager.ts` persists wallet connections, active accounts, and user settings across reloads with encryption.
- Wallet upgrade helper (#1005): `checkWalletVersion()` in `src/wallet/versionCheck.ts` detects and warns on outdated wallet extensions below minimum supported versions.
- Wallet security checklist (#1004): Comprehensive audit checklist in `docs/wallet-security-checklist.md` covering key protection, backups, and network verification.
- Transaction comparator (#1003): `compareTxs()` in `src/utilities/transactionComparator.ts` diffs two transactions and highlights changed operations, fees, and signatures.

- Request deduplication (#971): `RequestDeduplicator` / `createDeduplicator()` in `src/network/deduplication.ts` combines identical concurrent requests (same URL + params, key order ignored) into one in-flight request and shares the response or error with every caller. Entries are removed as soon as a request settles, so it is not a cache. Exported from `sorokit-core/network` and the root.
- Event-invalidated cache (#972): `EventSmartCache` / `createEventSmartCache()` in `src/performance/smartCache.ts` with `.set(key, value, ttl, invalidateOn?)`, `.get(key)`, `.invalidate(event)`, `.hit()`, `.miss()` and `.stats()`. Invalidation removes entries and their event bookkeeping. Exported from `src/performance/index.ts` and the root (named `EventSmartCache` to stay distinct from the existing `SmartCache`).
- Transaction polling (#973): `waitForTransaction(hash, timeout?, interval?, options?)` polls Horizon until a transaction is confirmed. Defaults: 30 000 ms timeout, 1 000 ms interval; optional `maxRetries`, `signal` and `fetchStatus`. Returns `TX_NOT_FOUND`, `OPERATION_TIMEOUT` or the last lookup error when it gives up. Exported from `sorokit-core/transaction` and the root.
- Transaction sponsorship builder (#974): `sponsorTransaction(tx, sponsorKey)` and `sponsorOperation(op, sponsorKey, sponsoredKey?)` wrap operations in a `beginSponsoringFutureReserves` / `endSponsoringFutureReserves` pair so the sponsor pays the reserves. The result is unsigned and must be signed by both sponsor and sponsored account; Soroban operations are rejected. Exported from `sorokit-core/transaction` and the root.
- Single-offer query (#946): `getOffer(offerId)` (alias `getAccountOffer`) fetches one offer from Horizon by id and returns a typed `Offer` (`OfferInfo`) with seller, selling and buying assets, `price` and `amount`. Returns the new `OFFER_NOT_FOUND` error code when Horizon answers 404, `VALIDATION` for a malformed id (without making a request), and `ACCOUNT_FETCH_FAILED` otherwise. Exported from `sorokit-core/account` and the root. See `docs/recipes/07-offer-management.md`.
- Lazy loading (#682): `sorokit-core/lazy` entry with `loadModule(name)`, `preloadModules`, `isModuleLoaded` and `getLoadedModules` over a registry of lazy-loadable modules (soroban, integration, governance, keyManagement, streaming, privacy, compliance). Its initial load is ~0.5 KiB gzip, versus 50.3 KiB when the same modules are imported eagerly. `src/lazy.ts` moved to `src/lazy/index.ts` with its existing exports unchanged. See `docs/lazy-loading.md`.
- Governance (#686): `getProposals`, `getProposal`, `voteOnProposal`, `getVotingPower` and `trackProposal` in `src/integration/governance.ts`, with a pluggable `GovernanceProvider`, `createHttpGovernanceProvider` and `configureGovernance`. Available on `client.integration` and exported from `sorokit-core/integration` and the root (as `getGovernanceVotingPower`). See `docs/governance.md`.
- Initial public release of sorokit-core
- Framework-agnostic TypeScript SDK for Stellar wallet connection, transactions, and Soroban contract interaction
- `wallet` module for connecting and disconnecting wallets, signing transactions via SWK adapters
- `account` module for fetching account info, balances, and streaming account state
- `transaction` module for building, submitting, and tracking transactions; fee estimation; and transaction streaming
- `soroban` module for reading and invoking Soroban smart contracts
- `network` module for configuration of mainnet, testnet, and futurenet
- No-throw result model (`SorokitResult<T>`) for all operations
- Support for Freighter, XBull, and Lobstr wallet adapters
- Async generator-based streaming for accounts and transactions
- Testing utilities with mock client and mock wallet adapter
- Comprehensive TypeScript types for all operations
- ESLint and TypeScript configuration for code quality
- Vitest test suite with coverage
- `validateDeployConfig`, `collectDeployConfigIssues`, and `formatDeployConfigIssues` for
  pre-flight validation of contract deployment configuration, reporting every missing or
  malformed value with an actionable fix (#356)
- `examples/router-swap` — frontend reference for router integration covering quote
  retrieval, swap execution, and transaction tracking (#357)
- `npm run typecheck:examples` to type-check bundled examples against the SDK source

### Fixed

### Changed

- `buildContractDeploy` validates its configuration before contacting the network and
  returns `INVALID_CONFIG` with per-field guidance instead of an opaque RPC or SDK error (#356)

### Deprecated

### Removed

### Security

---

## Release History

> Releases from this point forward are generated automatically by semantic-release and
> appended above this section. Do not add release notes here manually.
