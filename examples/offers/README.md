# Create and Cancel Offers Example

This example demonstrates how to create and cancel offers on the Stellar testnet using the SDK.

## What This Example Does

1. Creates a funded testnet account (via Friendbot)
2. Creates a sell offer on the Stellar DEX
3. Queries the offer to confirm it exists
4. Cancels the offer
5. Confirms the offer no longer exists

## Prerequisites

- Node.js 22 or later
- npm

## Setup

```bash
# From this directory
npm install
```

## Dependencies

- `@stellar/stellar-sdk` — Stellar SDK for JavaScript
- `tsx` — TypeScript execution for running the example

## Running the Example

```bash
npm start
```

The example connects to the Stellar **testnet** (`https://horizon-testnet.stellar.org`) and the testnet Friendbot. No real funds are used.

## Files

- `index.ts` — Runnable example source code
- `package.json` — Dependencies and scripts
- `tsconfig.json` — TypeScript configuration

## How It Works

### Creating an Offer

An offer is created with a `manageSellOffer` operation. You specify:

- **Selling asset** — the asset you want to sell
- **Buying asset** — the asset you want in return
- **Amount** — how much of the selling asset to offer
- **Price** — how many units of the buying asset you want per unit of the selling asset

```ts
const offer = await server.offers().offer(offerId).call();
```

### Canceling an Offer

An offer is canceled by submitting a `manageSellOffer` operation with the same offer ID and an amount of `"0"`.

```ts
const cancelOp = Operation.manageSellOffer({
  selling: Asset.native(),
  buying: new Asset("USDC", issuer),
  amount: "0",
  price: "1",
  offerId: offerId,
});
```

## Notes

- Offers on the Stellar DEX require the account to hold the assets being traded.
- The example uses the native asset (XLM) and a test asset to keep setup simple.
- Testnet accounts and offers are ephemeral; rerun the example to start fresh.

## Troubleshooting

- **`op_low_reserve`** — ensure the account has enough XLM to cover the base reserve and the offer.
- **`op_no_trust`** — the account must have a trustline for any non-native asset it trades.
- **Network errors** — confirm you can reach `horizon-testnet.stellar.org`.