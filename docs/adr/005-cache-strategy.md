# ADR-005: Cache Strategy

## Status
Accepted

## Problem
Frequent calls to the Soroban RPC for static or slowly-changing data (such as contract WASM bytecodes, token decimals, or ledger state that hasn't advanced) cause unnecessary network traffic, slow down application performance, and quickly consume rate limits on public RPC endpoints.

## Solution
We implemented a tiered Cache Strategy. 
1. **Memory Cache (L1):** For highly accessed, ephemeral data that is valid for the current block/ledger.
2. **Persistent Storage Cache (L2):** (e.g., IndexedDB/LocalStorage in browser) For immutable data like contract metadata, token symbols, and decimals.

Example:
```ts
const metadata = await sorokit.getTokenMetadata(tokenId, {
  cache: 'force-cache' // Will hit L2, then L1, then network
});
```

## Tradeoffs
*   **Pros:** Significantly improves load times and application responsiveness. Reduces dependency on RPC reliability and limits. 
*   **Cons:** Risk of stale data if cache invalidation logic is flawed. Increases memory consumption on the client. Adds complexity to the data fetching layer.

## Consequences
*   All data fetchers must incorporate a cache policy parameter.
*   We must implement automatic cache invalidation based on ledger sequence numbers (e.g., clearing L1 cache when a new ledger is detected).
*   Immutable data is cached indefinitely but must have a manual bust mechanism if needed.
