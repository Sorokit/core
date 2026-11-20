# Deploy and Invoke a Soroban Contract

This example demonstrates how to deploy a Soroban smart contract to the Stellar testnet and invoke one of its functions using the Stellar SDK.

## What You'll Learn

- How to build and upload a Soroban contract WASM to the network
- How to deploy a contract instance from the uploaded WASM
- How to invoke a contract function and read the result
- How to handle Soroban transaction submission and result parsing

## Prerequisites

- **Node.js 22+** (matches the SDK CI environment)
- **npm** (comes with Node.js)
- A funded testnet account. You can create and fund one at [Stellar Laboratory – Friendbot](https://laboratory.stellar.org/#account-creator?network=test) or via the Friendbot API:

  ```bash
  curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
  ```

- The Soroban CLI is **not** required — this example uses the SDK directly. However, if you want to build your own contract, you'll need the [Rust toolchain](https://www.rust-lang.org/tools/install) and the `soroban` CLI.

## Dependencies

```json
{
  "dependencies": {
    "@stellar/stellar-sdk": "^13.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

Install them with:

```bash
npm install
```

> **Note:** If you hit peer dependency conflicts, use `npm install --legacy-peer-deps --no-fund` (the same flags used in the SDK's CI).

## Setup

1. **Clone the SDK repository** (this example lives inside it):

   ```bash
   git clone https://github.com/stellar/js-stellar-sdk.git
   cd js-stellar-sdk/examples/soroban-deploy-invoke
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure your environment.** Copy the sample env file and fill in your keys:

   ```bash
   cp .env.example .env
   ```

   | Variable | Description |
   | --- | --- |
   | `SOROBAN_SECRET_KEY` | Secret key (`S...`) of a funded testnet account. **Never commit this.** |
   | `SOROBAN_RPC_URL` | Soroban RPC endpoint. Defaults to `https://soroban-testnet.stellar.org`. |
   | `NETWORK_PASSPHRASE` | Defaults to `Test SDF Network ; September 2015`. |
   | `CONTRACT_WASM_PATH` | Path to the compiled `.wasm` contract. Defaults to `./contracts/hello_world.wasm`. |

4. **Provide a contract WASM.** This example ships with a tiny `hello_world` contract under `contracts/`. If you want to build your own, see [Building your own contract](#building-your-own-contract) below.

## Running the Example

```bash
npm run start
```

Expected output (abbreviated):

```
Uploading WASM...
WASM uploaded. Hash: 8f3c...e21a
Deploying contract...
Contract deployed at: CABC...XYZ
Invoking hello(to: "World")...
Result: ["Hello", "World"]
```

## Files

| File | Purpose |
| --- | --- |
| `src/deploy.ts` | Uploads the WASM and deploys a contract instance. |
| `src/invoke.ts` | Invokes the `hello` function on a deployed contract. |
| `src/config.ts` | Loads environment variables and builds the RPC server + keypair. |
| `src/util.ts` | Helpers for polling transaction status and parsing results. |
| `contracts/hello_world.wasm` | Pre-built sample contract. |
| `.env.example` | Template for required environment variables. |

## How It Works

### 1. Upload the WASM

Soroban contracts are deployed in two steps. First, the compiled WASM bytecode is uploaded to the network, which returns a **WASM hash**:

```ts
import { Operation, TransactionBuilder, hash } from "@stellar/stellar-sdk";

const wasm = await fs.readFile(wasmPath);
const uploadOp = Operation.uploadContractWasm({ wasm });
// ... build, simulate, sign, and submit the transaction
```

### 2. Deploy a contract instance

Using the WASM hash, you create a contract instance. The contract ID is derived deterministically from the source account and a salt:

```ts
const deployOp = Operation.createCustomContract({
  address: Address.fromString(publicKey),
  wasmHash,
  salt,
});
```

### 3. Invoke a function

Once deployed, call any exported function by name:

```ts
const invokeOp = Operation.invokeContractFunction({
  contract: contractId,
  function: "hello",
  args: [nativeToScVal("World", { type: "string" })],
});
```

### 4. Simulate, sign, and submit

Soroban transactions must be **simulated** first to compute resource fees and footprint. The SDK's `rpc.Server.prepareTransaction` handles this for you:

```ts
const prepared = await server.prepareTransaction(tx);
prepared.sign(keypair);
const response = await server.sendTransaction(prepared);
```

Then poll `server.getTransaction(hash)` until the status is `SUCCESS` or `FAILED`.

## Building Your Own Contract

If you want to modify the sample contract:

```bash
# Install the Soroban CLI
cargo install --locked soroban-cli

# Build the contract to WASM
cd contracts/hello_world
soroban contract build

# Copy the artifact into place
cp target/wasm32-unknown-unknown/release/hello_world.wasm ../../contracts/hello_world.wasm
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Account not found` | Fund your account with Friendbot (see Prerequisites). |
| `tx_insufficient_fee` | Re-run `prepareTransaction`; fees change with network load. |
| `HostError: ...` | The contract trapped. Check the function name and argument types. |
| `ECONNREFUSED` | Verify `SOROBAN_RPC_URL` is reachable. |

## Related Examples

- [Create account and send payment](../create-account-send-payment/)
- [Create and cancel offers](../create-cancel-offers/)
- [Multi-sig account setup](../multisig-account/)
- [Connect wallet and sign transaction](../wallet-connect-sign/)

## License

Apache-2.0 — see the [repository LICENSE](../../LICENSE).