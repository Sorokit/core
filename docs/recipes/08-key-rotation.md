# Recipe: Account Key Rotation

## Problem

A signing key has been compromised or needs to be rotated as part of a security policy. You need to:

1. Add a new key to the account with appropriate weight.
2. Remove (zero out) the old key.
3. Verify the rotation succeeded.
4. Optionally update account thresholds.

This must be done without locking yourself out — the new key must be in place and confirmed **before** the old key is removed.

## Solution

Use `rotateAccountKey` from `sorokit-core/account`. It builds a `SetOptions` transaction that adds the new key and removes the old key atomically. Both changes happen in the same transaction, so there is no window where neither key is valid.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  rotateAccountKey,
  recoverAccountKeys,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, networkPassphrase } = network.data;

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

// Connect with the CURRENT (still-valid) key
const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);
const { publicKey } = conn.data;

const OLD_KEY = publicKey;     // the key being replaced
const NEW_KEY = "GNEW…NEWKEY"; // pre-generated replacement key

// ── 2. Build the key-rotation transaction ────────────────────────────────────

const rotationTx = await rotateAccountKey(
  horizonUrl,
  network.data,
  {
    account:      OLD_KEY,
    oldKey:       OLD_KEY,
    newKey:       NEW_KEY,
    newKeyWeight: 1,    // same weight as existing key
  },
);

if (rotationTx.status === "error") {
  console.error("Key rotation build failed:", rotationTx.error.message);
  process.exit(1);
}

console.log("Rotation transaction built. XDR length:", rotationTx.data.length);

// ── 3. Sign with the OLD key (still valid until submission confirms) ──────────

const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: rotationTx.data,
  networkPassphrase,
});

if (signed.status === "error") {
  console.error("Sign failed:", signed.error.message);
  process.exit(1);
}

// ── 4. Submit ─────────────────────────────────────────────────────────────────

const submitResult = await submitTransaction(horizonUrl, network.data, signed.data);

if (submitResult.status === "error") {
  console.error("Rotation failed:", submitResult.error.code, submitResult.error.message);
  process.exit(1);
}

console.log("Key rotation confirmed! Tx hash:", submitResult.data.hash);

// ── 5. Verify the new key is active ──────────────────────────────────────────

const accountInfo = await client.account.get(NEW_KEY);

if (accountInfo.status === "error") {
  console.error("Could not verify new key:", accountInfo.error.message);
  process.exit(1);
}

const signers = accountInfo.data.signers ?? [];
const newKeyEntry = signers.find((s) => s.key === NEW_KEY);
const oldKeyEntry = signers.find((s) => s.key === OLD_KEY);

console.log("New key weight:", newKeyEntry?.weight ?? "not found");
console.log("Old key weight:", oldKeyEntry?.weight ?? "removed (weight 0 or gone)");

if (!newKeyEntry || newKeyEntry.weight < 1) {
  console.error("WARNING: New key not found with valid weight — manual intervention required.");
}
```

## Rotating to a multi-sig configuration

When upgrading a single-key account to require multiple signers, use `recoverAccountKeys` to install several new keys in one transaction:

```ts
import { recoverAccountKeys } from "sorokit-core";

// Install three new signers and remove the old single key
const multiSigTx = await recoverAccountKeys(
  horizonUrl,
  network.data,
  {
    account:         OLD_KEY,       // account being updated
    recoveryKey:     OLD_KEY,       // still-valid key authorising the change
    compromisedKeys: [OLD_KEY],     // remove the old single key
    newKeys: [
      { key: "GKEY1…", weight: 1 },
      { key: "GKEY2…", weight: 1 },
      { key: "GKEY3…", weight: 1 },
    ],
    lowThreshold:  2,
    medThreshold:  2,
    highThreshold: 2,
    masterWeight:  0, // revoke master key
  },
);

if (multiSigTx.status === "error") {
  console.error("Build failed:", multiSigTx.error.message);
  process.exit(1);
}

// Sign with the current key before it loses authority
const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: multiSigTx.data,
  networkPassphrase,
});

if (signed.status === "error") {
  console.error("Sign failed:", signed.error.message);
  process.exit(1);
}

const result = await submitTransaction(horizonUrl, network.data, signed.data);
console.log("Multi-sig upgrade confirmed:", result.data?.hash);
```

## Safety checklist

Before submitting a key rotation:

- [ ] The new key exists and you have access to its private key.
- [ ] The transaction is signed by a key that currently meets the account's `high_threshold`.
- [ ] The new key weight is sufficient for post-rotation operations.
- [ ] You have a backup (account recovery contacts) in case the new key is also lost.

## Auditing key changes

`recordKeyRotation` and `getKeyRotationHistory` maintain an in-process log:

```ts
import { recordKeyRotation, getKeyRotationHistory } from "sorokit-core";

// Record the rotation after confirmation
recordKeyRotation({
  account:    OLD_KEY,
  oldKey:     OLD_KEY,
  newKey:     NEW_KEY,
  timestamp:  Date.now(),
  txHash:     submitResult.data.hash,
  rotatedBy:  OLD_KEY,
});

// Retrieve the audit log
const history = getKeyRotationHistory(OLD_KEY);
console.log("Key rotation history:", history);
```

## Testing tips

```ts
import { rotateAccountKey } from "sorokit-core";

// Missing new key — should fail validation
const badRotation = await rotateAccountKey(horizonUrl, network.data, {
  account:  "GAAA…",
  oldKey:   "GAAA…",
  newKey:   "not-a-valid-key",
  newKeyWeight: 1,
});
expect(badRotation.status).toBe("error");
expect(badRotation.error.message).toMatch("valid Stellar public key");

// Same old and new key — should fail
const sameKey = await rotateAccountKey(horizonUrl, network.data, {
  account:  "GAAA…",
  oldKey:   "GAAA…",
  newKey:   "GAAA…",
  newKeyWeight: 1,
});
expect(sameKey.status).toBe("error");
```

## See also

- [Account recovery workflow](./10-account-recovery.md) — recover when the current key is lost
- [Multi-sig approval workflow](./01-multisig-approval.md) — require multiple signers after rotation
