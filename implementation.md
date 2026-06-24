# Implementation Notes: Transaction History Streaming Filters And Pagination

## Summary

This change extends transaction streaming with client-side filtering and pagination. `TransactionStreamConfig` now accepts optional ledger, status, date, limit, and offset controls. `streamTransactions()` applies those controls before yielding each page while preserving existing cursor, order, polling, abort, and error-yielding behavior.

## Files Changed

- `src/transaction/streamTransactions.ts`
- `src/tests/transaction.test.ts`
- `src/shared/constants.ts`

`src/shared/constants.ts` now defines `DEFAULT_TX_CACHE_TTL_MS`, which was already imported by `src/transaction/submitTransaction.ts` and expected by existing transaction tests. This small consistency fix was required to keep the repaired transaction test file runnable.

## Stellar Documentation References

The implementation follows Horizon's documented transaction and pagination behavior:

- Account transaction history is exposed at `GET /accounts/:account_id/transactions` and can be streamed. If no cursor is set, Horizon starts at the earliest known transaction; when a cursor is set, streaming starts from that cursor. Documentation: https://developers.stellar.org/docs/data/apis/horizon/api-reference/get-transactions-by-account-id
- Horizon collection endpoints are paginated and return records under `_embedded.records`, with page navigation through `next` and `prev` links. Documentation: https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure/pagination
- Horizon page arguments are `cursor`, `order`, and `limit`; `limit` ranges from 1 to 200 and defaults to 10. Documentation: https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure/pagination/page-arguments

Because Horizon does not provide the exact combination of filters requested by this issue for account transaction history, filtering is applied client-side after each Horizon page fetch, as requested in the contributor note.

## API Changes

`TransactionStreamConfig` now supports:

- `minLedger?: number`
- `maxLedger?: number`
- `statuses?: Array<"success" | "failed" | "pending">`
- `beforeDate?: string | Date`
- `afterDate?: string | Date`
- `offset?: number`

The existing `limit?: number` remains backward compatible. It still limits the number of transactions yielded per poll, with a default of 10.

## Filter Flow

Filtering is centralized in `applyTransactionFilters(transactions, config)`.

The order is:

1. Ledger range filter
2. Status filter
3. Date range filter
4. Pagination with `offset` and `limit`

This order ensures pagination is applied to the filtered result set, not to the raw Horizon page.

## Filter Semantics

Ledger filters are inclusive:

- `minLedger` keeps transactions with `ledger >= minLedger`.
- `maxLedger` keeps transactions with `ledger <= maxLedger`.
- Transactions without `ledger` are excluded only when a ledger filter is active.

Status filtering:

- Omitted or empty `statuses` means no status filtering.
- `success`, `failed`, and `pending` are accepted.
- Stellar's Horizon docs describe the account transaction endpoint as returning successful transactions. The stream preserves the existing SDK mapping from Horizon's `successful` field when records are present, so `failed` remains supported by the client-side filter for compatibility with existing types and mocked/custom Horizon-like data. `pending` is also accepted because the SDK transaction type already includes it, but the stream does not synthesize pending transactions.

Date filters are inclusive:

- `afterDate` keeps transactions with `createdAt >= afterDate`.
- `beforeDate` keeps transactions with `createdAt <= beforeDate`.
- `string` and `Date` inputs are accepted.
- Transactions without a valid `createdAt` are excluded only when a date filter is active.

Pagination:

- `offset` defaults to 0 and negative/invalid values are normalized to 0.
- `limit` defaults to 10 and invalid values are normalized to the default.
- The yielded page is `filtered.slice(offset, offset + limit)`.

## Horizon Fetch Limit

The stream fetches up to `offset + limit` records from Horizon, capped at Horizon's documented maximum of 200 records per page. This keeps memory bounded while allowing the local offset to work against the current fetched page.

`nextCursor` still comes from the last fetched Horizon record, not the last filtered record. That preserves streaming progress even when all fetched records are filtered out.

## Backward Compatibility

- All new config fields are optional.
- Existing callers without filters receive the same shape: `SorokitResult<TransactionPage>`.
- Existing cursor and order behavior is unchanged.
- Empty filtered pages still yield `ok({ transactions: [], nextCursor })`.
- Errors are still yielded as `SorokitResult` error values rather than thrown.

## Complexity Analysis

For each Horizon page, filtering is `O(n)` time where `n` is the number of fetched records. Each transaction is checked once for ledger, status, and date eligibility. Pagination is `O(k)` for the sliced output, where `k <= limit`.

Space complexity is `O(m)` for the filtered transactions before slicing, where `m <= n`. Horizon fetch size is capped at 200, so both time and memory are bounded per poll.

The implementation avoids unbounded history crawling, persistent in-memory buffers, and multi-page aggregation. That keeps streaming predictable for large consumers and directly addresses the memory-bloat concern in the issue.

## Tests

`src/tests/transaction.test.ts` now covers:

- Backward-compatible no-filter behavior
- Minimum ledger filtering
- Maximum ledger filtering
- Combined ledger range filtering
- Excluding missing ledger when ledger filters are active
- Success, failed, pending, and multi-status filters
- Empty statuses as no-op
- `afterDate`, `beforeDate`, and combined date range filtering
- Excluding missing/invalid dates when date filters are active
- Offset after filters
- Limit after filters
- Combined filters with pagination
- Empty result sets
- `streamTransactions()` yielding filtered results and advancing `nextCursor` from the fetched Horizon page

The transaction test file also had a pre-existing syntax break in its hoisted mock setup. That was minimally repaired so the new tests and existing transaction tests can run.
