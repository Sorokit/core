# Recipe: Contract Deployment with Validation

## Problem

Deploying a Soroban contract involves two on-chain operations: uploading the WASM binary and instantiating the contract. Both can fail silently or expensively if configuration is wrong. You need to:

1. Validate deployment configuration before spending gas.
2. Upload the WASM and get its hash.
3. Instantiate the contract and confirm its address.
4. Verify the deployment by reading a contract method.

## Solution

Use `validateDeployConfig` for pre-flight checks, then `buildContractDeploy` + `client.soroban.execute` for the deployment pipeline. Validation catches bad URLs, invalid addresses, and oversized WASM before any RPC call is made.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  validateDeployConfig,
  collectDeployConfigIssues,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { buildContractDeploy } from "sorokit-core";
import { readFileSync } from "fs";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, rpcUrl, networkPassphrase } = network.data;

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);
const { publicKey: deployer } = conn.data;

// ── 2. Pre-flight validation ──────────────────────────────────────────────────
//
// Run this check in CI scripts before even trying to deploy.
// It fails fast with a human-readable message for each problem.

const deployConfigCheck = validateDeployConfig({
  rpcUrl,
  horizonUrl,
  networkConfig: network.data,
  deployer,
});

if (deployConfigCheck.status === "error") {
  console.error("Deployment configuration is invalid:");
  console.error(deployConfigCheck.error.message);
  // The message includes: field, reason, and hint for each issue
  process.exit(1);
}

console.log("✓ Deployment config is valid");

// For granular reporting (e.g., in a CI step summary):
const issues = collectDeployConfigIssues({
  rpcUrl,
  horizonUrl,
  networkConfig: network.data,
  deployer,
});

if (issues.length > 0) {
  console.warn("Configuration issues found:");
  for (const issue of issues) {
    console.warn(`  [${issue.field}] ${issue.reason}`);
    console.warn(`  Fix: ${issue.hint}`);
  }
}

// ── 3. Load the contract WASM ─────────────────────────────────────────────────

const CONTRACT_WASM_PATH = "./target/wasm32-unknown-unknown/release/my_contract.wasm";

let contractCode: Buffer;
try {
  contractCode = readFileSync(CONTRACT_WASM_PATH);
} catch {
  console.error("WASM file not found:", CONTRACT_WASM_PATH);
  console.error("Run: cargo build --target wasm32-unknown-unknown --release");
  process.exit(1);
}

console.log(`Contract WASM: ${(contractCode.length / 1024).toFixed(1)} KB`);

if (contractCode.length > 256 * 1024) {
  console.error("WASM exceeds 256 KB limit. Optimise with: wasm-opt -Os");
  process.exit(1);
}

// ── 4. Build the deployment transaction ──────────────────────────────────────

const deployTx = await buildContractDeploy(
  contractCode,
  deployer,
  {
    rpcUrl,
    horizonUrl,
    networkConfig: network.data,
  },
);

if (deployTx.status === "error") {
  console.error("Deploy build failed:", deployTx.error.code, deployTx.error.message);
  process.exit(1);
}

console.log(`Deployment transaction built. Estimated fee: ${deployTx.data.fee} stroops`);
console.log("Assembled XDR length:", deployTx.data.transactionXdr.length, "chars");

// ── 5. Sign the deployment ────────────────────────────────────────────────────

const signedDeploy = await client.wallet.signTransaction(adapter, {
  transactionXdr: deployTx.data.transactionXdr,
  networkPassphrase,
});

if (signedDeploy.status === "error") {
  console.error("Sign failed:", signedDeploy.error.message);
  process.exit(1);
}

// ── 6. Execute the deployment ─────────────────────────────────────────────────

const executeResult = await client.soroban.execute(signedDeploy.data);

if (executeResult.status === "error") {
  console.error("Deploy execution failed:", executeResult.error.code);
  console.error(executeResult.error.message);

  if (executeResult.error.code === "NETWORK_ERROR") {
    console.error("Network issue — the transaction may still be pending. Check:");
    console.error(`  soroban tx status <hash> --rpc-url ${rpcUrl}`);
  }
  process.exit(1);
}

const txHash = executeResult.data;
console.log("\n✓ Contract deployed! Tx hash:", txHash);

// ── 7. Retrieve the contract ID ───────────────────────────────────────────────
//
// The contract address is deterministic from the deployer key and the WASM hash.
// Query Horizon events to find the newly created contract ID.

import { queryContractEvents, decodeContractEvent } from "sorokit-core";

const events = await queryContractEvents(
  undefined,       // no specific contract — scan all
  undefined,       // no event filter
  { horizonUrl },
);

// In a real app, use the tx hash to look up the specific deploy event:
console.log("Deployment events (last 10):", events.slice(-10).map(
  (e) => decodeContractEvent(e)?.type,
));

// ── 8. Verify the contract works ──────────────────────────────────────────────

const CONTRACT_ID = "CABC…DEPLOYED"; // replace with actual contract ID from events

const verifyResult = await client.soroban.read({
  contractId: CONTRACT_ID,
  method:     "version",  // simple read-only method
  args:       [],
});

if (verifyResult.status === "ok") {
  console.log("Contract version:", verifyResult.data.value);
  console.log("✓ Deployment verified");
} else {
  console.warn("Could not verify contract:", verifyResult.error.message);
}
```

## CI deployment script

Put the validation step in your CI pipeline to catch configuration errors before spending gas:

```ts
// scripts/validate-deploy.ts
import {
  validateDeployConfig,
  collectDeployConfigIssues,
  resolveNetwork,
} from "sorokit-core";

const network = resolveNetwork(process.env.STELLAR_NETWORK as "testnet" | "mainnet" ?? "testnet");
if (network.status === "error") process.exit(1);

const issues = collectDeployConfigIssues({
  rpcUrl:        process.env.SOROBAN_RPC_URL ?? network.data.rpcUrl,
  horizonUrl:    process.env.HORIZON_URL ?? network.data.horizonUrl,
  networkConfig: network.data,
  deployer:      process.env.DEPLOYER_PUBLIC_KEY ?? "",
});

if (issues.length === 0) {
  console.log("✓ Deploy config valid");
  process.exit(0);
}

for (const issue of issues) {
  console.error(`✗ ${issue.field}: ${issue.reason}`);
  console.error(`  ${issue.hint}`);
}

process.exit(1);
```

Add to `package.json`:
```json
{
  "scripts": {
    "predeploy": "tsx scripts/validate-deploy.ts",
    "deploy":    "tsx scripts/deploy.ts"
  }
}
```

## WASM size optimisation

```bash
# Install wasm-opt (part of binaryen)
cargo install wasm-opt

# Optimise for size
wasm-opt -Os \
  target/wasm32-unknown-unknown/release/my_contract.wasm \
  -o target/wasm32-unknown-unknown/release/my_contract_opt.wasm

# Check size
wc -c target/wasm32-unknown-unknown/release/my_contract_opt.wasm
```

## Testing tips

```ts
import { validateDeployConfig, collectDeployConfigIssues } from "sorokit-core";

// Missing rpcUrl
const noRpc = validateDeployConfig({
  rpcUrl:        "",
  horizonUrl:    "https://horizon-testnet.stellar.org",
  networkConfig: { ...testnetConfig },
  deployer:      "GABC…",
});
expect(noRpc.status).toBe("error");
expect(noRpc.error.message).toMatch("rpcUrl");

// Invalid deployer key
const badKey = validateDeployConfig({
  rpcUrl:        "https://soroban-testnet.stellar.org",
  horizonUrl:    "https://horizon-testnet.stellar.org",
  networkConfig: { ...testnetConfig },
  deployer:      "not-a-valid-key",
});
expect(badKey.status).toBe("error");

// Both issues present — collectDeployConfigIssues returns both
const issues = collectDeployConfigIssues({
  rpcUrl:        "",
  horizonUrl:    "",
  networkConfig: { ...testnetConfig },
  deployer:      "bad",
});
expect(issues.length).toBeGreaterThanOrEqual(2);
```

## See also

- [Soroban contract invoke](./04-soroban-invoke.md) — call the contract after deployment
- [Soroban documentation](https://developers.stellar.org/docs/smart-contracts/getting-started/deploy-to-testnet) — official deployment guide
