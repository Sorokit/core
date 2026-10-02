# sorokit-core Recipes

Practical, copy-paste-ready recipes for common Stellar and Soroban patterns.
Each recipe has a **problem statement**, a **solution**, working **code**, and **testing tips**.

All code uses the `sorokit-core` public API and the no-throw `SorokitResult<T>` model.
Branch on `result.status` — never wrap these calls in `try/catch`.

---

## Recipes

| # | Recipe | Use case |
|---|--------|----------|
| 1 | [Multi-sig approval workflow](./01-multisig-approval.md) | N-of-M signatures for high-value payments |
| 2 | [Escrow with timelock](./02-escrow-timelock.md) | Funds held until a future timestamp |
| 3 | [DEX atomic swap](./03-dex-atomic-swap.md) | Swap two assets atomically on the Stellar DEX |
| 4 | [Soroban contract invoke with error handling](./04-soroban-invoke.md) | Invoke a smart contract with full error recovery |
| 5 | [Batch payment with progress tracking](./05-batch-payment.md) | Send many payments, track success/failure per item |
| 6 | [Portfolio rebalancing](./06-portfolio-rebalancing.md) | Read balances and swap to hit target allocations |
| 7 | [Offer management on DEX](./07-offer-management.md) | Create, update, and cancel limit orders |
| 8 | [Account key rotation](./08-key-rotation.md) | Replace a compromised signing key securely |
| 9 | [Payment with memo (SEP-7 style)](./09-payment-with-memo.md) | Attach a memo for exchange routing or identification |
| 10 | [Account recovery workflow](./10-account-recovery.md) | Recover account access via designated guardians |
| 11 | [Trustline management](./11-trustline-management.md) | Add, audit, and remove asset trustlines |
| 12 | [Path payment (cross-asset)](./12-path-payment.md) | Send one asset, recipient receives a different asset |
| 13 | [Real-time balance alerts and streaming](./13-balance-alerts-streaming.md) | React to balance changes without polling yourself |
| 14 | [Contract deployment with validation](./14-contract-deployment.md) | Deploy a Soroban WASM with pre-flight checks |
| 15 | [Fee estimation and surge pricing](./15-fee-estimation.md) | Estimate fees accurately before building a transaction |

---

## Common setup

All recipes assume the client is initialised like this:

```ts
import { createSorokitClient, FreighterAdapter } from "sorokit-core";

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);

const client = clientResult.data;
```

And a wallet adapter is connected:

```ts
const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);

const { publicKey } = conn.data;
const { networkPassphrase } = client.networkConfig;
```

---

## Patterns used throughout

**Result branching** — every async function returns `SorokitResult<T>`. Check `status` before reading `data`:

```ts
const result = await client.account.get(publicKey);
if (result.status === "error") {
  console.error(result.error.code, result.error.message);
  return;
}
console.log(result.data.balances);
```

**Sign helper** — signing is the same shape everywhere:

```ts
async function sign(xdr: string): Promise<string> {
  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: xdr,
    networkPassphrase,
  });
  if (signed.status === "error") throw new Error(signed.error.message);
  return signed.data;
}
```

---

## See also

- [Migration guide](../migration-guide.md) — side-by-side stellar-sdk vs sorokit-core
- [Workflows reference](../workflows.md) — lifecycle diagrams and recovery patterns
- [Architecture guide](../architecture.md) — module boundaries and extension points
- [API Reference](https://tochukwujustice.github.io/core/) — full type documentation
