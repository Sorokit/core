# ADR-003: Streaming Architecture

## Status
Accepted

## Problem
Blockchain applications often need to react to real-time events, such as ledger closes, contract events, or account balance changes. Polling the RPC node continuously leads to high network overhead, rate-limiting issues, and delayed data propagation, providing a poor user experience.

## Solution
We chose a Streaming Architecture utilizing Server-Sent Events (SSE) and WebSockets where available, falling back to smart polling only when necessary. Data is pushed to the client, mapped into reactive streams (e.g., using RxJS or async iterators), and consumed by the UI.

Example:
```ts
const eventStream = sorokit.streamContractEvents(contractId);

for await (const event of eventStream) {
  if (event.type === 'transfer') {
    updateBalance(event.data);
  }
}
```

## Tradeoffs
*   **Pros:** Lower latency for end users. Reduced load on RPC nodes. Better abstraction for handling continuous sequences of data.
*   **Cons:** More complex state management on the client (handling stream disconnections, reconnections, and missed events). Requires robust backend infrastructure that supports persistent connections.

## Consequences
*   We must implement automatic reconnection logic with exponential backoff for all streams.
*   State must be designed to be eventually consistent, accommodating potential out-of-order events or missed messages during disconnects.
