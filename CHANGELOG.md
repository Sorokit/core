# Changelog

All notable changes to sorokit-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Liquidity pool queries (#949, #950): `getLiquidityPools(filters?)` lists pools from Horizon (filter by account and/or one or two assets, page with `cursor`/`limit`/`order`; each pool includes its fee and reserves) and `getLiquidityPoolByAssets(assetA, assetB)` finds the pools holding an asset pair in either order, in `src/network/queries.ts`.
- Fee estimation (#953): `estimateFeeByOperationCount(operationCount, baseRate = 100)` returns `SorokitResult<EstimatedFee>` using `operationCount × baseRate` stroops (exact string totals, plus XLM) in `src/transaction/feeEstimation.ts`. It is a local calculation; `estimateFee` still queries the network.
- Memo builders (#954): `buildTextMemo`, `buildIdMemo` and `buildHashMemo` return `SorokitResult` instead of throwing, validating the 28-byte text, unsigned 64-bit id and 32-byte hash limits, in `src/transaction/memoBuilder.ts`.
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

> Versions will be documented here as they are released following Semantic Versioning conventions.
>
> Format:
>
> - **[Version] - YYYY-MM-DD**: Release date and notes
> - Sections: Added, Changed, Fixed, Deprecated, Removed, Security
