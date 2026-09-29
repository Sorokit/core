# ADR-004: Contract Interaction Patterns

## Status
Accepted

## Problem
Interacting with Soroban smart contracts requires a multi-step process: simulating the transaction to calculate resource footprints, assembling the transaction, signing it with a wallet, submitting it to the network, and polling for the final result. Leaving this orchestration to individual developers leads to boilerplate code, inconsistent error handling, and frequent mistakes with fee or resource estimations.

## Solution
We encapsulated the entire lifecycle into unified Contract Interaction Patterns using a declarative builder approach. Developers define the intent, and the core library handles the simulation, signing, and submission pipeline automatically.

Example:
```ts
const result = await sorokit.contract(contractId)
  .call("increment_counter")
  .withArgs({ amount: 1 })
  .send({ signAndSubmit: true });
```

## Tradeoffs
*   **Pros:** Dramatically reduces boilerplate. Ensures resources and fees are consistently and correctly estimated. Provides a single place to implement telemetry or global error handling.
*   **Cons:** Masks the underlying Stellar transaction building process, which might make advanced, custom multi-operation transactions slightly harder to compose if they don't fit the standard pattern.

## Consequences
*   The standard `call()` method will automatically perform pre-flight simulation to gather required resource footprints.
*   We need to provide an "escape hatch" (e.g., `.buildTransaction()`) for developers who need to manually attach extra operations or modify fees before signing.
