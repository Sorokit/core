# Multi-Signature Account Example

This example demonstrates how to set up and use a multi-signature account on the Stellar testnet using the SDK. It covers:

1. Creating a new account
2. Adding multiple signers with weights
3. Setting the account's master key weight and thresholds
4. Building a transaction that requires multiple signatures
5. Collecting signatures from multiple signers and submitting

## Prerequisites

- Node.js 22+
- npm

## Setup

```bash
# From this directory
npm install
```

## Dependencies

- `@stellar/stellar-sdk` — Stellar SDK for building and submitting transactions
- `dotenv` — (optional) load environment variables

## Configuration

The example uses the Stellar **testnet** by default. You can override the network via environment variables:

```bash
export HORIZON_URL=https://horizon-testnet.stellar.org
export NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

## Running

```bash
npm start
```

The script will:

1. Generate and fund a new source account on testnet (via Friendbot).
2. Generate two additional signer keypairs.
3. Configure the account with:
   - Master key weight `1`
   - Two additional signers with weight `1` each
   - Low/medium/high thresholds set so that **2 signatures** are required for medium and high operations.
4. Build a payment transaction that requires the medium threshold.
5. Sign with two of the three signers and submit.

## Source Files

- `index.js` — main runnable example
- `package.json` — dependencies and scripts

## How It Works

### 1. Create and fund an account

```js
const sourceKeypair = StellarSdk.Keypair.random();
await fetch(`https://friendbot.stellar.org?addr=${sourceKeypair.publicKey()}`);
```

### 2. Add signers and set thresholds

```js
const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
  fee: StellarSdk.BASE_FEE,
  networkPassphrase: StellarSdk.Networks.TESTNET,
})
  .addOperation(
    StellarSdk.Operation.setOptions({
      signer: {
        ed25519PublicKey: signerA.publicKey(),
        weight: 1,
      },
    })
  )
  .addOperation(
    StellarSdk.Operation.setOptions({
      signer: {
        ed25519PublicKey: signerB.publicKey(),
        weight: 1,
      },
    })
  )
  .addOperation(
    StellarSdk.Operation.setOptions({
      masterWeight: 1,
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 2,
    })
  )
  .setTimeout(30)
  .build();
```

### 3. Build a transaction requiring multiple signatures

```js
const paymentTx = new StellarSdk.TransactionBuilder(updatedAccount, {
  fee: StellarSdk.BASE_FEE,
  networkPassphrase: StellarSdk.Networks.TESTNET,
})
  .addOperation(
    StellarSdk.Operation.payment({
      destination: destination.publicKey(),
      asset: StellarSdk.Asset.native(),
      amount: "10",
    })
  )
  .setTimeout(30)
  .build();
```

### 4. Collect signatures and submit

```js
paymentTx.sign(sourceKeypair, signerA);
await server.submitTransaction(paymentTx);
```

## Notes

- Multi-sig thresholds are evaluated against the **sum of weights** of all signatures on the transaction.
- The master key weight can be set to `0` to fully disable the master key (be careful — you can lock yourself out).
- Always test multi-sig configurations on testnet before applying to mainnet.
- Keep signer secret keys secure; never commit them to source control.

## Cleanup

Testnet accounts are ephemeral. No cleanup is required, but you can let the account be garbage-collected by the network over time.