# Recipe: Soroban Contract Invoke with Error Handling

## Problem

You need to call a method on a deployed Soroban smart contract — for example, transferring a token or triggering a contract action. The pipeline has three distinct failure modes:

1. **Prepare** — building and simulating the transaction (bad args, contract not found, insufficient fee).
2. **Sign** — wallet rejection or user cancellation.
3. **Execute** — RPC node errors, simulation divergence, transaction expiry.

Each stage needs its own error handling strategy.

## Solution

Use `client.soroban.invoke()` for the happy path, or the three-step pipeline (`prepare` → `sign` → `execute`) when you need to inspect or act on intermediate state.

## Code

### Option A — one-call pipeline (`invoke`)

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
} from "sorokit-core";
import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk";

// ── Setup ─────────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { rpcUrl, horizonUrl, networkPassphrase } = network.data;

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);
const { publicKey } = conn.data;

const CONTRACT_ID = "CABC…CONTRACT"; // deployed contract address

// ── Invoke ────────────────────────────────────────────────────────────────────

const result = await client.soroban.invoke(
  {
    contractId: CONTRACT_ID,
    method:     "transfer",
    publicKey,
    args: [
      // from
      new xdr.ScVal.scvAddress(Address.fromString(publicKey).toScAddress()),
      // to
      new xdr.ScVal.scvAddress(Address.fromString("GDST…RECIP").toScAddress()),
      // amount (i128)
      nativeToScVal(BigInt("1000000"), { type: "i128" }),
    ],
  },
  // Sign function — wallet-agnostic
  async (unsignedXdr) => {
    const signed = await client.wallet.signTransaction(adapter, {
      transactionXdr: unsignedXdr,
      networkPassphrase,
    });
    if (signed.status === "error") throw new Error(signed.error.message);
    return signed.data;
  },
);

if (result.status === "error") {
  handleInvokeError(result.error);
  process.exit(1);
}

console.log("Contract call confirmed. Tx hash:", result.data);
```

### Option B — three-step pipeline (full control)

```ts
// ── Step 1: Prepare ───────────────────────────────────────────────────────────

const prepared = await client.soroban.prepare({
  contractId: CONTRACT_ID,
  method:     "transfer",
  publicKey,
  args: [
    new xdr.ScVal.scvAddress(Address.fromString(publicKey).toScAddress()),
    new xdr.ScVal.scvAddress(Address.fromString("GDST…RECIP").toScAddress()),
    nativeToScVal(BigInt("1000000"), { type: "i128" }),
  ],
});

if (prepared.status === "error") {
  if (prepared.error.code === "CONTRACT_NOT_FOUND") {
    console.error("Contract does not exist:", CONTRACT_ID);
  } else if (prepared.error.code === "TX_BUILD_FAILED") {
    console.error("Bad arguments or insufficient fee:", prepared.error.message);
  } else {
    console.error("Prepare failed:", prepared.error.code, prepared.error.message);
  }
  process.exit(1);
}

console.log("Prepared XDR. Estimated fee:", prepared.data.fee, "stroops");

// ── Step 2: Simulate before signing (optional but recommended) ────────────────

const simulation = await client.soroban.simulate(prepared.data.transactionXdr);

if (simulation.status === "error") {
  console.error("Simulation failed — do not sign:", simulation.error.message);
  // Simulation errors often indicate contract logic issues, not transient failures.
  // Do not auto-retry without fixing the args or contract state.
  process.exit(1);
}

console.log("Simulation succeeded. Auth entries:", simulation.data.auth?.length ?? 0);

// ── Step 3: Sign ──────────────────────────────────────────────────────────────

const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: prepared.data.transactionXdr,
  networkPassphrase,
});

if (signed.status === "error") {
  if (signed.error.message.toLowerCase().includes("user cancel")) {
    console.warn("User cancelled signing — no transaction submitted.");
  } else {
    console.error("Sign failed:", signed.error.message);
  }
  process.exit(1);
}

// ── Step 4: Execute ───────────────────────────────────────────────────────────

const executed = await client.soroban.execute(signed.data);

if (executed.status === "error") {
  handleInvokeError(executed.error);
  process.exit(1);
}

console.log("Contract call confirmed. Tx hash:", executed.data);
```

### Error handler

```ts
import type { SorokitError } from "sorokit-core";

function handleInvokeError(error: SorokitError): void {
  switch (error.code) {
    case "CONTRACT_NOT_FOUND":
      console.error("The contract does not exist or is archived:", error.message);
      break;

    case "CONTRACT_INVOKE_FAILED":
      // The contract method returned an error value — inspect the XDR detail
      console.error("Contract logic rejected the call:", error.message);
      // error.cause may contain the raw XDR result for debugging
      break;

    case "TX_SUBMIT_FAILED":
      if (error.message.includes("tx_bad_seq")) {
        console.error("Sequence conflict — rebuild the transaction with a fresh sequence.");
      } else if (error.message.includes("op_no_trust")) {
        console.error("Recipient does not have a trustline for this token.");
      } else {
        console.error("Submission failed:", error.message);
      }
      break;

    case "NETWORK_ERROR":
    case "TIMEOUT":
      // Transient — the XDR may have already been submitted. Check status before retrying.
      console.error("Network error. Check tx status before retrying:", error.message);
      break;

    default:
      console.error("Unexpected error:", error.code, error.message);
  }
}
```

## Reading contract state before calling

Always read relevant state before invoking to confirm preconditions:

```ts
const balanceResult = await client.soroban.read({
  contractId: CONTRACT_ID,
  method:     "balance",
  args: [new xdr.ScVal.scvAddress(Address.fromString(publicKey).toScAddress())],
});

if (balanceResult.status === "ok") {
  console.log("Current token balance:", balanceResult.data.value);
} else {
  console.warn("Could not read balance:", balanceResult.error.message);
}
```

## Tracking contract events

After a successful invocation, decode emitted events to confirm the operation:

```ts
import { queryContractEvents, decodeContractEvent } from "sorokit-core";

const events = await queryContractEvents(CONTRACT_ID, undefined, { horizonUrl });
for (const event of events) {
  const decoded = decodeContractEvent(event);
  if (decoded?.type === "transfer") {
    console.log("Transfer event:", decoded.data);
  }
}
```

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Happy path
client.soroban.prepare.mockResolvedValueOnce({
  status: "ok",
  data: { transactionXdr: "XDR…", fee: "100" },
  error: null,
});
client.soroban.execute.mockResolvedValueOnce({
  status: "ok",
  data: "TX_HASH",
  error: null,
});

// Test contract-not-found
client.soroban.prepare.mockResolvedValueOnce({
  status: "error",
  data: null,
  error: { code: "CONTRACT_NOT_FOUND", message: "Contract not found" },
});
```

## See also

- [Contract deployment](./14-contract-deployment.md) — deploy a contract before invoking it
- [DEX atomic swap](./03-dex-atomic-swap.md) — invoke a DEX contract atomically
- [Soroban docs](https://developers.stellar.org/docs/smart-contracts) — contract interface reference
