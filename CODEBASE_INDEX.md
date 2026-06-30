# Codebase Index

## Project

`sorokit-core` is a framework-agnostic TypeScript SDK for Stellar wallet connection, account access, transaction handling, and Soroban contract interaction.

The main design rule is a no-throw public API: public functions return `SorokitResult<T>` from `src/shared/response.ts`.

## Package Entrypoints

- `src/index.ts` is the primary public API.
- `src/testing/index.ts` is the secondary testing export exposed as `sorokit-core/testing`.
- `src/client.ts` is a deprecated compatibility export for `createSorokitClient`.
- `tsup.config.ts` builds CommonJS, ESM, declarations, and sourcemaps from `src/index.ts` and `src/testing/index.ts`.

## Public Client

The central entrypoint is `createSorokitClient(config)` in `src/client/createSorokitClient.ts`.

It resolves network config, creates logging/error-handling wrappers, and returns a namespaced `SorokitClient`:

- `client.wallet`: connect, disconnect, sign XDR, empty wallet state.
- `client.account`: fetch account, fetch balances, filter balances, stream account state, format addresses.
- `client.transaction`: build payment/create-account/trustline transactions, submit signed XDR, query transaction status, estimate fees, stream transactions.
- `client.soroban`: simulate, prepare, execute, invoke, and read Soroban contract calls.
- `client.network`: return resolved network config.

`createSorokitClient.ts` is intentionally the only file that imports across multiple feature modules.

## Directory Map

### `src/client`

- `createSorokitClient.ts`: client factory, public `SorokitClient` and `SorokitClientConfig` types, module wiring.
- `index.ts`: re-exports the client factory and types.

### `src/wallet`

Wallet adapter facade and wallet state helpers.

- `connect.ts`: checks adapter availability and returns connected `WalletState`.
- `disconnect.ts`: disconnects an adapter and returns disconnected wallet state.
- `signTransaction.ts`: signs transaction XDR through a wallet adapter.
- `types.ts`: wallet adapter, wallet state, SWK, and signing types.
- `adapters/interface.ts`: adapter interface foundation.
- `adapters/freighter.ts`: Freighter adapter.
- `adapters/xbull.ts`: xBull adapter.
- `adapters/lobstr.ts`: Lobstr adapter.
- `index.ts`: module exports plus `emptyWalletState()`.

### `src/account`

Horizon-backed account reads and polling.

- `getAccount.ts`: loads account details and normalizes balances.
- `getBalances.ts`: returns account balances only.
- `getAssetBalances.ts`: filters balances by asset code, issuer, type, and zero-balance handling.
- `streamAccount.ts`: async generator polling Horizon for account state.
- `types.ts`: `AccountInfo` and `AssetBalance`.
- `index.ts`: module exports.

### `src/transaction`

Horizon transaction building, submission, status, fee estimation, and transaction polling.

- `buildTransaction.ts`: builds payment, create-account, trustline, payment-with-trustline, and swap XDR.
- `submitTransaction.ts`: submits signed XDR to Horizon.
- `status.ts`: fetches transaction status by hash.
- `estimateFee.ts`: simulates XDR or sample payment via Soroban RPC, with optional cache support.
- `feeSurge.ts`: fee surge helper logic.
- `simulateTransaction.ts`: transaction simulation helper.
- `streamTransactions.ts`: async generator polling Horizon transaction activity.
- `types.ts`: transaction parameter and result types.
- `index.ts`: module exports.

Note: `buildPaymentWithTrustline` and `buildSwapTransaction` are exported from `transaction/index.ts`, but are not currently exposed on the high-level `SorokitClient.transaction` namespace.

### `src/soroban`

Soroban RPC contract operations.

- `validateContractAbi.ts`: validates ABI method presence and argument count.
- `simulateTransaction.ts`: simulates transaction XDR through Soroban RPC.
- `prepareCall.ts`: builds, simulates, and assembles a contract call XDR.
- `executeContract.ts`: submits signed XDR and polls for confirmation.
- `invokeContract.ts`: full prepare -> sign -> execute pipeline.
- `readContract.ts`: read-only contract call path.
- `types.ts`: contract ABI, invoke/read params, prepared call, polling, and simulation types.
- `index.ts`: module exports.

### `src/network`

Network defaults and resolution.

- `config.ts`: `mainnet`, `testnet`, and `futurenet` defaults.
- `resolveNetwork.ts`: applies network selection and URL overrides.
- `getNetwork.ts`: network retrieval helper.
- `setNetwork.ts`: network update helper.
- `types.ts`: network-related types.
- `index.ts`: module exports.

### `src/shared`

Cross-cutting utilities.

- `response.ts`: `SorokitResult<T>`, `SorokitErrorCode`, `ok`, `err`, `isOk`, `isErr`.
- `errors.ts`: error normalization, transient/not-found/rejection checks, optional error handler support.
- `logger.ts`: logger abstraction and operation logging wrapper.
- `cache.ts`: cache interface.
- `constants.ts`: shared defaults such as transaction timeout and fee cache TTL.
- `utils.ts`: address formatting, retry/backoff, and shared helpers.
- `types.ts`: shared network config shape.
- `index.ts`: shared exports.

### `src/types`

Type barrel files for public or consumer-facing type groups:

- `account.ts`
- `cache.ts`
- `network.ts`
- `result.ts`
- `soroban.ts`
- `transaction.ts`
- `wallet.ts`
- `index.ts`

### `src/testing`

Consumer testing helpers.

- `mockClient.ts`: Vitest-powered `createMockClient()`, mock wallet adapter, and default fixtures.
- `index.ts`: testing exports.

### `src/tests`

Vitest suite organized by behavior:

- `account.test.ts`
- `client.test.ts`
- `logger.test.ts`
- `network.test.ts`
- `result.test.ts`
- `shared.test.ts`
- `soroban.test.ts`
- `transaction.test.ts`
- `wallet.test.ts`

## Public API Exports

From `src/index.ts`:

- `createSorokitClient`
- wallet adapters: `FreighterAdapter`, `XBullAdapter`, `LobstrAdapter`
- wallet types and `WalletType`
- network helpers/defaults: `resolveNetwork`, `NETWORK_DEFAULTS`
- account, transaction, Soroban, result, logger, and cache types
- result helpers: `ok`, `err`, `isOk`, `isErr`, `SorokitErrorCode`

From `src/testing/index.ts`:

- mock client and wallet adapter helpers
- testing fixtures from `mockClient.ts`

## Runtime Dependencies

- `@stellar/stellar-sdk`: Horizon, Soroban RPC, transaction builders, assets, operations, contracts.
- `@creit.tech/stellar-wallets-kit`: peer dependency for wallet adapter infrastructure.
- `vitest`: peer/dev dependency because testing helpers expose `vi.fn()` stubs.

## Common Commands

- `npm run build`: build package with `tsup`.
- `npm run typecheck`: run TypeScript checking.
- `npm test`: run Vitest once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run lint`: run ESLint over `src`.
- `npm run clean`: remove `dist`.

## Architectural Notes

- Public SDK methods generally return `SorokitResult<T>` instead of throwing.
- Two pure utilities return raw values by design: `wallet.emptyState()` returns a result synchronously, while `account.formatAddress()` returns a raw string.
- Client-level logging wraps most high-level operations through `withLogging`.
- Client-level `errorHandler` is applied to account and Soroban methods through `withErrorHandling`.
- Account and transaction streams are async generators that poll Horizon.
- Fee estimation can cache estimates by SHA-256 hash of transaction XDR.
- Soroban invocation is split into independently callable stages: prepare, sign, execute.

## Good Starting Points

- To understand consumer usage, start with `README.md`, then `src/client/createSorokitClient.ts`.
- To change public exports, inspect `src/index.ts` and `package.json` `exports`.
- To add a new client method, wire the implementation through `src/client/createSorokitClient.ts`, export types from `src/index.ts`, and add focused tests under `src/tests`.
- To debug result behavior, start at `src/shared/response.ts`.
- To debug network behavior, start at `src/network/config.ts` and `src/network/resolveNetwork.ts`.
