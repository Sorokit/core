# Recipe: Offer Management on DEX

## Problem

You want to place, update, and cancel limit orders on the Stellar DEX. Unlike an atomic swap (which is a market order), a limit order sits in the order book until it is filled or cancelled. You need to:

1. List your current open offers.
2. Create a new sell offer.
3. Modify an existing offer's price.
4. Cancel an offer.

## Solution

Use `getOffers` and `getTrades` from the client, and `buildTransaction` with `ManageOfferParams` for creating/updating/cancelling offers. Offers are managed via Stellar's `ManageSellOffer` and `ManageBuyOffer` operations.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { buildPaymentTransaction } from "sorokit-core/transaction";
import { buildManageOfferTransaction } from "sorokit-core/transaction";

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

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ── 2. List current open offers ───────────────────────────────────────────────

const offersResult = await client.account.getOffers(publicKey, { horizonUrl });

if (offersResult.status === "error") {
  console.error("Could not fetch offers:", offersResult.error.message);
  process.exit(1);
}

const openOffers = offersResult.data;
console.log(`Open offers: ${openOffers.length}`);

for (const offer of openOffers) {
  console.log(
    `  #${offer.id}  Sell ${offer.amount} ${offer.selling.assetCode}` +
    ` @ ${offer.price} ${offer.buying.assetCode}/${offer.selling.assetCode}`,
  );
}

// ── 3. Create a new sell offer ────────────────────────────────────────────────
//
// Sell 100 USDC at 0.45 XLM per USDC (i.e., buy XLM with USDC)

async function sign(xdr: string): Promise<string> {
  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: xdr,
    networkPassphrase,
  });
  if (signed.status === "error") throw new Error(signed.error.message);
  return signed.data;
}

async function submitSigned(xdr: string) {
  const signedXdr = await sign(xdr);
  const result = await submitTransaction(horizonUrl, network.data, signedXdr);
  if (result.status === "error") throw new Error(result.error.message);
  return result.data;
}

// Build a ManageSellOffer transaction
const createOfferTx = await client.transaction.buildManageOffer(publicKey, {
  selling: { code: "USDC", issuer: USDC_ISSUER },
  buying:  { code: "XLM",  issuer: null },
  amount:  "100",       // USDC to sell
  price:   "0.45",      // XLM per USDC
  offerId: "0",         // 0 = create new offer
});

if (createOfferTx.status === "error") {
  console.error("Create offer failed:", createOfferTx.error.message);
  process.exit(1);
}

const createResult = await submitSigned(createOfferTx.data);
console.log("Offer created! Tx hash:", createResult.hash);

// ── 4. Look up the new offer ID ───────────────────────────────────────────────
//
// After creating, fetch offers again to find the new offer's ID.

const refreshedOffers = await client.account.getOffers(publicKey, { horizonUrl });
if (refreshedOffers.status === "error") {
  console.error("Could not refresh offers:", refreshedOffers.error.message);
  process.exit(1);
}

const newOffer = refreshedOffers.data.find(
  (o) => o.selling.assetCode === "USDC" && o.amount === "100.0000000",
);

if (!newOffer) {
  console.error("Newly created offer not found — it may have been filled immediately.");
  process.exit(0);
}

console.log("New offer ID:", newOffer.id);

// ── 5. Update the offer price ─────────────────────────────────────────────────

const updateOfferTx = await client.transaction.buildManageOffer(publicKey, {
  selling: { code: "USDC", issuer: USDC_ISSUER },
  buying:  { code: "XLM",  issuer: null },
  amount:  "100",         // keep the same amount
  price:   "0.48",        // update price to 0.48 XLM per USDC
  offerId: newOffer.id,   // use existing offer ID to update
});

if (updateOfferTx.status === "error") {
  console.error("Update offer failed:", updateOfferTx.error.message);
  process.exit(1);
}

const updateResult = await submitSigned(updateOfferTx.data);
console.log("Offer updated! Tx hash:", updateResult.hash);

// ── 6. Cancel the offer ───────────────────────────────────────────────────────
//
// Setting amount to "0" cancels the offer.

const cancelOfferTx = await client.transaction.buildManageOffer(publicKey, {
  selling: { code: "USDC", issuer: USDC_ISSUER },
  buying:  { code: "XLM",  issuer: null },
  amount:  "0",           // ← amount 0 = cancel
  price:   "1",           // price is ignored when amount is 0 but must be > 0
  offerId: newOffer.id,
});

if (cancelOfferTx.status === "error") {
  console.error("Cancel offer failed:", cancelOfferTx.error.message);
  process.exit(1);
}

const cancelResult = await submitSigned(cancelOfferTx.data);
console.log("Offer cancelled! Tx hash:", cancelResult.hash);

// ── 7. View recent trades ─────────────────────────────────────────────────────

const tradesResult = await client.account.getTrades(publicKey, { horizonUrl, limit: 20 });

if (tradesResult.status === "ok") {
  console.log(`\nRecent trades (${tradesResult.data.length}):`);
  for (const trade of tradesResult.data) {
    console.log(
      `  ${trade.baseAmount} ${trade.baseAssetCode}` +
      ` ↔ ${trade.counterAmount} ${trade.counterAssetCode}` +
      ` @ ${trade.price}`,
    );
  }
}
```

## Passive offers

Passive offers do not take liquidity from existing offers (they can be placed without immediately matching). Use `ManagePassiveSellOffer`:

```ts
// A passive offer behaves like a limit order that won't cross the spread.
// Useful for market-making without aggressively filling existing orders.
const passiveOfferTx = await client.transaction.buildManageOffer(publicKey, {
  selling:  { code: "USDC", issuer: USDC_ISSUER },
  buying:   { code: "XLM",  issuer: null },
  amount:   "500",
  price:    "0.42",
  offerId:  "0",
  passive:  true, // ← creates a ManagePassiveSellOffer
});
```

## Order book monitoring

Poll the order book to decide when to place offers:

```ts
const orderBook = await client.account.getOffers(publicKey, {
  horizonUrl,
  selling: { code: "XLM",  issuer: null },
  buying:  { code: "USDC", issuer: USDC_ISSUER },
});
```

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Simulate no open offers
client.account.getOffers.mockResolvedValueOnce({ status: "ok", data: [], error: null });

// Simulate a successful create
client.transaction.buildManageOffer.mockResolvedValueOnce({
  status: "ok",
  data: "UNSIGNED_XDR",
  error: null,
});

// Verify that the offer ID from the response is used in the update call
```

## See also

- [DEX atomic swap](./03-dex-atomic-swap.md) — immediate market-order swap
- [Portfolio rebalancing](./06-portfolio-rebalancing.md) — combine limit orders with rebalancing
- [Path payment](./12-path-payment.md) — cross-asset payments that route through the DEX
