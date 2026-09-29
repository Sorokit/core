# ADR-002: Wallet Adapter System

## Status
Accepted

## Problem
The Stellar and Soroban ecosystem has multiple wallet providers (Freighter, Albedo, xBull, etc.), each with their own unique APIs and integration patterns. Hardcoding support for specific wallets into the core application logic would tightly couple our system to those providers, making it difficult to maintain, test, and expand to new wallets in the future.

## Solution
We implemented a plugin-based Wallet Adapter System. We define a standard `WalletAdapter` interface that every wallet integration must implement.

Example:
```ts
interface WalletAdapter {
  id: string;
  name: string;
  connect(): Promise<SorokitResult<AccountDetails, ConnectionError>>;
  signTransaction(tx: Transaction): Promise<SorokitResult<SignedTransaction, SigningError>>;
}
```
The core application only interacts with the `WalletAdapter` interface, while individual packages (e.g., `@sorokit/freighter-adapter`) implement the specifics.

## Tradeoffs
*   **Pros:** High cohesion and loose coupling. Easy to add new wallets without changing core code. Users of the library can bundle only the adapters they need, reducing bundle size.
*   **Cons:** Abstraction layer can sometimes hide wallet-specific features. Requires maintenance of multiple adapter packages.

## Consequences
*   Adding a new wallet requires writing a new adapter that conforms to the interface.
*   Wallet-specific bugs are isolated to their respective adapter modules.
*   The frontend can dynamically load adapters based on user preference or detection mechanisms.
