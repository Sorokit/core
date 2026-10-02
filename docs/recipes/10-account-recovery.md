# Recipe: Account Recovery Workflow

## Problem

A user has lost their signing key, or a key has been compromised and must be replaced. A set of **recovery contacts** (guardians) was set up in advance. You need to:

1. Register recovery contacts (done at setup time).
2. Initiate a recovery request.
3. Collect guardian approvals (N-of-M).
4. Execute the recovery after a mandatory delay.

## Solution

Use the `recoveryWorkflow` functions from `sorokit-core`:
- `registerRecoveryContacts` — configure guardians.
- `initiateRecovery` — start a recovery request.
- `approveRecovery` — guardian approves.
- `isRecoveryReady` — check if enough approvals and delay has passed.
- `executeRecovery` — build the key-replacement transaction.

## Code

```ts
import {
  registerRecoveryContacts,
  initiateRecovery,
  approveRecovery,
  cancelRecovery,
  isRecoveryReady,
  executeRecovery,
  recoverAccountKeys,
  resolveNetwork,
  submitTransaction,
  createSorokitClient,
  FreighterAdapter,
} from "sorokit-core";

// ── 1. Setup (done once at account creation) ──────────────────────────────────

const GUARDIAN_A = "GAAA…GUARDIAN_A";
const GUARDIAN_B = "GBBB…GUARDIAN_B";
const GUARDIAN_C = "GCCC…GUARDIAN_C";
const ACCOUNT    = "GACCOUNT…"; // account being protected

// Register 3 guardians; 2 approvals required
const configResult = registerRecoveryContacts(
  [
    { address: GUARDIAN_A, permissions: ["approve", "cancel"] },
    { address: GUARDIAN_B, permissions: ["initiate", "approve", "cancel"] },
    { address: GUARDIAN_C, permissions: ["approve"] },
  ],
  2,      // approvalThreshold — 2 guardians must approve
  86400,  // delaySeconds — 24-hour mandatory waiting period
);

if (configResult.status === "error") {
  console.error("Recovery config invalid:", configResult.error.message);
  process.exit(1);
}

const recoveryConfig = configResult.data;
console.log(
  `Recovery configured: ${recoveryConfig.contacts.length} guardians,` +
  ` threshold ${recoveryConfig.approvalThreshold},` +
  ` delay ${recoveryConfig.delaySeconds / 3600}h`,
);

// ── 2. Initiate a recovery request ───────────────────────────────────────────
//
// Typically triggered by the user who lost access, or a guardian.

const NEW_REPLACEMENT_KEY = "GNEW…NEWKEY";

const initiateResult = initiateRecovery(
  recoveryConfig,
  GUARDIAN_B,           // GUARDIAN_B has "initiate" permission
  ACCOUNT,
  [{ key: NEW_REPLACEMENT_KEY, weight: 1 }], // replacement signers
  ["GLOST…OLDKEY"],                          // compromised keys to remove
);

if (initiateResult.status === "error") {
  console.error("Initiate failed:", initiateResult.error.message);
  process.exit(1);
}

const request = initiateResult.data;

console.log("\nRecovery request created:");
console.log("  Request ID:", request.id);
console.log("  Execute after:", new Date(request.executeAfter * 1000).toISOString());
console.log("  Expires at:  ", new Date(request.expiresAt * 1000).toISOString());

// ── 3. Collect guardian approvals ────────────────────────────────────────────
//
// Each guardian approves independently. Approvals are collected by the
// recovery coordinator (your backend service or the user's recovery UI).

const afterApprovalA = approveRecovery(recoveryConfig, request, GUARDIAN_A);

if (afterApprovalA.status === "error") {
  console.error("Guardian A approval failed:", afterApprovalA.error.message);
  process.exit(1);
}

let updatedRequest = afterApprovalA.data;
console.log(`\nApprovals collected: ${updatedRequest.approvals.length}/${recoveryConfig.approvalThreshold}`);

const afterApprovalC = approveRecovery(recoveryConfig, updatedRequest, GUARDIAN_C);

if (afterApprovalC.status === "error") {
  console.error("Guardian C approval failed:", afterApprovalC.error.message);
  process.exit(1);
}

updatedRequest = afterApprovalC.data;
console.log(`Approvals collected: ${updatedRequest.approvals.length}/${recoveryConfig.approvalThreshold}`);

// ── 4. Check readiness ────────────────────────────────────────────────────────

const readyCheck = isRecoveryReady(recoveryConfig, updatedRequest);

if (readyCheck.status === "error") {
  console.log("\nRecovery not yet ready:", readyCheck.error.message);
  // If the delay hasn't passed, poll again after (request.executeAfter - now) seconds.
  const secondsRemaining = updatedRequest.executeAfter - Math.floor(Date.now() / 1000);
  console.log(`Wait ${Math.ceil(secondsRemaining / 3600)} more hour(s) before executing.`);
  process.exit(0);
}

console.log("\nRecovery is ready to execute.");

// ── 5. Execute the recovery ───────────────────────────────────────────────────

const plan = executeRecovery(recoveryConfig, updatedRequest);

if (plan.status === "error") {
  console.error("Execute plan failed:", plan.error.message);
  process.exit(1);
}

// Build the on-chain key-replacement transaction using the plan
const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, networkPassphrase } = network.data;

// The recovery guardian (GUARDIAN_B) signs this transaction
const recoveryTx = await recoverAccountKeys(
  horizonUrl,
  network.data,
  {
    account:         plan.data.account,
    recoveryKey:     GUARDIAN_B,           // guardian signing the recovery
    compromisedKeys: plan.data.compromisedKeys,
    newKeys:         plan.data.replacementSigners,
  },
);

if (recoveryTx.status === "error") {
  console.error("Recovery tx build failed:", recoveryTx.error.message);
  process.exit(1);
}

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const guardianAdapter = new FreighterAdapter(guardianBSwkInstance);
const guardianConn = await client.wallet.connect(guardianAdapter);
if (guardianConn.status === "error") throw new Error(guardianConn.error.message);

const signedRecovery = await client.wallet.signTransaction(guardianAdapter, {
  transactionXdr: recoveryTx.data,
  networkPassphrase,
});

if (signedRecovery.status === "error") {
  console.error("Guardian sign failed:", signedRecovery.error.message);
  process.exit(1);
}

const submitResult = await submitTransaction(horizonUrl, network.data, signedRecovery.data);

if (submitResult.status === "error") {
  console.error("Recovery submission failed:", submitResult.error.message);
  process.exit(1);
}

console.log("\n✓ Recovery complete! Tx hash:", submitResult.data.hash);
console.log("New key is now active:", NEW_REPLACEMENT_KEY);
```

## Cancelling a recovery request

Any guardian with the `cancel` permission can stop an in-progress recovery (e.g., if the original user regains access and wants to abort):

```ts
import { cancelRecovery } from "sorokit-core";

const cancelled = cancelRecovery(recoveryConfig, updatedRequest, GUARDIAN_A);

if (cancelled.status === "ok") {
  console.log("Recovery cancelled. Status:", cancelled.data.status); // "cancelled"
} else {
  console.error("Cancel failed:", cancelled.error.message);
}
```

## Persisting recovery state

`recoveryWorkflow` functions are pure — they don't persist state. You must store the `RecoveryConfig` and `RecoveryRequest` objects in your own database:

```ts
// After registerRecoveryContacts
await db.saveRecoveryConfig(ACCOUNT, recoveryConfig);

// After initiateRecovery
await db.saveRecoveryRequest(request);

// After each approveRecovery
await db.updateRecoveryRequest(updatedRequest);

// After executeRecovery
await db.markRecoveryComplete(request.id);
```

## Testing tips

```ts
import {
  registerRecoveryContacts,
  initiateRecovery,
  approveRecovery,
  isRecoveryReady,
} from "sorokit-core";

// Duplicate contacts — should fail
const dupConfig = registerRecoveryContacts(
  [
    { address: "GAAA…", permissions: ["approve"] },
    { address: "GAAA…", permissions: ["approve"] },  // duplicate
  ],
  1,
  3600,
);
expect(dupConfig.status).toBe("error");
expect(dupConfig.error.message).toMatch("unique");

// Approval threshold > contact count — should fail
const badThreshold = registerRecoveryContacts(
  [{ address: "GAAA…", permissions: ["approve"] }],
  5, // impossible
  3600,
);
expect(badThreshold.status).toBe("error");

// Guardian without approve permission — should fail
const config = registerRecoveryContacts(
  [{ address: "GAAA…", permissions: ["cancel"] }], // no "approve"
  1,
  3600,
).data!;
const req = initiateRecovery(config, "GAAA…", "GACCOUNT…", [{ key: "GNEW…", weight: 1 }], []).data!;
const denied = approveRecovery(config, req, "GAAA…");
expect(denied.status).toBe("error");
```

## See also

- [Account key rotation](./08-key-rotation.md) — rotate a key when you still have access
- [Multi-sig approval workflow](./01-multisig-approval.md) — require multiple signers on recovery transactions
