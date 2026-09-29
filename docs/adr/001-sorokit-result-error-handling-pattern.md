# ADR-001: SorokitResult Error Handling Pattern

## Status
Accepted

## Problem
In a complex system interacting with the Soroban network and various wallet providers, errors can happen at multiple layers (network, contract, wallet, parsing). Throwing exceptions indiscriminately leads to unpredictable control flow, makes it hard to guarantee that all edge cases are handled, and creates a poor developer experience where callers are forced to wrap everything in `try/catch` blocks. We needed a unified, predictable pattern for handling operations that can fail.

## Solution
We introduced the `SorokitResult<T, E>` pattern, inspired by Rust's `Result` type. All major asynchronous operations and domain logic functions now return a `SorokitResult`.

Example:
```ts
const result = await contract.invoke({ method: "swap" });

if (!result.ok) {
  console.error("Operation failed:", result.error.message);
  return;
}

console.log("Success with data:", result.data);
```

## Tradeoffs
*   **Pros:** Forces the developer to explicitly handle both success and error cases. Improves type safety and predictability. Avoids silent failures and deep unhandled promise rejections.
*   **Cons:** Slightly more verbose than standard async/await with try/catch. Requires wrapping legacy or third-party code that throws exceptions into `SorokitResult` objects.

## Consequences
*   All new API methods must be designed to return `SorokitResult` rather than throwing errors.
*   We need to maintain a set of standard error types (the `E` in the result) so that developers can easily pattern-match on failure reasons (e.g., `UserRejectedError`, `NetworkTimeoutError`).
