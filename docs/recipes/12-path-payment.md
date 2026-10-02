# Recipe: Path Payment (Cross-Asset)

## Problem

You want to send one asset and have the recipient receive a different asset. For example:
- Send XLM, recipient gets USDC.
- Send EURC, recipient gets BTC.
- The sender pays in their preferred asset; the recipient receives in theirs.

This differs from a DEX swap: the sender and receiver can be **different accounts**, and you can choose whether to fix the **send amount** (strict-send) or the **receive amount** (strict-receive).

## Solution

Use `findSwapPath` to discover the route, then `buildPathPaymentTransaction` (strict-send or strict-receive) to build the cross-asset payment.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  findSwapPath,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { buildPathPaymentTransaction } from "sorokit-core/transaction";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, networkPassphrase } = network.data;

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);
const { publicKey } = conn.data;

const SENDER      = publicKey;
const RECIPIENT   = "GREC…RECIP";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ── 2. Strict-send: send exactly 50 XLM, recipient gets as much USDC as possible

async function strictSendExample() {
  // Discover paths for a strict-send of 50 XLM → USDC
  const pathsResult = await findSwapPath(horizonUrl, {
    sourcePublicKey: SENDER,
    sendAssetCode:   "XLM",
    sendAssetIssuer: null,
    destAssetCode:   "USDC",
    destAssetIssuer: USDC_ISSUER,
    amount:          "50",
    mode:            "strict-send",
  });

  if (pathsResult.status === "error" || pathsResult.data.length === 0) {
    console.error("No path found:", pathsResult.status === "error" ? pathsResult.error.message : "empty");
    return;
  }

  const bestRoute = pathsResult.data[0]!;
  const estimatedReceive = (Number("50") * Number(bestRoute.price)).toFixed(7);

  // Apply 1% slippage: recipient must receive at least this much
  const minDestAmount = (Number(estimatedReceive) * 0.99).toFixed(7);

  console.log("Strict-send path:");
  console.log("  Send:     50 XLM");
  console.log("  Estimate:", estimatedReceive, "USDC");
  console.log("  Minimum: ", minDestAmount, "USDC (1% slippage tolerance)");

  const builtTx = await buildPathPaymentTransaction(horizonUrl, network.data, {
    sourcePublicKey: SENDER,
    destination:     RECIPIENT,
    sendAssetCode:   "XLM",
    sendAssetIssuer: null,
    destAssetCode:   "USDC",
    destAssetIssuer: USDC_ISSUER,
    amount:          "50",         // send amount is fixed
    mode:            "strict-send",
    path:            bestRoute.path,
    // destMinAmount enforces the slippage floor on-chain
    destMinAmount:   minDestAmount,
  });

  if (builtTx.status === "error") {
    console.error("Build failed:", builtTx.error.message);
    return;
  }

  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: builtTx.data,
    networkPassphrase,
  });

  if (signed.status === "error") {
    console.error("Sign failed:", signed.error.message);
    return;
  }

  const result = await submitTransaction(horizonUrl, network.data, signed.data);
  if (result.status === "ok") {
    console.log("Payment confirmed:", result.data.hash);
  } else {
    if (result.error.message.includes("op_under_dest_min")) {
      console.error("Rejected: recipient would have received less than minimum — try again.");
    } else {
      console.error("Submit failed:", result.error.message);
    }
  }
}

// ── 3. Strict-receive: recipient gets exactly 100 USDC, sender pays minimum XLM

async function strictReceiveExample() {
  const pathsResult = await findSwapPath(horizonUrl, {
    sourcePublicKey: SENDER,
    sendAssetCode:   "XLM",
    sendAssetIssuer: null,
    destAssetCode:   "USDC",
    destAssetIssuer: USDC_ISSUER,
    amount:          "100",         // destination amount
    mode:            "strict-receive",
  });

  if (pathsResult.status === "error" || pathsResult.data.length === 0) {
    console.error("No path found.");
    return;
  }

  const bestRoute = pathsResult.data[0]!;
  // For strict-receive, price = cost in send asset per dest unit
  const estimatedSend = (Number("100") / Number(bestRoute.price)).toFixed(7);

  // Add 1% slippage: sender is willing to spend up to this much
  const maxSendAmount = (Number(estimatedSend) * 1.01).toFixed(7);

  console.log("\nStrict-receive path:");
  console.log("  Receive:  100 USDC (exact)");
  console.log("  Estimate:", estimatedSend, "XLM");
  console.log("  Maximum: ", maxSendAmount, "XLM (1% slippage tolerance)");

  const builtTx = await buildPathPaymentTransaction(horizonUrl, network.data, {
    sourcePublicKey: SENDER,
    destination:     RECIPIENT,
    sendAssetCode:   "XLM",
    sendAssetIssuer: null,
    destAssetCode:   "USDC",
    destAssetIssuer: USDC_ISSUER,
    amount:          "100",          // dest amount is fixed
    mode:            "strict-receive",
    path:            bestRoute.path,
    // sendMaxAmount caps what the sender is willing to pay
    sendMaxAmount:   maxSendAmount,
  });

  if (builtTx.status === "error") {
    console.error("Build failed:", builtTx.error.message);
    return;
  }

  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: builtTx.data,
    networkPassphrase,
  });

  if (signed.status === "error") {
    console.error("Sign failed:", signed.error.message);
    return;
  }

  const result = await submitTransaction(horizonUrl, network.data, signed.data);
  if (result.status === "ok") {
    console.log("Payment confirmed:", result.data.hash);
  } else {
    if (result.error.message.includes("op_over_source_max")) {
      console.error("Rejected: would have cost more than maximum — try again.");
    } else {
      console.error("Submit failed:", result.error.message);
    }
  }
}

await strictSendExample();
await strictReceiveExample();
```

## Mode comparison

| | Strict-send | Strict-receive |
|---|---|---|
| What's fixed | The amount the sender sends | The amount the recipient receives |
| Slippage parameter | `destMinAmount` — floor on what recipient gets | `sendMaxAmount` — cap on what sender pays |
| Error code on rejection | `op_under_dest_min` | `op_over_source_max` |
| Best for | Airdrop, reward distribution | Invoice settlement, exact payment |

## Verifying recipient trustline

The recipient must have a trustline for `USDC` before receiving it:

```ts
const recipientBalances = await client.account.getBalances(RECIPIENT);
if (recipientBalances.status === "ok") {
  const hasTrustline = recipientBalances.data.some(
    (b) => b.assetCode === "USDC" && b.assetIssuer === USDC_ISSUER,
  );
  if (!hasTrustline) {
    console.error("Recipient does not have a USDC trustline. Payment will fail.");
  }
}
```

See [Trustline management](./11-trustline-management.md) for how to add one.

## Testing tips

```ts
import { findSwapPath, buildPathPaymentTransaction } from "sorokit-core/transaction";

// No liquidity path — should return empty or error
const noPath = await findSwapPath(horizonUrl, {
  sourcePublicKey: "GAAA…",
  sendAssetCode:   "RARE",
  sendAssetIssuer: "GRARE…ISSUER",
  destAssetCode:   "USDC",
  destAssetIssuer: USDC_ISSUER,
  amount:          "1",
  mode:            "strict-send",
});
// Either empty routes or an error — verify your caller handles both

// Strict-receive with amount too small (rounding errors)
const tiny = await buildPathPaymentTransaction(horizonUrl, network.data, {
  sourcePublicKey: "GAAA…",
  destination:     "GDST…",
  sendAssetCode:   "XLM",
  sendAssetIssuer: null,
  destAssetCode:   "USDC",
  destAssetIssuer: USDC_ISSUER,
  amount:          "0.0000001",
  mode:            "strict-receive",
  sendMaxAmount:   "1",
});
// Validate the result handles dust amounts gracefully
```

## See also

- [DEX atomic swap](./03-dex-atomic-swap.md) — same account sends and receives
- [Trustline management](./11-trustline-management.md) — enable an account to receive an asset
- [Batch payment](./05-batch-payment.md) — send path payments to many recipients
