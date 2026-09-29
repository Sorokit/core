# Recipe: DEX Atomic Swap

## Problem

You want to swap asset A for asset B in a single transaction. The swap must succeed fully or fail completely — no partial fills, no stranded intermediate states. You also need to handle slippage: the price can move between your quote and your execution.

## Solution

Use `findSwapPath` to discover available routes, then `buildAtomicSwap` (or `compose()`) to build a single transaction that includes both sides of the swap atomically. `buildAtomicSwap` wraps Stellar's `PathPaymentStrictSend` operation.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  findSwapPath,
  submitTransaction,
  resolveNetwork,
} from "sorokit-core";
import { buildAtomicSwap } from "sorokit-core/transaction";

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

// ── 2. Discover swap paths ────────────────────────────────────────────────────

const SEND_ASSET = { code: "XLM",  issuer: null };
const DEST_ASSET = {
  code:   "USDC",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

const SEND_AMOUNT = "100"; // send exactly 100 XLM

const pathsResult = await findSwapPath(
  horizonUrl,
  {
    sourcePublicKey: publicKey,
    sendAssetCode:   SEND_ASSET.code,
    sendAssetIssuer: SEND_ASSET.issuer,
    destAssetCode:   DEST_ASSET.code,
    destAssetIssuer: DEST_ASSET.issuer,
    amount:          SEND_AMOUNT,
    mode:            "strict-send",
  },
);

if (pathsResult.status === "error") {
  console.error("No swap path found:", pathsResult.error.message);
  process.exit(1);
}

const routes = pathsResult.data;
if (routes.length === 0) {
  console.error("No routes available for this pair.");
  process.exit(1);
}

// Pick the best route (highest price = most USDC per XLM sent)
const bestRoute = routes.reduce((best, route) =>
  Number(route.price) > Number(best.price) ? route : best,
);

console.log("Best route:");
console.log("  Path:", bestRoute.path.map((a) => a.code).join(" → ") || "direct");
console.log("  Price:", bestRoute.price, `${DEST_ASSET.code}/${SEND_ASSET.code}`);

// ── 3. Apply slippage tolerance ───────────────────────────────────────────────

const SLIPPAGE_PERCENT = 1; // accept up to 1% worse than quoted price
const estimatedDestAmount = Number(SEND_AMOUNT) * Number(bestRoute.price);
const minDestAmount = (estimatedDestAmount * (1 - SLIPPAGE_PERCENT / 100)).toFixed(7);

console.log("Estimated receive:", estimatedDestAmount.toFixed(7), DEST_ASSET.code);
console.log("Minimum acceptable:", minDestAmount, DEST_ASSET.code);

// ── 4. Build the atomic swap transaction ─────────────────────────────────────

const swapTx = await buildAtomicSwap(
  horizonUrl,
  network.data,
  {
    sourcePublicKey: publicKey,
    sendAssetCode:   SEND_ASSET.code,
    sendAssetIssuer: SEND_ASSET.issuer,
    destAssetCode:   DEST_ASSET.code,
    destAssetIssuer: DEST_ASSET.issuer,
    sendAmount:      SEND_AMOUNT,
    // Minimum dest amount enforces slippage on-chain — Horizon rejects the tx
    // if the actual received amount falls below this value.
    destMinAmount:   minDestAmount,
    path:            bestRoute.path,
    destination:     publicKey, // send back to self
  },
);

if (swapTx.status === "error") {
  console.error("Swap build failed:", swapTx.error.message);
  process.exit(1);
}

// ── 5. Sign and submit ────────────────────────────────────────────────────────

const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: swapTx.data,
  networkPassphrase,
});

if (signed.status === "error") {
  console.error("Sign failed:", signed.error.message);
  process.exit(1);
}

const result = await submitTransaction(horizonUrl, network.data, signed.data);

if (result.status === "error") {
  // Check for slippage rejection specifically
  if (result.error.message.includes("op_under_dest_min")) {
    console.error("Swap rejected: price moved beyond slippage tolerance. Try again.");
  } else {
    console.error("Swap failed:", result.error.code, result.error.message);
  }
  process.exit(1);
}

console.log("Swap confirmed! Hash:", result.data.hash);

// ── 6. Verify final balance ───────────────────────────────────────────────────

const balances = await client.account.getBalances(publicKey);
if (balances.status === "ok") {
  const usdc = balances.data.find((b) => b.assetCode === "USDC");
  console.log("USDC balance after swap:", usdc?.balance ?? "0");
}
```

## Using `compose()` for multi-step swaps

When you need to chain multiple swaps (A → B → C) or combine a swap with another operation, use the fluent `compose()` builder:

```ts
import { compose, resolveNetwork } from "sorokit-core";

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);

const built = await compose({ network: network.data, source: publicKey })
  .pathPayment({
    sendAsset:    { code: "XLM", issuer: null },
    destAsset:    { code: "USDC", issuer: USDC_ISSUER },
    sendAmount:   "50",
    destMinAmount: "9.8",
    destination:  publicKey,
    path:         [],
  })
  .pathPayment({
    sendAsset:    { code: "USDC", issuer: USDC_ISSUER },
    destAsset:    { code: "yXLM", issuer: YXLM_ISSUER },
    sendAmount:   "9.8",
    destMinAmount: "48",
    destination:  publicKey,
    path:         [],
  })
  .build();

if (built.status === "error") {
  console.error("Compose failed:", built.error.message);
}
```

Both operations land in the same transaction envelope, so if either fails the whole transaction is rolled back.

## Slippage and price impact

| Scenario | Behaviour |
|----------|-----------|
| Price improves | You receive more than `destMinAmount` — Stellar keeps the surplus for you |
| Price moves within tolerance | Transaction succeeds, you receive at least `destMinAmount` |
| Price moves beyond tolerance | Transaction fails with `op_under_dest_min` — no funds are moved |

Set `SLIPPAGE_PERCENT` based on the volatility of the pair. Stable/stable pairs (USDC/USDT) can use 0.1%. Volatile pairs (XLM/meme-token) may need 2–5%.

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Stub path discovery returning two routes
client.account.getOffers.mockResolvedValueOnce({ status: "ok", data: [...] });

// Test slippage rejection
const mockResult = { status: "error", error: { code: "TX_SUBMIT_FAILED", message: "op_under_dest_min" } };
client.transaction.submit.mockResolvedValueOnce(mockResult);

// Verify the caller detects slippage and retries
```

## See also

- [Path payment (cross-asset)](./12-path-payment.md) — strict-receive variant
- [Offer management on DEX](./07-offer-management.md) — place limit orders instead of market orders
- [Portfolio rebalancing](./06-portfolio-rebalancing.md) — orchestrate multiple swaps

## Edge Cases
- **Price Slippage:** The market price may move while the transaction is pending. Ensure you use `pathPaymentStrictReceive` or `pathPaymentStrictSend` with bounds to prevent being front-run or receiving a bad rate.
- **Missing Trustlines:** The receiving account must have a trustline established for the destination asset, otherwise the atomic swap will fail.
- **Zero Liquidity:** If the orderbook or liquidity pools do not have enough depth to fulfill the swap, the transaction will revert entirely.
