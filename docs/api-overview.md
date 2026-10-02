# Sorokit Core API Reference

Sorokit Core is a framework-independent TypeScript SDK for Stellar wallets,
accounts, transactions, and Soroban contracts.

Start with {@link createSorokitClient} to create a client. Browse its
{@link SorokitClient} interface for wallet, account, transaction, Soroban, and
network operations. Public methods return {@link SorokitResult} values.

```ts
import { createSorokitClient } from "sorokit-core";

const result = createSorokitClient({ network: "testnet" });
if (result.status === "ok") {
  const client = result.data;
  console.log(client.network.getConfig());
}
```

Use the search box or navigation to find functions, interfaces, and examples.

- [Getting started and SDK usage](https://github.com/TochukwuJustice/core#readme)
- [Task-oriented workflows](https://github.com/TochukwuJustice/core/blob/main/docs/workflows.md)
- [Architecture guide](https://github.com/TochukwuJustice/core/blob/main/docs/architecture.md)

To regenerate this reference locally, run `npm ci --legacy-peer-deps` and
`npm run docs`, then open `docs/api/index.html`. Generated files are not committed.
