# Recipe: Multi-Sig Approval Workflow

## Problem

You need N-of-M approval before a payment or other operation is submitted. For example, a corporate treasury requires 2-of-3 signers to authorise any transfer over 10,000 USDC. Each signer is on a different machine or service. They cannot all be online at the same time.

## Solution

Use `buildMultiSigEnvelope`, `collectSignature`, `validateMultiSigThreshold`, and `submitTransaction` from `sorokit-core`. The envelope is built once, passed (as XDR) to each signer independently, and merged after enough signatures are collected.

The signer list and threshold live **on the envelope** — they do not require an on-chain `SetOptions` change for this workflow (though production deployments should also set account thresholds on-chain so Horizon enforces the policy).

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  buildMultiSigEnvelope,
  collectSignature,
  validateMultiSigThreshold,
  submitTransaction,
  resolveNetwork,
} from "sorokit-core";
import { buildPaymentTransaction } from "sorokit-core/transaction";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, networkPassphrase } = network.data;

// ── 2. Build the unsigned transaction ────────────────────────────────────────

const SOURCE_KEY  = "GABC…SOURCE";   // treasury account
const DESTINATION = "GDST…RECIP";
const AMOUNT      = "10500";          // USDC

const built = await buildPaymentTransaction(horizonUrl, network.data, SOURCE_KEY, {
  destination: DESTINATION,
  amount: AMOUNT,
  assetCode: "USDC",
  assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
});

if (built.status === "error") {
  console.error("Build failed:", built.error.message);
  process.exit(1);
}

const unsignedXdr = built.data;

// ── 3. Create a multi-sig envelope (2-of-3) ──────────────────────────────────

const SIGNER_A = "GAAA…SIGNER_A"; // weight 1
const SIGNER_B = "GBBB…SIGNER_B"; // weight 1
const SIGNER_C = "GCCC…SIGNER_C"; // weight 1

const envelopeResult = buildMultiSigEnvelope(unsignedXdr, networkPassphrase, {
  signers: [
    { publicKey: SIGNER_A, weight: 1 },
    { publicKey: SIGNER_B, weight: 1 },
    { publicKey: SIGNER_C, weight: 1 },
  ],
  threshold: 2, // any 2 of the 3 must sign
});

if (envelopeResult.status === "error") {
  console.error("Envelope error:", envelopeResult.error.message);
  process.exit(1);
}

let envelope = envelopeResult.data;

console.log("Envelope XDR (share with signers):", envelope.envelopeXdr);

// ── 4. Collect signatures independently ──────────────────────────────────────
//
// In practice each signer calls collectSignature on their own machine.
// Here we show the sequential case for illustration.

const clientA = createSorokitClient({ network: "testnet" });
if (clientA.status === "error") throw new Error(clientA.error.message);
const adapterA = new FreighterAdapter(swkInstanceForA);

async function signWithA(xdr: string): Promise<import("sorokit-core").SorokitResult<string>> {
  return clientA.data.wallet.signTransaction(adapterA, { transactionXdr: xdr, networkPassphrase });
}

const afterA = await collectSignature(envelope, SIGNER_A, signWithA);
if (afterA.status === "error") {
  console.error("Signer A failed:", afterA.error.message);
  process.exit(1);
}
envelope = afterA.data;
console.log(`Progress: ${envelope.collectedWeight}/${envelope.threshold} weight collected`);

const clientB = createSorokitClient({ network: "testnet" });
if (clientB.status === "error") throw new Error(clientB.error.message);
const adapterB = new FreighterAdapter(swkInstanceForB);

async function signWithB(xdr: string): Promise<import("sorokit-core").SorokitResult<string>> {
  return clientB.data.wallet.signTransaction(adapterB, { transactionXdr: xdr, networkPassphrase });
}

const afterB = await collectSignature(envelope, SIGNER_B, signWithB);
if (afterB.status === "error") {
  console.error("Signer B failed:", afterB.error.message);
  process.exit(1);
}
envelope = afterB.data;

// ── 5. Validate threshold and submit ─────────────────────────────────────────

const readyXdr = validateMultiSigThreshold(envelope);
if (readyXdr.status === "error") {
  // Not enough signatures yet — share envelope.envelopeXdr with another signer
  console.warn("Threshold not met:", readyXdr.error.message);
  process.exit(1);
}

const submitted = await submitTransaction(horizonUrl, network.data, readyXdr.data);
if (submitted.status === "error") {
  console.error("Submit failed:", submitted.error.code, submitted.error.message);
  process.exit(1);
}

console.log("Transaction confirmed:", submitted.data.hash);
```

## Handling the async / distributed case

When signers are on different machines or services, pass the XDR string over your own transport (API, queue, email). Each signer:

1. Receives the current `envelopeXdr` string.
2. Calls `collectSignature(envelope, myKey, mySignFn)` locally.
3. Returns the updated `envelopeXdr` to the coordinator.
4. The coordinator calls `validateMultiSigThreshold` once enough weight is collected.

The XDR is immutable between steps — each `collectSignature` call returns a **new** envelope object. Never mutate the original.

## Setting account thresholds on-chain

The envelope-level threshold is enforced only by your application. To have Horizon enforce 2-of-3 at the protocol level, set thresholds on the source account:

```ts
import { buildSetOptionsTransaction } from "sorokit-core/transaction";

const setOpts = await buildSetOptionsTransaction(horizonUrl, network.data, SOURCE_KEY, {
  lowThreshold: 2,
  medThreshold: 2,
  highThreshold: 2,
  signer: { ed25519PublicKey: SIGNER_A, weight: 1 },
});
```

Repeat the call for SIGNER_B and SIGNER_C, then submit each. After that, Horizon will reject any payment that doesn't carry at least 2 valid signatures.

## Testing tips

- Use `createMockClient()` from `sorokit-core/testing` to stub `wallet.signTransaction` in unit tests.
- Test the error paths: signer not in list, signer already signed, threshold not met.
- For integration tests, create three test accounts on Testnet Friendbot and rotate their keys to share the source account.

```ts
import { createMockClient, createMockWalletAdapter } from "sorokit-core/testing";

const client = createMockClient();
const adapter = createMockWalletAdapter();

// Stub a successful sign
client.wallet.signTransaction.mockResolvedValueOnce({ status: "ok", data: "SIGNED_XDR", error: null });

// Verify threshold-not-met error
const badEnvelope = buildMultiSigEnvelope("VALID_XDR", passphrase, {
  signers: [{ publicKey: "GAAA…", weight: 1 }],
  threshold: 2, // impossible to meet with a single weight-1 signer
});
expect(badEnvelope.status).toBe("error");
```

## See also

- [Account key rotation](./08-key-rotation.md) — change the signing keys themselves
- [Workflows reference](../workflows.md#multisignature-signing) — lifecycle diagram

## Edge Cases
- **Threshold Not Met:** If a transaction is submitted before enough signatures are gathered, the network will reject it with `txBAD_AUTH_EXTRA` or similar authentication errors.
- **Signer Weight Changes:** If the account's signers or weights change while gathering signatures, previously valid signatures might become invalid or insufficient.
- **Sequence Number Collision:** If another transaction is submitted for the account while gathering signatures, the sequence number will increment, invalidating the multi-sig transaction.
