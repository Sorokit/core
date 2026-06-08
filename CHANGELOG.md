# Changelog

All notable changes to sorokit-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

### Changed

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
