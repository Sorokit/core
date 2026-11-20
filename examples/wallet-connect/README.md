# Wallet Connect Example

Connect a Stellar wallet and sign a transaction on testnet.

This example demonstrates how to:
1. Connect to a Stellar wallet (e.g. Freighter, Albedo, or a local keypair)
2. Build a payment transaction on testnet
3. Sign the transaction with the connected wallet
4. Submit the signed transaction to the network

## Prerequisites

- Node.js 22+
- npm
- A funded testnet account (see [setup](#setup))

## Dependencies

```bash
npm install @stellar/stellar-sdk
```

If you are using a browser wallet like Freighter, you will also need the wallet extension installed in your browser.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Fund a testnet account using [Friendbot](https://friendbot.stellar.org):

   ```bash
   curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
   ```

   Or generate and fund a new keypair with the helper script:

   ```bash
   node fund-account.js
   ```

3. Copy the example environment file and fill in your values:

   ```bash
   cp .env.example .env
   ```

   ```
   HORIZON_URL=https://horizon-testnet.stellar.org
   NETWORK_PASSPHRASE=Test SDF Network ; September 2015
   SOURCE_SECRET=S...
   DESTINATION_PUBLIC=G...
   ```

## Running the example

### Option A: Local keypair (Node.js)

```bash
node sign-with-keypair.js
```

This script:
- Loads the source account from `SOURCE_SECRET`
- Builds a payment transaction
- Signs it with the local keypair
- Submits it to testnet and prints the result

### Option B: Browser wallet (Freighter)

Open `index.html` in a browser with the Freighter extension installed, or serve it locally:

```bash
npx serve .
```

Then click **Connect Wallet** and **Sign Transaction**. The page will:
- Request access to the wallet via `window.freighterApi`
- Build a payment transaction
- Ask the wallet to sign it
- Submit the signed transaction to testnet

## Files

| File | Description |
| --- | --- |
| `sign-with-keypair.js` | Sign and submit a transaction using a local keypair |
| `fund-account.js` | Generate and fund a new testnet keypair via Friendbot |
| `index.html` | Browser example using the Freighter wallet |
| `.env.example` | Example environment variables |

## Notes

- Never commit real secret keys. `.env` is gitignored.
- Testnet funds have no real value.
- If you use a browser wallet, make sure it is set to **Testnet** in its settings.

## Troubleshooting

- **`op_underfunded`**: Fund your account with Friendbot.
- **`tx_bad_seq`**: Reload the source account before building the transaction.
- **Wallet not detected**: Install the Freighter extension and refresh the page.
- **Network mismatch**: Ensure the wallet and SDK both target testnet (`Test SDF Network ; September 2015`).

## Learn more

- [Stellar Docs: Transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions)
- [Freighter API](https://docs.freighter.app/)
- [Horizon API](https://developers.stellar.org/docs/data/apis/horizon)