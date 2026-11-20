# Create Account and Send Payment

This example demonstrates how to create a new Stellar account on testnet and send a payment to it using the SDK.

## What You'll Learn

- Generate a new keypair
- Fund a new account using Friendbot (testnet only)
- Build, sign, and submit a payment transaction
- Check account balances

## Prerequisites

- Node.js 18+ (Node 22 recommended)
- npm

## Dependencies

```bash
npm install @stellar/stellar-sdk
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. (Optional) Copy the environment template and adjust if needed:

   ```bash
   cp .env.example .env
   ```

   No secrets are required — this example generates fresh keypairs on every run and uses testnet Friendbot for funding.

## Running the Example

```bash
npm start
```

Or run the script directly:

```bash
node index.js
```

## Expected Output

```
Generated source account: G...
Generated destination account: G...
Funding source account via Friendbot...
Funding destination account via Friendbot...
Source balance before: 10000.0000000 XLM
Sending 10 XLM from source to destination...
Transaction hash: ...
Source balance after: 9989.9999900 XLM
Destination balance: 10010.0000000 XLM
```

## How It Works

1. **Generate keypairs** — `Keypair.random()` creates a new public/private keypair for both the source and destination accounts.
2. **Fund accounts** — On testnet, `Server.friendbot(publicKey)` funds a new account with 10,000 XLM so it can pay transaction fees and meet the minimum balance.
3. **Build payment** — A `TransactionBuilder` constructs a `Payment` operation transferring XLM from source to destination.
4. **Sign and submit** — The transaction is signed with the source secret key and submitted to Horizon.
5. **Verify** — Balances are fetched before and after to confirm the payment succeeded.

## Files

| File | Description |
| --- | --- |
| `index.js` | Runnable example script |
| `package.json` | Dependencies and `start` script |
| `.env.example` | Optional environment configuration |

## Notes

- This example only works on **testnet**. Never use Friendbot or testnet keys on mainnet.
- Keypairs are generated in memory and discarded when the script exits. Do not reuse them for anything real.
- If Friendbot is rate-limited, wait a minute and try again.

## Source Code

### `index.js`

```js
'use strict';

const {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
} = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';
const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT || '10';

const server = new Horizon.Server(HORIZON_URL);

async function fundAccount(publicKey) {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Friendbot failed for ${publicKey}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function getBalance(publicKey) {
  const account = await server.loadAccount(publicKey);
  const native = account.balances.find((b) => b.asset_type === 'native');
  return native ? native.balance : '0';
}

async function main() {
  // 1. Generate keypairs
  const source = Keypair.random();
  const destination = Keypair.random();
  console.log('Generated source account:', source.publicKey());
  console.log('Generated destination account:', destination.publicKey());

  // 2. Fund both accounts on testnet
  console.log('Funding source account via Friendbot...');
  await fundAccount(source.publicKey());
  console.log('Funding destination account via Friendbot...');
  await fundAccount(destination.publicKey());

  // 3. Check balances before
  const before = await getBalance(source.publicKey());
  console.log('Source balance before:', before, 'XLM');

  // 4. Build the payment transaction
  const sourceAccount = await server.loadAccount(source.publicKey());
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: PAYMENT_AMOUNT,
      })
    )
    .setTimeout(30)
    .build();

  // 5. Sign and submit
  transaction.sign(source);
  console.log(`Sending ${PAYMENT_AMOUNT} XLM from source to destination...`);
  const result = await server.submitTransaction(transaction);
  console.log('Transaction hash:', result.hash);

  // 6. Verify balances after
  const after = await getBalance(source.publicKey());
  const destBalance = await getBalance(destination.publicKey());
  console.log('Source balance after:', after, 'XLM');
  console.log('Destination balance:', destBalance, 'XLM');
}

main().catch((err) => {
  console.error('Example failed:', err.message || err);
  if (err.response && err.response.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
```

### `package.json`

```json
{
  "name": "create-account-payment",
  "version": "1.0.0",
  "private": true,
  "description": "Create a Stellar account on testnet and send a payment",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@stellar/stellar-sdk": "^12.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### `.env.example`

```bash
# Optional overrides — defaults target Stellar testnet
HORIZON_URL=https://horizon-testnet.stellar.org
FRIENDBOT_URL=https://friendbot.stellar.org
PAYMENT_AMOUNT=10
```

## Troubleshooting

- **`fetch is not defined`** — Upgrade to Node 18+ (Node 22 recommended); `fetch` is built in.
- **`op_underfunded`** — The source account lacks funds. Ensure Friendbot funding succeeded.
- **`tx_bad_seq`** — A previous transaction already consumed the sequence number. Re-run the script to generate fresh accounts.
- **Friendbot 429** — Rate limited. Wait a minute and retry.

## Next Steps

- Try sending a custom asset instead of XLM.
- Add a memo to the payment.
- Explore the other examples in this directory (offers, Soroban, multi-sig, wallet signing).