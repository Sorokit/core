# Sorokit Issues Backlog

## Issue #1

**Title** — Refactor signTransaction to return SorokitResult and align XDR input contract

**Description:**

**Problem:**
`src/wallet/signTransaction.ts` currently returns a raw signed XDR string or undefined, breaking the no-throw contract the rest of the SDK follows. Callers have no way to distinguish user rejection from network failure from a missing keypair. Additionally, the function accepts a raw Transaction object instead of an XDR string, inconsistent with how `submitTransaction()` in `src/transaction/submitTransaction.ts` expects input, forcing manual serialization before submission.

**Solution:**
Refactor `signTransaction()` to return `SorokitResult<string>` where the data is the signed XDR string. Catch all wallet adapter errors inside the function and map them to `SorokitError` with descriptive codes (`WALLET_SIGN_REJECTED`, `WALLET_SIGN_FAILED`). Align input contract to accept XDR string directly, matching `submitTransaction()` expectations.

**Acceptance Criteria:**

- [ ] `signTransaction()` returns `SorokitResult<string>` in all code paths
- [ ] User rejection returns `{ status: 'error', error: { code: 'WALLET_SIGN_REJECTED', message: '...' } }`
- [ ] Network/adapter failure returns `{ status: 'error', error: { code: 'WALLET_SIGN_FAILED', message: '...' } }`
- [ ] Output XDR string is accepted directly by `submitTransaction()` without additional transformation
- [ ] Existing tests in `src/tests/wallet.test.ts` updated, at least two new tests added covering rejection and failure cases
- [ ] No breaking changes to public API in `src/index.ts`

**Note for contributors:**
All error handling must stay inside `src/wallet/signTransaction.ts` and surface through `SorokitResult`. The `SorokitError` type is defined in `src/shared/response.ts` — extend error codes there if needed. Check `src/transaction/submitTransaction.ts` before touching XDR contract to avoid breaking the submit flow.

---

## Issue #2

**Title** — Consolidate error detection utilities and improve error classification accuracy

**Description:**

**Problem:**
Error handling utilities are scattered across `src/shared/errors.ts` but lack comprehensive coverage. Currently:

- `toMessage()`, `isNotFoundError()`, `isUserRejection()` are defined but missing timeout and network connectivity detection
- `src/soroban/prepareCall.ts` and `src/transaction/simulateTransaction.ts` don't detect RPC timeout errors, resulting in generic `UNKNOWN` error codes
- No validation for malformed XDR strings before processing in `src/transaction/buildTransaction.ts` leads to confusing error messages

**Solution:**
Extend `src/shared/errors.ts` with three new detection functions: `isTimeoutError()`, `isNetworkConnectivityError()`, `isXdrInvalidError()`. Update all callers in `src/wallet/adapters/freighter.ts`, `src/transaction/buildTransaction.ts`, and `src/soroban/prepareCall.ts` to use the new utilities for accurate error classification.

**Acceptance Criteria:**

- [ ] `isTimeoutError(cause)` added to `src/shared/errors.ts`, detects AbortError, ETIMEDOUT, RPC timeout patterns
- [ ] `isNetworkConnectivityError(cause)` distinguishes network outage from RPC service issues
- [ ] `isXdrInvalidError(cause)` validates XDR format before TransactionBuilder processes
- [ ] All call sites in wallet adapters, transaction, soroban modules updated
- [ ] Tests added to `src/tests/shared.test.ts` covering all three functions with valid and invalid inputs
- [ ] No changes to `SorokitErrorCode` enum — only detection logic improves
- [ ] Backward compatibility maintained: existing error handling behavior unchanged

**Note for contributors:**
Reference existing patterns in `src/shared/utils.ts` (e.g., `isBrowser()`). Test both success and failure paths for each detection function. Ensure new utilities are exported in `src/shared/index.ts`.

---

## Issue #3

**Title** — Add comprehensive input validation for account public keys across all account functions

**Description:**

**Problem:**
`src/account/getAccount.ts`, `src/account/getBalances.ts`, and `src/account/streamAccount.ts` accept public keys without validation. Invalid keys (wrong format, wrong length, invalid checksum) reach the Horizon API before failing, resulting in generic `ACCOUNT_FETCH_FAILED` errors instead of early validation errors. No utility exists to validate Stellar public key format.

**Solution:**
Create a validation utility in `src/shared/utils.ts`: `isValidPublicKey(key): boolean`. Use it in all account functions before making Horizon calls. Return `SorokitResult` with `ACCOUNT_FETCH_FAILED` code if validation fails (not a new error code, keeps consistency).

**Acceptance Criteria:**

- [ ] `isValidPublicKey()` added to `src/shared/utils.ts`, validates format, length, and checksum
- [ ] `getAccount()`, `getBalances()`, `getAssetBalances()`, `streamAccount()` all call validation before API
- [ ] Invalid keys return immediate error with descriptive message
- [ ] Tests added to `src/tests/shared.test.ts` covering valid and invalid key formats
- [ ] Validation utility exported in `src/shared/index.ts`
- [ ] No new error codes added

**Note for contributors:**
Reference Stellar SDK's public key validation if available, or implement checksum validation using base32 encoding. Test edge cases: null, empty string, wrong length, invalid characters, valid format but wrong checksum.

---

## Issue #4

**Title** — Implement retry logic with exponential backoff for Horizon API calls

**Description:**

**Problem:**
`src/account/getAccount.ts`, `src/transaction/submitTransaction.ts`, and `src/soroban/prepareCall.ts` make direct Horizon/RPC calls without retry logic. Transient failures (brief network hiccups, service blips) fail immediately, forcing users to retry manually. No backoff strategy exists, risking rate limiting.

**Solution:**
Create a retry utility in `src/shared/utils.ts`: `retryWithBackoff(fn, maxAttempts, initialDelayMs)` that implements exponential backoff with jitter. Update `getAccount()`, `submitTransaction()`, and `prepareContractCall()` to wrap their Horizon calls with retry logic. Configure with sensible defaults (3 attempts, 100ms initial delay).

**Acceptance Criteria:**

- [ ] `retryWithBackoff()` utility added to `src/shared/utils.ts`
- [ ] Exponential backoff formula: delay = initialDelay \* Math.pow(2, attemptNumber) + randomJitter
- [ ] `getAccount()` wraps `server.loadAccount()` with retry
- [ ] `submitTransaction()` wraps `server.submitTransaction()` with retry
- [ ] `prepareContractCall()` wraps `rpc.simulateTransaction()` with retry
- [ ] Tests added covering successful retry, exhausted retries, and immediate success
- [ ] Retry limits configurable but default to safe values
- [ ] No new error codes; retries transparent to caller

**Note for contributors:**
Only retry on transient errors (timeouts, ECONNRESET, 500-series), not permanent errors (404, invalid params). Reference `src/shared/errors.ts` for error detection. Export `retryWithBackoff` in `src/shared/index.ts`.

---

## Issue #5

**Title** — Add streaming state deduplication to prevent duplicate event emissions

**Description:**

**Problem:**
`src/account/streamAccount.ts` and `src/transaction/streamTransactions.ts` poll Horizon at fixed intervals without deduplication. If account state hasn't changed between polls, the same `AccountInfo` or transaction list is emitted multiple times, causing unnecessary re-renders and state updates in consumers.

**Solution:**
Implement a state comparison utility that compares the new polled state against the last emitted state (by reference or deep equality). Only emit new state if it differs. Store the last emitted state in the async generator closure.

**Acceptance Criteria:**

- [ ] `streamAccount()` in `src/account/streamAccount.ts` deduplicates by comparing `AccountInfo` objects
- [ ] `streamTransactions()` in `src/transaction/streamTransactions.ts` deduplicates by comparing transaction lists
- [ ] State comparison uses deep equality (check balances, sequence, etc.)
- [ ] Generator only yields when new state differs from last
- [ ] Tests added covering duplicate, changed, and partial state scenarios
- [ ] No performance regression; comparison logic is efficient
- [ ] Backward compatible; no API changes

**Note for contributors:**
Consider using a simple deep equality check or JSON stringification for comparison. Store last state in closure. Update `src/tests/account.test.ts` and `src/tests/transaction.test.ts` with new test cases.

---

## Issue #6

**Title** — Implement network passphrase validation before transaction submission

**Description:**

**Problem:**
`src/transaction/submitTransaction.ts` accepts a signed XDR without validating that it was signed for the correct network. Submitting a testnet-signed transaction to mainnet fails at the Horizon API with a cryptic error, not caught early. Users can lose time debugging.

**Solution:**
Before submission, extract the network passphrase from the signed XDR envelope and compare against `networkConfig.networkPassphrase` in `src/transaction/submitTransaction.ts`. Return early with a descriptive error if mismatch detected.

**Acceptance Criteria:**

- [ ] Network passphrase extracted from signed XDR envelope
- [ ] Comparison against `networkConfig.networkPassphrase` before submission
- [ ] Mismatch returns error with code `TX_SUBMIT_FAILED` and message identifying the passphrase mismatch
- [ ] Tests added covering matching and mismatched passphrases
- [ ] No API changes; validation transparent

**Note for contributors:**
Use `@stellar/stellar-sdk` utilities to extract envelope and read passphrase. Reference `src/transaction/buildTransaction.ts` for network config access pattern. Add test cases to `src/tests/transaction.test.ts`.

---

## Issue #7

**Title** — Add contract method signature validation before Soroban invocation

**Description:**

**Problem:**
`src/soroban/prepareCall.ts` and `src/soroban/readContract.ts` accept method names and arguments without validating they match the contract's spec file. Invoking a non-existent method or with wrong argument count fails during simulation with a generic contract error, not caught early.

**Solution:**
Implement optional contract ABI validation. Accept an optional `contractAbi` parameter in `ContractInvokeParams` and `ContractReadParams`. If provided, validate method exists and argument count matches before building the transaction.

**Acceptance Criteria:**

- [ ] `ContractInvokeParams` and `ContractReadParams` in `src/soroban/types.ts` accept optional `contractAbi` field
- [ ] `prepareContractCall()` validates method name and arg count if ABI provided
- [ ] `readContract()` validates method name and arg count if ABI provided
- [ ] Invalid method returns error with code `CONTRACT_PREPARE_FAILED` before simulation
- [ ] Tests added covering valid method, non-existent method, and wrong arg count
- [ ] Validation is optional; if no ABI provided, behaves as before

**Note for contributors:**
ABI validation is optional to maintain backward compatibility. Reference `ContractInvokeParams` shape and add tests to `src/tests/soroban.test.ts`. Contract ABI structure follows Soroban spec (method array with name, args, returns).

---

## Issue #8

**Title** — Implement fee estimation caching to reduce RPC calls

**Description:**

**Problem:**
`src/transaction/estimateFee.ts` calls `simulateTransaction()` on the RPC for every fee estimate request, even if the same transaction is estimated multiple times. No caching exists, leading to unnecessary RPC calls and rate limiting risk.

**Solution:**
Implement optional transaction fee caching using the pluggable cache interface already in `src/shared/cache.ts`. If a cache is provided to the client, hash the transaction XDR and use it as a cache key. Cache fee estimates for 5 minutes by default.

**Acceptance Criteria:**

- [ ] `estimateFee()` in `src/transaction/estimateFee.ts` checks cache before calling RPC
- [ ] Cache key is SHA256 hash of transaction XDR
- [ ] Cache hit returns cached fee without RPC call
- [ ] Cache miss simulates, stores result, returns fee
- [ ] Cache TTL configurable, defaults to 5 minutes
- [ ] Tests added covering cache hit, miss, and expiry
- [ ] Backward compatible; if no cache provided, behaves as before

**Note for contributors:**
Reference `src/shared/cache.ts` for cache interface. Use Node crypto for hashing or lightweight hash library. Update `src/client/createSorokitClient.ts` to pass cache to fee estimation. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #9

**Title** — Add transaction fee surge detection and warning

**Description:**

**Problem:**
`src/transaction/estimateFee.ts` returns estimated fees without context. Users can't distinguish normal fee from an anomalously high surge fee (due to network congestion). No warning or feedback mechanism exists.

**Solution:**
Track historical median fee from the last 10 transactions (if available from Horizon). Compare current estimated fee against the median. If current fee exceeds 2x median, include a `surge: true` flag in `FeeEstimate` response. Add optional callback hook for logging/alerting.

**Acceptance Criteria:**

- [ ] `FeeEstimate` type in `src/transaction/estimateFee.ts` includes optional `surge: boolean` field
- [ ] Surge detected if estimated fee > 2x recent median fee
- [ ] Median fee calculated from last 10 transactions fetched from Horizon
- [ ] Tests added covering normal fee, surge fee, and insufficient history scenarios
- [ ] Default behavior unchanged if history unavailable
- [ ] No new error codes

**Note for contributors:**
Reference recent transaction fees from Horizon API. Store median in optional client-level cache. Update `FeeEstimate` interface in `src/transaction/types.ts`. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #10

**Title** — Implement wallet connection state persistence and recovery

**Description:**

**Problem:**
`src/wallet/connect.ts` establishes a connection but doesn't persist it. On page reload or app restart, connection state is lost, forcing users to reconnect. No recovery mechanism exists.

**Solution:**
Implement optional connection state persistence using the pluggable cache interface. After successful connection, serialize wallet state (public key, wallet type) to cache. On client creation, attempt to recover and validate the cached connection state (by pinging the wallet). If valid, return connected state; if invalid, return disconnected.

**Acceptance Criteria:**

- [ ] `connectWallet()` in `src/wallet/connect.ts` persists state to cache after success
- [ ] Client creation checks cache for recovered state
- [ ] Recovered state validated by querying wallet adapter
- [ ] If validation fails, return disconnected state gracefully
- [ ] Tests added covering persistence, recovery, and validation failure
- [ ] Backward compatible; if no cache provided, behaves as before
- [ ] No changes to public API

**Note for contributors:**
Reference `src/shared/cache.ts` and `src/wallet/types.ts` for state shape. Validation ping should be lightweight (e.g., call `isAvailable()` on adapter). Update tests in `src/tests/wallet.test.ts`.

---

## Issue #11

**Title** — Add account balance change notifications via streaming event hooks

**Description:**

**Problem:**
`src/account/streamAccount.ts` emits full account state every poll interval, but consumers have no way to subscribe to specific balance changes. Large consumers (with many assets) receive full state updates even when only one balance changed, causing unnecessary processing.

**Solution:**
Implement optional event hooks in the streaming API. Add `onBalanceChange(asset, oldBalance, newBalance)` callback in `AccountStreamConfig`. Filter and emit only when a specific balance changes between polls.

**Acceptance Criteria:**

- [ ] `AccountStreamConfig` in `src/account/streamAccount.ts` accepts optional `onBalanceChange` callback
- [ ] Callback fires only when a balance changes between polls
- [ ] Callback receives asset code, old balance, new balance
- [ ] Full state still emitted via generator for consumers not using callback
- [ ] Tests added covering multiple balance changes, no changes, and edge cases
- [ ] Backward compatible; callbacks optional

**Note for contributors:**
Compare balances between polls using asset code + issuer as key. Callback should be optional parameter. Reference `AssetBalance` type in `src/account/types.ts`. Add tests to `src/tests/account.test.ts`.

---

## Issue #12

**Title** — Implement transaction result caching for recently submitted transactions

**Description:**

**Problem:**
`src/transaction/status.ts` queries Horizon for transaction status every time, even for transactions just submitted. No caching exists, causing redundant API calls for status checks within seconds of submission.

**Solution:**
Implement automatic caching in `src/transaction/status.ts` using the pluggable cache. After a transaction is submitted via `submitTransaction()`, cache the result with TX hash as key. Cache TTL: 10 minutes. Subsequent status checks hit cache first before querying Horizon.

**Acceptance Criteria:**

- [ ] Transaction result cached after `submitTransaction()` completes
- [ ] Cache key is transaction hash
- [ ] `getTransactionStatus()` checks cache before Horizon query
- [ ] Cache TTL 10 minutes, configurable
- [ ] Tests added covering cache hit, miss, and expiry
- [ ] Backward compatible; if no cache provided, behaves as before

**Note for contributors:**
Reference cache interface in `src/shared/cache.ts`. Coordinate with `submitTransaction()` in `src/transaction/submitTransaction.ts` to store result. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #13

**Title** — Add Soroban contract simulation result caching

**Description:**

**Problem:**
`src/soroban/simulateTransaction.ts` simulates the same contract call multiple times (e.g., fee estimation, read operations) without caching the result. Each call hits the RPC, increasing latency and risk of rate limiting.

**Solution:**
Implement simulation result caching based on contract ID, method, and arguments hash. If the same call is simulated multiple times within 5 minutes, return cached result instead of hitting RPC again.

**Acceptance Criteria:**

- [ ] `simulateTransaction()` in `src/soroban/simulateTransaction.ts` checks cache before RPC
- [ ] Cache key is SHA256 hash of (contractId + method + argsXdr)
- [ ] Cache hit returns `SimulateTransactionResult` without RPC call
- [ ] Cache miss simulates and stores result
- [ ] Cache TTL 5 minutes, configurable
- [ ] Tests added covering hits, misses, and expiry
- [ ] Backward compatible; if no cache, behaves as before

**Note for contributors:**
Reference `src/shared/cache.ts` for cache interface. Use consistent hashing for cache keys across related functions. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #14

**Title** — Implement adaptive polling interval for account and transaction streams

**Description:**

**Problem:**
`src/account/streamAccount.ts` and `src/transaction/streamTransactions.ts` poll at fixed intervals (configurable but constant). In high-frequency scenarios (trading, active account), fixed polling wastes bandwidth. In low-frequency scenarios, fixed polling misses activity.

**Solution:**
Implement adaptive polling that adjusts interval based on recent activity. If no change detected in last N polls, increase interval (up to max). If changes detected, decrease interval (down to min). Requires state tracking in the stream generator.

**Acceptance Criteria:**

- [ ] `streamAccount()` and `streamTransactions()` implement adaptive polling
- [ ] Interval increases when no activity detected (up to maxIntervalMs)
- [ ] Interval decreases when activity detected (down to minIntervalMs)
- [ ] `AccountStreamConfig` accepts optional `minIntervalMs`, `maxIntervalMs`, `adaptiveThreshold`
- [ ] Tests added covering activity, no activity, and interval boundaries
- [ ] Backward compatible; adaptive polling optional

**Note for contributors:**
Track consecutive polls without changes. Increment interval after N unchanged polls, decrement after change. Reference current streaming implementation in `streamAccount()` and `streamTransactions()`. Add tests to `src/tests/account.test.ts` and `src/tests/transaction.test.ts`.

---

## Issue #15

**Title** — Add comprehensive logging throughout SDK with configurable verbosity

**Description:**

**Problem:**
No logging exists in the SDK. Users can't trace what the SDK is doing (wallet connections, RPC calls, retries, polling). Debugging integration issues is difficult without console instrumentation.

**Solution:**
Implement structured logging using the existing `SorokitLogger` interface in `src/shared/logger.ts`. Add log calls at key points: wallet connection, API calls, retries, error handling. Allow configurable log level (debug, info, warn, error) at client creation. Structured logs include timestamps, operation type, and context.

**Acceptance Criteria:**

- [ ] Logging added to wallet connect/disconnect/sign operations
- [ ] Logging added to account fetch, streaming operations
- [ ] Logging added to transaction build, submit, status operations
- [ ] Logging added to Soroban prepare, execute, read operations
- [ ] Log level configurable at client creation
- [ ] Structured logs include operation name, status, optional error
- [ ] Default log level: off (no spam by default)
- [ ] Tests added for logger integration

**Note for contributors:**
Reference existing `SorokitLogger` interface and `createLogger()` in `src/shared/logger.ts`. Add log calls throughout modules without changing behavior. Logs should be informational, not performance-critical. Update `createSorokitClient()` to accept optional logger config.

---

## Issue #16

**Title** — Implement SafeError middleware for graceful error recovery and user feedback

**Description:**

**Problem:**
Callers must manually check `SorokitResult` status and handle each error type. No centralized mechanism exists for logging, tracking, or recovering from errors. Complex error flows require repetitive boilerplate.

**Solution:**
Implement an optional error middleware/handler in `src/shared/errors.ts` that can intercept all `SorokitResult` errors. Handler receives error code, message, and context. Allows custom logging, recovery logic, or error transformation. Can be registered at client creation.

**Acceptance Criteria:**

- [ ] Error handler interface defined in `src/shared/errors.ts`
- [ ] Handler receives `SorokitError` with code, message, context
- [ ] Handler can return recovery action (retry, fallback, rethrow)
- [ ] Handler registered at client creation in `createSorokitClient()`
- [ ] All public functions call handler before returning error
- [ ] Tests added covering handler invocation and recovery
- [ ] Backward compatible; handler optional

**Note for contributors:**
Design handler interface to be simple and non-invasive. Pass relevant context (function name, parameters) to handler. Reference pattern in existing logger. Update `SorokitClientConfig` in `src/client/createSorokitClient.ts`.

---

## Issue #17

**Title** — Add batch operation support for multiple account queries

**Description:**

**Problem:**
`src/account/getAccount.ts` only accepts a single public key. If a consumer needs to fetch multiple accounts, they must call `getAccount()` multiple times sequentially, hitting Horizon N times. No batching exists.

**Solution:**
Implement optional `getAccountsBatch(publicKeys: string[])` function that queries Horizon for multiple accounts in parallel. Returns array of results (mix of successes and failures). Handles partial failures gracefully.

**Acceptance Criteria:**

- [ ] `getAccountsBatch()` function added to `src/account/index.ts`
- [ ] Accepts array of public keys
- [ ] Queries Horizon in parallel (not sequential)
- [ ] Returns `SorokitResult<(SorokitResult<AccountInfo>)[]>` (array of individual results)
- [ ] Handles partial failures (some succeed, some fail)
- [ ] Tests added covering all successes, all failures, mixed results
- [ ] Performance: parallel queries faster than sequential

**Note for contributors:**
Use `Promise.all()` or `Promise.allSettled()` to parallelize. Each result in the array should be a `SorokitResult<AccountInfo>` to preserve individual error details. Add function to barrel export in `src/account/index.ts`. Add tests to `src/tests/account.test.ts`.

---

## Issue #18

**Title** — Implement transaction builder helper for common multi-operation transactions

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` provides single-operation builders (payment, trustline, create account). Complex transactions (e.g., payment + trustline setup) require manual `TransactionBuilder` usage or multiple transactions, cluttering user code.

**Solution:**
Implement helper functions for common multi-op transactions: `buildPaymentWithTrustline()` (establishes trust + sends payment), `buildSwapTransaction()` (two payments for swap). Builders compose existing operations, return XDR string.

**Acceptance Criteria:**

- [ ] `buildPaymentWithTrustline()` function added to `src/transaction/buildTransaction.ts`
- [ ] Takes payment + trustline params, returns XDR
- [ ] `buildSwapTransaction()` added for two-leg swaps
- [ ] Both return `SorokitResult<string>` (XDR)
- [ ] Both compose existing operations, no code duplication
- [ ] Tests added covering success and validation failures
- [ ] Functions exported in `src/transaction/index.ts`

**Note for contributors:**
Compose operations using Stellar SDK `TransactionBuilder`. Reuse validation logic from single-op builders. Add tests to `src/tests/transaction.test.ts`. Keep builders focused on common patterns, not arbitrary combinations.

---

## Issue #19

**Title** — Implement Soroban contract metadata caching and discovery

**Description:**

**Problem:**
`src/soroban/readContract.ts` and `src/soroban/prepareCall.ts` accept method names without contract context. No mechanism exists to discover available methods on a contract or cache its metadata. Users must know method signatures manually.

**Solution:**
Implement optional contract metadata discovery: `getContractMethods(contractId)` queries the RPC for spec and returns available methods with signatures. Cache metadata with TTL. Allow users to pass cached metadata to invoke/read operations for validation.

**Acceptance Criteria:**

- [ ] `getContractMethods(contractId)` function added to `src/soroban/index.ts`
- [ ] Returns array of method metadata (name, input types, return type)
- [ ] Results cached with 1-hour TTL by default
- [ ] `ContractInvokeParams` and `ContractReadParams` accept optional `cachedMetadata`
- [ ] Tests added covering discovery, caching, and cache misses
- [ ] Returns `SorokitResult<ContractMethod[]>` for consistency

**Note for contributors:**
Contract metadata discovery via Soroban RPC spec endpoint. Cache key is contract ID. Metadata type design: method name, inputs (array of {name, type}), return type. Reference `ContractInvokeParams` shape. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #20

**Title** — Add transaction history streaming with filtering and pagination

**Description:**

**Problem:**
`src/transaction/streamTransactions.ts` streams transactions as they occur, but no filtering or pagination exists. Large consumers with many transactions receive full history per poll, causing memory bloat. No way to query specific transaction ranges by date or status.

**Solution:**
Extend `TransactionStreamConfig` in `src/transaction/streamTransactions.ts` with optional filters: `minLedger`, `maxLedger`, `statuses` (success/failed/pending), `beforeDate`, `afterDate`. Support pagination via `limit` and `offset`. Filters applied before yielding results.

**Acceptance Criteria:**

- [ ] `TransactionStreamConfig` accepts optional filter fields
- [ ] `streamTransactions()` applies filters before yielding
- [ ] Ledger range filtering (minLedger, maxLedger)
- [ ] Status filtering (success, failed, pending)
- [ ] Date range filtering (beforeDate, afterDate)
- [ ] Pagination via limit (results per page) and offset (starting index)
- [ ] Tests added covering all filter combinations and edge cases
- [ ] Backward compatible; filters optional

**Note for Contributors:**
Filters applied client-side after Horizon fetch (Horizon pagination limited). Reference `TransactionStreamConfig` in `src/transaction/streamTransactions.ts`. Implement filter logic cleanly (separate `applyFilters()` helper). Add comprehensive tests to `src/tests/transaction.test.ts`.

---

## Issue #21

**Title** — Add TypeScript type guards for SorokitResult across modules

**Description:**

**Problem:**
Type narrowing for `SorokitResult` requires manual checks (`result.status === 'ok'`) throughout consumer code. Functions like `isOk()` and `isErr()` exist in `src/shared/response.ts` but aren't consistently exported in barrel files. No utility exists for pattern matching on error codes.

**Solution:**
Extend `src/shared/response.ts` with additional type guards: `isErrorCode(result, code)` for code-specific narrowing, and `assertOk(result)` for assertions. Export all guards consistently in `src/shared/index.ts` and `src/index.ts`. Add JSDoc examples.

**Acceptance Criteria:**

- [ ] `isErrorCode(result, code)` type guard added, narrows result.error.code to specific code
- [ ] `assertOk(result)` added, throws if result is error
- [ ] All guards exported in `src/shared/index.ts` and public API in `src/index.ts`
- [ ] Tests added covering all guards with valid and invalid inputs
- [ ] JSDoc examples added to each guard function
- [ ] No breaking changes to existing guards

**Note for contributors:**
Reference existing `isOk()` and `isErr()` patterns. Use discriminated unions for type narrowing. Add tests to `src/tests/result.test.ts`.

---

## Issue #22

**Title** — Add transaction signing options for multi-signature scenarios

**Description:**

**Problem:**
`src/wallet/signTransaction.ts` and `src/transaction/submitTransaction.ts` don't support multi-signature transactions. Users building multi-sig transactions must manually handle multiple wallet connections and signature collection. No utility exists to coordinate multi-sig signing.

**Solution:**
Extend `SignTransactionInput` in `src/wallet/types.ts` with optional `signers: string[]` field for multi-sig. Implement `collectMultiSignatures(xdr, signers, signFn)` utility in `src/wallet/index.ts` that collects signatures from multiple wallets sequentially, returning the fully-signed XDR.

**Acceptance Criteria:**

- [ ] `SignTransactionInput` accepts optional `signers` array
- [ ] `collectMultiSignatures()` function added to `src/wallet/index.ts`
- [ ] Collects signatures from multiple sources sequentially
- [ ] Returns fully-signed XDR ready for submission
- [ ] Tests added covering single-sig, multi-sig, partial failure scenarios
- [ ] Exported in `src/wallet/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `@stellar/stellar-sdk` for multi-sig transaction handling. Handle signature ordering. Test with mock wallet adapters. Add tests to `src/tests/wallet.test.ts`.

---

## Issue #23

**Title** — Add transaction builder validation for memo requirements

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` allows building transactions without memos, but certain operations (like payments to exchanges) should require memos for safety. No validation exists to warn or enforce memo presence.

**Solution:**
Add optional `requireMemo: boolean` parameter to transaction builders. If true, builder returns error if no memo provided. Add optional memo validation rules (e.g., memo type, length constraints) in builder params.

**Acceptance Criteria:**

- [ ] Transaction builders accept optional `requireMemo: boolean` parameter
- [ ] If `requireMemo: true` and no memo, return error with code `TX_BUILD_FAILED`
- [ ] Support memo types: text, id, hash, return
- [ ] Validate memo length constraints per type
- [ ] Tests added covering all memo types and validation scenarios
- [ ] No API breaking changes

**Note for contributors:**
Reference memo types in Stellar SDK. Add validation to `buildPaymentTransaction()`, `buildTrustlineTransaction()`, `buildCreateAccountTransaction()`. Update `src/tests/transaction.test.ts`.

---

## Issue #24

**Title** — Implement request deduplication for concurrent identical API calls

**Description:**

**Problem:**
If multiple parts of an application call `getAccount()` for the same public key simultaneously, Horizon is hit multiple times instead of sharing a single request. No deduplication mechanism exists, wasting bandwidth.

**Solution:**
Implement request deduplication using a Map of in-flight requests keyed by (function, params). Multiple callers for the same request return the same Promise. Add to `src/shared/utils.ts` as generic utility `deduplicateRequest()`.

**Acceptance Criteria:**

- [ ] `deduplicateRequest()` utility added to `src/shared/utils.ts`
- [ ] Uses Map to track in-flight requests by hash of (function, params)
- [ ] Concurrent identical requests share single Promise
- [ ] Requests complete and are removed from map after resolution
- [ ] Tests added covering concurrent calls, success, failure, timeout scenarios
- [ ] Export in `src/shared/index.ts`

**Note for contributors:**
Implement cache key as SHA256 hash of (funcName + paramsSerialized). Use Promise.all for multiple waiters. Add tests to `src/tests/shared.test.ts`.

---

## Issue #25

**Title** — Add asset issuer whitelisting for enhanced security

**Description:**

**Problem:**
`src/account/getAssetBalances.ts` and `src/transaction/buildTransaction.ts` accept any asset issuer without validation. Malicious or compromised issuers could deceive users. No security mechanism exists to filter trusted issuers.

**Solution:**
Add optional `trustedIssuers: string[]` parameter to client config. Functions that accept asset issuers check against the whitelist (if configured). Return error if issuer not whitelisted.

**Acceptance Criteria:**

- [ ] `SorokitClientConfig` in `src/client/createSorokitClient.ts` accepts optional `trustedIssuers` array
- [ ] `getAssetBalances()`, transaction builders check against whitelist if configured
- [ ] Untrusted issuer returns error with code `TX_BUILD_FAILED` or similar
- [ ] Tests added covering whitelist enforcement and bypass
- [ ] Backward compatible; whitelist optional

**Note for contributors:**
Store whitelist in client and pass to functions that need it. Add tests to `src/tests/account.test.ts` and `src/tests/transaction.test.ts`.

---

## Issue #26

**Title** — Implement automatic fee normalization and rounding

**Description:**

**Problem:**
Fee estimates from `src/transaction/estimateFee.ts` return precise values, but Stellar requires stroops (smallest unit). Rounding inconsistencies between client and server can cause submission failures. No normalization utility exists.

**Solution:**
Add `normalizeFee(fee: string | number)` utility in `src/shared/utils.ts` that ensures fees are integers in stroops, with proper rounding. Use throughout fee estimation and transaction building.

**Acceptance Criteria:**

- [ ] `normalizeFee()` added to `src/shared/utils.ts`
- [ ] Accepts string or number, returns integer stroops
- [ ] Implements proper rounding (banker's rounding or floor)
- [ ] `estimateFee()` uses normalization before returning
- [ ] Transaction builders use normalized fees
- [ ] Tests added covering decimal, string, edge cases
- [ ] Export in `src/shared/index.ts`

**Note for contributors:**
Reference Stellar's stroop definition (1 XLM = 10,000,000 stroops). Test rounding edge cases. Add tests to `src/tests/shared.test.ts`.

---

## Issue #27

**Title** — Add sequence number validation and auto-fetch for transactions

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` requires users to provide sequence numbers, but fetching them is tedious. If sequence is stale (account has been used since fetch), submission fails. No auto-fetch mechanism exists.

**Solution:**
Add optional `autoFetchSequence: boolean` parameter to transaction builders. If true, fetch current sequence from Horizon before building. Cache sequence temporarily to avoid re-fetching within same operation context.

**Acceptance Criteria:**

- [ ] Transaction builders accept optional `autoFetchSequence: boolean`
- [ ] If true, fetch current account sequence before building
- [ ] Cache fetched sequence for 5 seconds to avoid re-fetching
- [ ] Return error if account not found or sequence fetch fails
- [ ] Tests added covering auto-fetch success and failure
- [ ] Backward compatible; auto-fetch optional

**Note for contributors:**
Reference `getAccount()` in `src/account/getAccount.ts` for fetching. Use shared cache for sequence caching. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #28

**Title** — Implement custom error code mapping for consumer-specific error handling

**Description:**

**Problem:**
SDK error codes are fixed (`WALLET_SIGN_REJECTED`, `TX_SUBMIT_FAILED`, etc.). Consumers in different domains (trading, payments, governance) may want to map these to domain-specific codes. No customization mechanism exists.

**Solution:**
Implement error code transformer in `src/shared/errors.ts`. Accept optional mapping function at client creation. Before returning error, pass through transformer to allow custom code remapping.

**Acceptance Criteria:**

- [ ] Error transformer interface defined in `src/shared/errors.ts`
- [ ] Transformer accepts `SorokitErrorCode`, returns custom code string
- [ ] Registered at client creation in `SorokitClientConfig`
- [ ] Applied before returning any `SorokitResult` error
- [ ] Tests added covering transformer invocation and remapping
- [ ] Backward compatible; transformer optional

**Note for contributors:**
Design transformer as simple function: `(code: SorokitErrorCode) => string`. Pass through all errors before returning. Update `src/client/createSorokitClient.ts`. Add tests to `src/tests/shared.test.ts`.

---

## Issue #29

**Title** — Add transaction submission rate limiting to prevent floods

**Description:**

**Problem:**
`src/transaction/submitTransaction.ts` has no built-in rate limiting. Users can submit many transactions in rapid succession, hitting Horizon rate limits or overwhelming the network. No queue or throttle mechanism exists.

**Solution:**
Implement optional request rate limiter in `src/shared/utils.ts` using token bucket algorithm. Configure max requests per second. Apply to transaction submission via optional client config.

**Acceptance Criteria:**

- [ ] Rate limiter utility added to `src/shared/utils.ts` (token bucket algorithm)
- [ ] `SorokitClientConfig` accepts optional `maxTxPerSecond` parameter
- [ ] `submitTransaction()` respects rate limit, queues if necessary
- [ ] Queued submissions return pending result
- [ ] Tests added covering rate limiting, queuing, and compliance
- [ ] Export in `src/shared/index.ts`

**Note for contributors:**
Token bucket: allow N tokens per second, refill over time. Queue submissions if tokens exhausted. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #30

**Title** — Add Soroban contract event subscription and filtering

**Description:**

**Problem:**
`src/soroban/invokeContract.ts` executes contracts but returns only the result, not emitted events. No mechanism exists to subscribe to or filter contract events. Users miss contract-level state changes.

**Solution:**
Implement `subscribeContractEvents(contractId, eventFilter?, callback)` in `src/soroban/index.ts`. Poll Horizon for ledger entries and extract events matching filter. Invoke callback with events.

**Acceptance Criteria:**

- [ ] `subscribeContractEvents()` function added to `src/soroban/index.ts`
- [ ] Accepts contract ID, optional event filter, callback
- [ ] Polls Horizon for ledger state changes
- [ ] Filters events by name, topic patterns
- [ ] Invokes callback with matched events
- [ ] Tests added covering event matching and filtering
- [ ] Return unsubscribe function

**Note for contributors:**
Reference contract event structure from Soroban SDK. Implement polling with configurable interval. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #31

**Title** — Add comprehensive unit test coverage for error scenarios

**Description:**

**Problem:**
Test coverage exists for happy paths but error scenarios are underrepresented. Functions like `getAccount()`, `submitTransaction()` have limited tests for network failures, malformed inputs, timeout scenarios. Current coverage: ~60%.

**Solution:**
Expand `src/tests/` with comprehensive error scenario tests:

- Network timeouts and failures
- Malformed responses from API
- Invalid inputs (wrong types, boundary values)
- Concurrent request failures
- Rate limiting scenarios

Target 85%+ coverage.

**Acceptance Criteria:**

- [ ] Add 20+ new error scenario tests across account, transaction, soroban, wallet modules
- [ ] Tests cover network failures, timeouts, malformed responses
- [ ] Tests cover invalid input validation
- [ ] Tests cover concurrent operation failures
- [ ] Overall coverage increases to 85%+
- [ ] All tests pass on Node 18 and 20

**Note for contributors:**
Use mock Horizon/RPC servers or vitest mocking. Reference existing test patterns in `src/tests/`. Prioritize high-impact error paths first.

---

## Issue #32

**Title** — Implement structured error logs with trace IDs for debugging

**Description:**

**Problem:**
Errors occur but there's no tracing mechanism to correlate related operations. User reports "transaction failed" but SDK logs don't show which specific operation chain led to the failure. No correlation IDs exist.

**Solution:**
Implement trace ID tracking: generate UUID at client creation or per-operation. Pass trace ID through all nested calls. Include in all logs and errors via `context.traceId`.

**Acceptance Criteria:**

- [ ] Trace ID generated at client creation or per-operation
- [ ] Passed through all internal function calls
- [ ] Included in all log messages and error contexts
- [ ] Exposed in `SorokitError` type as optional `traceId` field
- [ ] Tests added covering trace ID flow
- [ ] No performance impact

**Note for contributors:**
Use nanoid or uuid for trace ID generation. Thread trace ID through function signatures (add optional param). Update `SorokitError` interface in `src/shared/response.ts`. Add tests to `src/tests/shared.test.ts`.

---

## Issue #33

**Title** — Add transaction builder for Soroban contract deployment

**Description:**

**Problem:**
`src/soroban/index.ts` focuses on invoking contracts but no builder exists for deploying contracts. Users must manually construct deployment transactions using Stellar SDK, bypassing sorokit abstraction.

**Solution:**
Implement `buildContractDeploy(contractCode, deployer, options)` in `src/soroban/index.ts`. Returns XDR ready for signing and submission. Handles fee estimation, sequence number, network setup.

**Acceptance Criteria:**

- [ ] `buildContractDeploy()` function added to `src/soroban/index.ts`
- [ ] Accepts contract code (WASM buffer), deployer public key, options
- [ ] Returns `SorokitResult<string>` (XDR)
- [ ] Validates code size, format
- [ ] Includes fee estimation
- [ ] Tests added covering valid deploys and validation failures
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference Soroban contract deployment flow in Stellar SDK. Validate WASM size limits. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #34

**Title** — Add wallet connectivity health checks and diagnostics

**Description:**

**Problem:**
`src/wallet/connect.ts` connects to wallets but provides no way to diagnose connection issues. Users don't know if connection failed due to wallet not installed, network down, or user rejection. No diagnostic API exists.

**Solution:**
Implement `diagnoseWalletConnection(adapter)` utility in `src/wallet/index.ts`. Checks: wallet installed, network accessible, extension responsive. Returns diagnostic report with findings and recommendations.

**Acceptance Criteria:**

- [ ] `diagnoseWalletConnection()` function added to `src/wallet/index.ts`
- [ ] Checks wallet availability, network connectivity, extension responsiveness
- [ ] Returns structured diagnostic report with status, findings, recommendations
- [ ] Tests added covering all diagnostic scenarios
- [ ] Exported in `src/wallet/index.ts` and `src/index.ts`

**Note for contributors:**
Run series of lightweight checks (isAvailable(), ping network, test connection). Structure report clearly. Add tests to `src/tests/wallet.test.ts`.

---

## Issue #35

**Title** — Add account balance change alerts with threshold detection

**Description:**

**Problem:**
`src/account/streamAccount.ts` streams balance changes but consumers must manually compare thresholds. No built-in alert system exists for significant balance changes (e.g., drop below threshold, large incoming transfer).

**Solution:**
Extend `AccountStreamConfig` with optional `alertRules: BalanceAlertRule[]`. Each rule specifies asset, threshold, condition (above, below, change %). Emit alerts when thresholds crossed.

**Acceptance Criteria:**

- [ ] `BalanceAlertRule` type added to `src/account/types.ts`
- [ ] `AccountStreamConfig` accepts optional `alertRules` and `onAlert` callback
- [ ] Rules support: below threshold, above threshold, % change
- [ ] Alert fired with asset, old balance, new balance, rule
- [ ] Tests added covering alert conditions
- [ ] Backward compatible; alerts optional

**Note for contributors:**
Define `BalanceAlertRule` interface clearly. Implement condition checks cleanly. Reference balance streaming in `streamAccount()`. Add tests to `src/tests/account.test.ts`.

---

## Issue #36

**Title** — Add transaction builder optimizations for common patterns

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` builds transactions inefficiently for common patterns. Fee calculation, sequence fetching, network config resolution happen repeatedly. No optimization layer exists.

**Solution:**
Implement transaction builder context/cache: `createTransactionContext(publicKey)` returns builder with pre-fetched sequence, fee estimate, network config. Builder reuses context for multiple operations in same "session".

**Acceptance Criteria:**

- [ ] `createTransactionContext()` function added to `src/transaction/index.ts`
- [ ] Accepts public key, returns builder context with cached data
- [ ] Context caches: sequence number, base fee, network config
- [ ] Multiple operations in same context share cached data
- [ ] Context expires after 5 minutes
- [ ] Tests added covering cache hits and expiry
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Store cache in closure. Implement smart invalidation (e.g., sequence increments). Add tests to `src/tests/transaction.test.ts`.

---

## Issue #37

**Title** — Add comprehensive API documentation strings with examples

**Description:**

**Problem:**
Public functions lack JSDoc comments with parameter descriptions, return types, and usage examples. IDE autocomplete is limited. Users must read implementation to understand behavior.

**Solution:**
Add comprehensive JSDoc to all public functions in `src/*/index.ts` files and core exports. Include: description, parameters with types, returns, throws (if applicable), example usage.

**Acceptance Criteria:**

- [ ] All functions in `src/account/index.ts` documented with JSDoc
- [ ] All functions in `src/transaction/index.ts` documented
- [ ] All functions in `src/soroban/index.ts` documented
- [ ] All functions in `src/wallet/index.ts` documented
- [ ] All functions in `src/client/createSorokitClient.ts` documented
- [ ] JSDoc includes examples for key functions
- [ ] IDE autocomplete now shows parameter hints

**Note for contributors:**
Follow JSDoc conventions. Include @param, @returns, @example, @throws. Keep examples concise and runnable. Reference existing JSDoc in codebase for consistency.

---

## Issue #38

**Title** — Add transaction signing history and audit trail

**Description:**

**Problem:**
No record exists of which transactions were signed and when. Users can't audit wallet signing activity. Security-sensitive applications need signing history for compliance.

**Solution:**
Implement optional signing history tracking. Store (transaction hash, signer, timestamp, status) in pluggable store. Provide `getSigningHistory()` query function.

**Acceptance Criteria:**

- [ ] Optional signing history recording in `src/wallet/signTransaction.ts`
- [ ] Records: tx hash, signer address, timestamp, success/failure, error if failed
- [ ] Uses pluggable storage interface
- [ ] `getSigningHistory(filter?)` function added to `src/wallet/index.ts`
- [ ] History exported in CSV/JSON formats
- [ ] Tests added covering history recording and queries
- [ ] Backward compatible; history tracking optional

**Note for contributors:**
Define history storage interface. Default no-op implementation. Add tests to `src/tests/wallet.test.ts`.

---

## Issue #39

**Title** — Implement contract state snapshotting for debugging

**Description:**

**Problem:**
`src/soroban/readContract.ts` reads contract state but no way to capture historical snapshots. Debugging state changes over time is difficult. No snapshot mechanism exists.

**Solution:**
Implement `snapshotContractState(contractId, label?)` function. Stores contract state with label and timestamp. Implement `compareSnapshots(label1, label2)` to show diffs.

**Acceptance Criteria:**

- [ ] `snapshotContractState()` function added to `src/soroban/index.ts`
- [ ] Stores contract state with label and timestamp
- [ ] Multiple snapshots can be stored
- [ ] `compareSnapshots()` shows state diffs
- [ ] Snapshots stored in memory (or optional persistent store)
- [ ] Tests added covering snapshots and diffs
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference contract state structure. Implement simple JSON diff. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #40

**Title** — Add network latency metrics collection and reporting

**Description:**

**Problem:**
No visibility into SDK performance metrics. Users don't know if slowness is due to network, SDK logic, or wallet delays. No performance monitoring exists.

**Solution:**
Implement optional metrics collection: track API call latencies, wallet operations, parsing time. Expose `getMetrics()` function. Export to monitoring systems (console, external service).

**Acceptance Criteria:**

- [ ] Metrics collection added to key functions: `getAccount()`, `submitTransaction()`, wallet operations
- [ ] Tracks: operation name, duration (ms), success/failure
- [ ] `getMetrics(filter?)` returns collected metrics
- [ ] Metrics include: min, max, avg, p99 latency
- [ ] Tests added covering metrics collection
- [ ] Backward compatible; metrics optional

**Note for contributors:**
Use simple in-memory store for metrics. Add high-resolution timer using `performance.now()`. Export in `src/shared/index.ts`. Add tests to `src/tests/shared.test.ts`.

---

## Issue #41

**Title** — Add support for custom transaction memo types and validation

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` supports memo types (text, id, hash, return) but no custom validation rules. Users can't enforce organization-specific memo formats (e.g., "must start with PREFIX").

**Solution:**
Extend memo handling to accept optional `memoValidator: (memo) => SorokitResult<void>` callback. Apply validation before building transaction. Allow custom formats while maintaining type safety.

**Acceptance Criteria:**

- [ ] Transaction builders accept optional `memoValidator` callback
- [ ] Validator receives memo, returns `SorokitResult<void>`
- [ ] Applied before transaction build
- [ ] Validation errors bubble up as `TX_BUILD_FAILED`
- [ ] Tests added covering custom validation scenarios
- [ ] Backward compatible; validator optional

**Note for contributors:**
Reference existing memo validation. Keep validator simple and composable. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #42

**Title** — Implement operation batching for bulk account queries

**Description:**

**Problem:**
`src/account/getAssetBalances.ts` filters balances but each filter requires full account fetch. Bulk querying (many filters) hits API N times. No batching mechanism exists.

**Solution:**
Implement `getMultipleAssetBalances(publicKeys, assetFilters)` that fetches accounts and applies filters in bulk. Returns map of results indexed by key and filter.

**Acceptance Criteria:**

- [ ] `getMultipleAssetBalances()` function added to `src/account/index.ts`
- [ ] Accepts multiple public keys and asset filters
- [ ] Fetches accounts in parallel
- [ ] Applies filters to all accounts
- [ ] Returns indexed results
- [ ] Tests added covering success, partial failure
- [ ] Performance: parallel fetch faster than sequential

**Note for contributors:**
Use `Promise.allSettled()` for parallel fetches. Implement filter application cleanly. Add tests to `src/tests/account.test.ts`.

---

## Issue #43

**Title** — Add transaction fee tier recommendations based on network congestion

**Description:**

**Problem:**
`src/transaction/estimateFee.ts` returns a single fee estimate. No guidance on fee tiers or urgency. Users don't know if they should pay more to prioritize or can use base fee.

**Solution:**
Extend `FeeEstimate` to include `tiers: { fast: string, standard: string, economy: string }`. Calculate tiers based on network congestion metrics fetched from Horizon.

**Acceptance Criteria:**

- [ ] `FeeEstimate` type includes optional `tiers` field with fast/standard/economy fees
- [ ] Tiers calculated from recent transaction fee distribution
- [ ] Fast: 90th percentile, Standard: 50th percentile, Economy: 10th percentile
- [ ] Tests added covering tier calculation
- [ ] Backward compatible; tiers optional

**Note for contributors:**
Fetch recent transaction fees from Horizon. Calculate percentiles. Update `src/transaction/types.ts`. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #44

**Title** — Add wallet provider detection and recommendation system

**Description:**

**Problem:**
`src/wallet/adapters/` supports specific wallets but no discovery of available wallets. Users don't know which wallets are installed. No recommendation system exists.

**Solution:**
Implement `detectInstalledWallets()` that checks which wallet extensions are available in browser. Implement `recommendWallets(criteria)` to suggest wallets based on features (multisig, hardware support, etc.).

**Acceptance Criteria:**

- [ ] `detectInstalledWallets()` function added to `src/wallet/index.ts`
- [ ] Returns list of available wallets with metadata
- [ ] `recommendWallets(criteria?)` suggests wallets based on features
- [ ] Works in browser environment only
- [ ] Tests added covering detection and recommendations
- [ ] Exported in `src/wallet/index.ts` and `src/index.ts`

**Note for contributors:**
Check for wallet extensions in browser global scope. Define recommendation criteria interface. Add tests to `src/tests/wallet.test.ts`.

---

## Issue #45

**Title** — Add transaction rollback and undo support

**Description:**

**Problem:**
Once a transaction is submitted, users can't easily reverse it. No mechanism exists to reverse payments, trustlines, or operations. Users must build reverse transactions manually.

**Solution:**
Implement `buildReverseTransaction(originalTx, reverseParams?)` in `src/transaction/index.ts`. Generates appropriate reverse operation (e.g., reverse payment, remove trustline). Returns XDR ready to sign and submit.

**Acceptance Criteria:**

- [ ] `buildReverseTransaction()` function added to `src/transaction/index.ts`
- [ ] Supports reversing: payments, trustlines, account creation
- [ ] Returns appropriate reverse operation
- [ ] Includes sequence number, fee, network config
- [ ] Tests added covering all reverse operation types
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Map each operation type to its reverse (e.g., trustline setup to trustline removal with 0 limit). Use existing builders. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #51

**Title** — Fix missing stream method on account module public API

**Description:**

**Problem:**
`src/account/streamAccount.ts` implements account streaming with adaptive polling and balance alerts, but the `stream()` method is not exported in `src/account/index.ts`. Users cannot access this feature from the public API, only through internal imports.

**Solution:**
Export `streamAccount()` from `src/account/index.ts` barrel file. Update `src/index.ts` to include in public API. Add to client's account module in `createSorokitClient()`.

**Acceptance Criteria:**

- [ ] `streamAccount` exported from `src/account/index.ts`
- [ ] Available on client via `client.account.stream()`
- [ ] TypeScript types properly exported
- [ ] Tests verify streaming works end-to-end
- [ ] Documented in README with example

**Note for contributors:**
Reference existing exports in `src/account/index.ts`. Update both barrel exports and client assembly in `createSorokitClient()`. Add integration test to `src/tests/integration/`.

---

## Issue #52

**Title** — Add missing transaction streaming method to public API

**Description:**

**Problem:**
`src/transaction/streamTransactions.ts` exists and implements transaction streaming, but is not exported from `src/transaction/index.ts` or available on the client. Users cannot stream transactions via public API.

**Solution:**
Export `streamTransactions()` from `src/transaction/index.ts`. Wire into `SorokitClient` as `client.transaction.stream()`. Export types `TransactionStreamConfig` and `TransactionPage`.

**Acceptance Criteria:**

- [ ] `streamTransactions` exported from `src/transaction/index.ts`
- [ ] Available on client via `client.transaction.stream()`
- [ ] Types `TransactionStreamConfig`, `TransactionPage` exported in public API
- [ ] Integration tests added for streaming transactions
- [ ] README documents transaction streaming

**Note for contributors:**
Follow pattern from account streaming export. Check `createSorokitClient()` for wiring. Add tests to `src/tests/integration/`.

---

## Issue #53

**Title** — Add fee estimation with tier recommendations feature

**Description:**

**Problem:**
`src/transaction/estimateFee.ts` returns single fee estimate without context. No guidance on fee tiers (fast/standard/economy). Users don't know if fee is high/low relative to network.

**Solution:**
Extend `FeeEstimate` type to include `tiers` object with `fast`, `standard`, `economy` fees calculated from recent network activity. Fetch last 50 transactions, compute percentiles (90th, 50th, 10th). Implement `calculateFeeTiers()` utility.

**Acceptance Criteria:**

- [ ] `FeeEstimate` type extended with optional `tiers: { fast, standard, economy }`
- [ ] `calculateFeeTiers()` calculates percentiles from recent transactions
- [ ] Fast tier = 90th percentile, Standard = 50th, Economy = 10th
- [ ] Fetches recent tx fees from Horizon only on cache miss
- [ ] Tests cover tier calculation with various fee distributions
- [ ] Backward compatible; tiers optional

**Note for contributors:**
Reference `src/transaction/estimateFee.ts`. Fetch recent transactions via Horizon. Cache fee percentiles. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #54

**Title** — Implement contract state caching for read operations

**Description:**

**Problem:**
`src/soroban/readContract.ts` reads contract state but no caching exists. Repeated reads of the same contract state hit RPC every time, increasing latency and rate limit risk. No deduplication for identical concurrent reads.

**Solution:**
Add optional caching to `readContract()`. Hash (contractId + method + args). Cache results with 5-minute TTL using pluggable `SorokitCache`. Deduplicate concurrent identical reads using shared Promise.

**Acceptance Criteria:**

- [ ] Cache key = SHA256(contractId + method + argsXdr)
- [ ] Cache TTL = 5 minutes (configurable)
- [ ] Concurrent identical reads share single RPC call
- [ ] Tests cover cache hit, miss, expiry, deduplication
- [ ] Backward compatible; caching optional if cache provided to client
- [ ] No performance regression

**Note for contributors:**
Reference `src/soroban/readContract.ts`. Use `deduplicateRequest()` utility from `src/shared/utils.ts`. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #55

**Title** — Add contract metadata caching and discovery utility

**Description:**

**Problem:**
No way to discover contract methods before invocation. Users must know method signatures manually. Repeated calls to `getContractMethods()` hit RPC every time without caching.

**Solution:**
Implement `getContractMethods(contractId, cache?)` in `src/soroban/index.ts`. Queries RPC for contract metadata once, caches with 1-hour TTL. Returns array of `ContractMethod` objects with names, input types, return types.

**Acceptance Criteria:**

- [ ] `getContractMethods()` function added to `src/soroban/index.ts`
- [ ] Returns `SorokitResult<ContractMethod[]>` with name, inputs, returnType
- [ ] Results cached for 1 hour by default
- [ ] Cache key = contractId
- [ ] Tests cover discovery, caching, cache miss scenarios
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Define `ContractMethod` type in `src/soroban/types.ts`. Query RPC spec endpoint. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #56

**Title** — Fix missing error detection for XDR validation

**Description:**

**Problem:**
`src/shared/errors.ts` has `isXdrInvalidError()` utility exported in some places but not consistently. Functions like `submitTransaction()` call it but there's no centralized validation before XDR processing. Malformed XDR reaches Stellar SDK, causing cryptic errors.

**Solution:**
Ensure `isXdrInvalidError()` is consistently exported and used. Add validation in `buildTransaction()`, `submitTransaction()`, `prepareContractCall()` before passing XDR to Stellar SDK. Early validation returns clear error.

**Acceptance Criteria:**

- [ ] `isXdrInvalidError()` exported in `src/shared/index.ts`
- [ ] Checks for common XDR malformations (invalid base64, truncated, etc.)
- [ ] Used in `buildTransaction()` before TransactionBuilder
- [ ] Used in `submitTransaction()` before envelope parsing
- [ ] Used in `prepareContractCall()` before assembly
- [ ] Tests cover valid XDR, truncated, invalid base64, etc.

**Note for contributors:**
Reference existing XDR validation patterns. Add checks early in each pipeline. Add tests to `src/tests/shared.test.ts`.

---

## Issue #57

**Title** — Add support for memo validation and custom memo rules

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` accepts memos but no custom validation exists. Organizations can't enforce memo formats (e.g., "must start with PREFIX\_"). No pluggable memo validator.

**Solution:**
Extend `PaymentParams`, `TrustlineParams`, `AccountCreateParams` with optional `memoValidator: (memo: Memo) => SorokitResult<void>` callback. Apply before building transaction. Allow custom format enforcement.

**Acceptance Criteria:**

- [ ] Transaction param types accept optional `memoValidator` callback
- [ ] Validator receives memo object, returns `SorokitResult<void>`
- [ ] Applied before transaction build
- [ ] Validation failure returns `TX_BUILD_FAILED` with clear message
- [ ] Tests cover valid memo, invalid format, custom validators
- [ ] Backward compatible; validator optional

**Note for contributors:**
Reference Stellar memo types (text, id, hash, return). Keep validator simple. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #58

**Title** — Add batch account queries optimization

**Description:**

**Problem:**
`src/account/getAccount.ts` fetches one account at a time. If code fetches 10 accounts, Horizon is hit 10 times sequentially. No batch API exists for fetching multiple accounts in parallel.

**Solution:**
Implement `getAccountsBatch(publicKeys: string[], horizonUrl: string)` in `src/account/index.ts`. Fetches in parallel using `Promise.allSettled()`. Returns array of individual `SorokitResult<AccountInfo>` to preserve per-account errors.

**Acceptance Criteria:**

- [ ] `getAccountsBatch()` function added to `src/account/index.ts`
- [ ] Accepts array of public keys
- [ ] Fetches in parallel (not sequential)
- [ ] Returns `SorokitResult<(SorokitResult<AccountInfo>)[]>`
- [ ] Each result preserves individual success/failure
- [ ] Tests cover all success, all failure, mixed results
- [ ] Performance improved vs. sequential fetches

**Note for contributors:**
Use `Promise.allSettled()` for robust error handling. Reference `getAccount()` pattern. Add tests to `src/tests/account.test.ts`.

---

## Issue #59

**Title** — Add missing contract invocation result type mapping

**Description:**

**Problem:**
`src/soroban/invokeContract.ts` returns transaction hash on successful contract execution, but no utility exists to parse contract return values. `ContractCallResult` has `value` field but it's typed as `unknown`, not decoded.

**Solution:**
Implement `decodeContractValue(scVal: xdr.ScVal)` utility in `src/soroban/index.ts`. Maps ScVal types to native JS values (u32 → number, map → object, etc.). Use in `readContract()` to populate `value` field properly.

**Acceptance Criteria:**

- [ ] `decodeContractValue()` function added to `src/soroban/index.ts`
- [ ] Handles: u32, i32, u64, i64, u128, i128, string, bool, map, vec
- [ ] Returns typed JS value (number, string, boolean, object, array)
- [ ] Tests cover all supported types
- [ ] Used in `readContract()` to decode results
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference Stellar SDK's `scValToNative()`. Reference `src/soroban/types.ts` for result types. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #60

**Title** — Add contract method argument encoding helper

**Description:**

**Problem:**
`src/soroban/prepareCall.ts` accepts `args: xdr.ScVal[]` but users must manually encode JS values to ScVal. No utility exists for this. Users unfamiliar with XDR face barriers to contract invocation.

**Solution:**
Implement `encodeContractArgs(method: ContractMethod, jsValues: unknown[])` in `src/soroban/index.ts`. Maps JS values to ScVal based on method signature. Validates types match method spec.

**Acceptance Criteria:**

- [ ] `encodeContractArgs()` function added to `src/soroban/index.ts`
- [ ] Accepts method metadata and array of JS values
- [ ] Encodes to ScVal array based on type spec
- [ ] Type validation: throws if value doesn't match spec
- [ ] Tests cover all supported types (u32, string, bool, map, vec, etc.)
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference Stellar SDK's `nativeToScVal()`. Use `ContractMethod` type for signatures. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #61

**Title** — Fix wallet adapter ordering and priority in detection

**Description:**

**Problem:**
`src/wallet/index.ts` has `detectInstalledWallets()` that checks adapters, but order is arbitrary. If multiple wallets installed, no way to specify preference. Users may connect to wrong wallet by default.

**Solution:**
Implement `prioritizeWallet(adapters: WalletAdapter[], preferred?: WalletType)` function. Reorders adapters by availability and preference. Use in `connectWallet()` if no adapter specified.

**Acceptance Criteria:**

- [ ] `prioritizeWallet()` function added to `src/wallet/index.ts`
- [ ] Accepts adapters array and optional preferred wallet type
- [ ] Returns adapters sorted by: preferred first, then installed, then unavailable
- [ ] Tests cover single wallet, multiple installed, no wallets
- [ ] Exported in `src/wallet/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `detectInstalledWallets()` and `recommendWallets()` for patterns. Add tests to `src/tests/wallet.test.ts`.

---

## Issue #62

**Title** — Add transaction fee history tracking and analytics

**Description:**

**Problem:**
No way to analyze fee trends over time. Users can't tell if current fee is high/low historically. No fee analytics API exists.

**Solution:**
Implement `analyzeFeeHistory(recentTransactions: TransactionResult[], windowSize: number)` in `src/transaction/index.ts`. Computes: min, max, average, median, stddev fees over window. Returns analytics object.

**Acceptance Criteria:**

- [ ] `analyzeFeeHistory()` function added to `src/transaction/index.ts`
- [ ] Accepts array of recent transactions, window size
- [ ] Computes: min, max, avg, median, stddev, percentiles
- [ ] Returns typed analytics object with all metrics
- [ ] Tests cover various fee distributions
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `TransactionResult` type. Implement statistical calculations cleanly. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #63

**Title** — Add safe contract simulation with fallback

**Description:**

**Problem:**
`src/soroban/simulateTransaction.ts` simulates directly without fallback. If RPC fails or contract has side effects, simulation fails. No graceful degradation.

**Solution:**
Implement `simulateContractSafe(xdr, options?: { allowFail?: boolean, fallbackFee?: string })` wrapper. If simulation fails and `allowFail: true`, returns estimated fee without error. Uses `fallbackFee` or calculates estimate.

**Acceptance Criteria:**

- [ ] `simulateContractSafe()` function added to `src/soroban/index.ts`
- [ ] Attempts simulation, returns result on success
- [ ] If fails and `allowFail: true`, returns fallback result
- [ ] Fallback fee calculation or user-provided
- [ ] Tests cover success, failure with fallback, no fallback
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `simulateTransaction()` pattern. Handle both error cases. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #64

**Title** — Add network connectivity health check utility

**Description:**

**Problem:**
No way to diagnose if network/RPC is accessible. Users get generic "network error" without knowing if it's local network, RPC down, or timeout. No diagnostic API.

**Solution:**
Implement `checkNetworkHealth(horizonUrl: string, rpcUrl: string)` in `src/network/index.ts`. Tests: Horizon ping, RPC ping, response time. Returns health report with status, latency, recommendations.

**Acceptance Criteria:**

- [ ] `checkNetworkHealth()` function added to `src/network/index.ts`
- [ ] Pings Horizon (ledger endpoint), RPC (getHealth or similar)
- [ ] Measures response latency
- [ ] Returns health report: status (healthy/degraded/down), latencies, issues
- [ ] Tests cover online, offline, timeout scenarios
- [ ] Exported in `src/network/index.ts` and `src/index.ts`

**Note for contributors:**
Reference network config patterns. Implement lightweight pings. Add tests to `src/tests/network.test.ts`.

---

## Issue #65

**Title** — Add transaction builder validation matrix

**Description:**

**Problem:**
No comprehensive pre-submission validation exists. Users catch errors during submission instead of before. Missing receiver validation, amount constraints, fee sanity checks done in separate places.

**Solution:**
Implement `validateTransactionXdr(xdr: string, rules?: ValidationRules)` in `src/transaction/index.ts`. Checks: valid XDR, all operations valid, amounts positive, receiver exists/valid, fee reasonable. Returns validation report.

**Acceptance Criteria:**

- [ ] `validateTransactionXdr()` function added to `src/transaction/index.ts`
- [ ] Validates: XDR format, operation types, amounts, receivers, fees
- [ ] Accepts optional custom rules for extensibility
- [ ] Returns detailed report with findings, warnings, errors
- [ ] Tests cover all validation scenarios
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Extract and validate operations from XDR. Reference Stellar constraints. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #66

**Title** — Fix logging not being wired to client config

**Description:**

**Problem:**
`src/shared/logger.ts` defines `SorokitLogger` interface but not wired into `SorokitClientConfig`. No way to pass custom logger to client. Logging disabled by default, not configurable.

**Solution:**
Add `logger?: SorokitLogger` field to `SorokitClientConfig` in `src/client/createSorokitClient.ts`. Pass logger to all modules. Add `logLevel?: LogLevel` to configure verbosity (debug, info, warn, error).

**Acceptance Criteria:**

- [ ] `SorokitClientConfig` accepts optional `logger` field
- [ ] `SorokitClientConfig` accepts optional `logLevel` field
- [ ] Logger passed to all modules that call logger methods
- [ ] Default logger is no-op if not provided
- [ ] Tests verify logger receives expected calls
- [ ] Backward compatible; logging optional

**Note for contributors:**
Reference `SorokitLogger` interface in `src/shared/logger.ts`. Update `createSorokitClient()` to pass logger. Add tests to `src/tests/client.test.ts`.

---

## Issue #67

**Title** — Add cache TTL validation and expiry enforcement

**Description:**

**Problem:**
`src/shared/cache.ts` defines `SorokitCache` interface with `set(key, value, ttlMs?)` but no validation of TTL or automatic expiry. Cache implementations can have bugs. No TTL enforcement.

**Solution:**
Implement default cache wrapper `createMemoryCache()` in `src/shared/cache.ts` with proper TTL tracking and expiry. Wrap user-provided caches to ensure TTL compliance. Add validation.

**Acceptance Criteria:**

- [ ] `createMemoryCache()` factory added to `src/shared/cache.ts`
- [ ] Implements `SorokitCache` with TTL tracking
- [ ] Expires entries after TTL
- [ ] Validates TTL values (positive integers)
- [ ] Tests cover expiry, refresh, invalidate
- [ ] Exported in `src/shared/index.ts`

**Note for contributors:**
Use `Map` for storage, track timestamps. Implement lazy expiry on get. Add tests to `src/tests/shared.test.ts`.

---

## Issue #68

**Title** — Add typed error recovery handler middleware

**Description:**

**Problem:**
No centralized error handling mechanism. Callers must manually check and handle each error code. No way to implement cross-cutting error recovery (logging, retries, fallbacks).

**Solution:**
Implement `ErrorHandler` interface in `src/shared/errors.ts`. Accept optional handler in `SorokitClientConfig`. Handler receives error, can return recovery action (retry, fallback, rethrow). Called before returning error result.

**Acceptance Criteria:**

- [ ] `ErrorHandler` interface defined with (code, message, context) → RecoveryAction
- [ ] `SorokitClientConfig` accepts optional `errorHandler` field
- [ ] All public functions call handler before returning errors
- [ ] Tests cover handler invocation and recovery
- [ ] Backward compatible; handler optional
- [ ] No performance impact

**Note for contributors:**
Keep handler interface simple and non-invasive. Reference middleware patterns. Add tests to `src/tests/shared.test.ts`.

---

## Issue #69

**Title** — Add request deduplication for concurrent operations

**Description:**

**Problem:**
If multiple parts of app call `getAccount()` for same key simultaneously, Horizon hit multiple times. No deduplication exists. Wastes bandwidth, increases latency.

**Solution:**
Implement `deduplicateRequest(key: string, fn: () => Promise<T>)` in `src/shared/utils.ts`. Uses Map to track in-flight requests. Multiple callers for same key share single Promise.

**Acceptance Criteria:**

- [ ] `deduplicateRequest()` utility added to `src/shared/utils.ts`
- [ ] Tracks in-flight requests by key
- [ ] Concurrent identical requests share single Promise
- [ ] Requests removed from map after completion
- [ ] Tests cover concurrent calls, success, failure
- [ ] Exported in `src/shared/index.ts`

**Note for contributors:**
Implement with Map. Use WeakMap for automatic cleanup. Add tests to `src/tests/shared.test.ts`.

---

## Issue #70

**Title** — Add Soroban contract batch invocation support

**Description:**

**Problem:**
`src/soroban/invokeContract.ts` invokes one contract at a time. If invoking 5 contracts, must call 5 times. No batch API for parallel execution.

**Solution:**
Implement `invokeBatchContracts(invocations: ContractInvokeParams[], options?: { parallel?: boolean })` in `src/soroban/index.ts`. Executes in parallel. Returns array of results.

**Acceptance Criteria:**

- [ ] `invokeBatchContracts()` function added to `src/soroban/index.ts`
- [ ] Accepts array of invocation params
- [ ] Executes in parallel using `Promise.allSettled()`
- [ ] Returns array of individual results
- [ ] Tests cover all success, all failure, mixed results
- [ ] Exported in `src/soroban/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `invokeContract()` pattern. Handle partial failures. Add tests to `src/tests/soroban.test.ts`.

---

## Issue #71

**Title** — Add asset trust line management helpers

**Description:**

**Problem:**
Trust line setup is common but requires users to understand balance limits, removal. No helpers exist for checking trust line status or bulk trust line operations.

**Solution:**
Implement `checkTrustlines(publicKey, assetCodes: string[])` to check which trust lines exist. Implement `buildBulkTrustlines(sourceKey, assets: Asset[])` to set up multiple trust lines in single transaction.

**Acceptance Criteria:**

- [ ] `checkTrustlines()` function added to `src/transaction/index.ts`
- [ ] Returns which assets have trust lines set
- [ ] `buildBulkTrustlines()` function added to set up multiple in one tx
- [ ] Returns `SorokitResult<string>` (XDR)
- [ ] Tests cover single, multiple, existing trust lines
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Reference `buildTrustlineTransaction()` pattern. Compose multiple operations. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #72

**Title** — Add payment path finding and validation

**Description:**

**Problem:**
`src/transaction/buildTransaction.ts` doesn't support path payments. Building path payments requires manual Stellar SDK usage, not via sorokit abstraction. No validation of paths.

**Solution:**
Implement `buildPathPayment(sourceKey, destinationKey, destAsset, destAmount, path, options?)` in `src/transaction/index.ts`. Validates path, computes source amount, handles fees.

**Acceptance Criteria:**

- [ ] `buildPathPayment()` function added to `src/transaction/index.ts`
- [ ] Accepts source, destination, path, assets, amounts
- [ ] Validates path (assets, issuers)
- [ ] Returns `SorokitResult<string>` (XDR)
- [ ] Tests cover valid paths, invalid paths, no path
- [ ] Exported in `src/transaction/index.ts` and `src/index.ts`

**Note for contributors:**
Reference Stellar SDK path payment structure. Validate against issuers. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #73

**Title** — Add transaction fee surge detection with notifications

**Description:**

**Problem:**
`src/transaction/estimateFee.ts` returns fee estimate without surge warning. Users don't know if fee is anomalously high. No alert mechanism exists.

**Solution:**
Extend fee estimation to detect surge (fee > 2x median recent fee). Return `FeeEstimate` with optional `surge: boolean` flag. Add optional callback `onSurge?: (fee, median) => void`.

**Acceptance Criteria:**

- [ ] `FeeEstimate` type extended with optional `surge: boolean`
- [ ] Surge detected if fee > 2x recent median
- [ ] Median calculated from last 10 transactions
- [ ] Tests cover normal fee, surge fee, insufficient history
- [ ] Backward compatible; surge flag optional

**Note for contributors:**
Reference `estimateFee()` implementation. Fetch recent fees from Horizon. Add tests to `src/tests/transaction.test.ts`.

---

## Issue #74

**Title** — Add comprehensive integration tests for multi-step workflows

**Description:**

**Problem:**
Unit tests exist but real workflows (wallet connect → fetch account → build → sign → submit) not tested end-to-end. Integration gaps may exist between modules.

**Solution:**
Create integration test suite in `src/tests/integration/` covering: wallet connection flow, transaction build-sign-submit flow, contract invocation flow, account streaming with alerts.

**Acceptance Criteria:**

- [ ] Create `src/tests/integration/` directory
- [ ] Test: wallet connect → account fetch → transaction submit workflow
- [ ] Test: contract preparation → execution → result verification
- [ ] Test: account streaming with balance alerts
- [ ] All workflows pass with mock and (optional) testnet
- [ ] Tests document expected integration behavior

**Note for contributors:**
Use vitest for integration tests. Mock Horizon/RPC or use testnet. Keep tests focused on realistic scenarios. Reference unit tests for setup.

---

## Issue #75

**Title** — Add performance benchmarking suite and regressions

**Description:**

**Problem:**
No performance baselines exist. SDK modifications may introduce regressions (slower parsing, allocations). No automated detection of performance degradation.

**Solution:**
Create benchmark suite using vitest's bench API. Measure: XDR parsing, fee calculation, account fetch overhead, contract simulation. Set baseline thresholds. Flag regressions in CI.

**Acceptance Criteria:**

- [ ] Benchmark suite created in `src/tests/benchmarks/`
- [ ] Benchmarks cover: XDR parsing, fee calc, account fetch, contract sim
- [ ] Baselines documented in README
- [ ] CI flags regressions (>10% slower)
- [ ] Results published in PR comments
- [ ] Benchmarks pass on Node 18 and 20

**Note for contributors:**
Use vitest bench or hyperfine. Run on consistent hardware. Document baseline and acceptable regression threshold.
