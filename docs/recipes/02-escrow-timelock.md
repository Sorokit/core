# Recipe: Escrow with Timelock

## Problem

A buyer wants to pay a seller, but the funds should only be released after a service is delivered. If the seller doesn't deliver by a deadline, the buyer should be able to reclaim the funds. You need an escrow that:

1. Locks funds for a period (timelock).
2. Releases them to the seller after the unlock time.
3. Refunds the buyer if the seller fails to act before the refund deadline.

## Solution

Use `validateEscrow` and `validateEscrowAction` from `sorokit-core` to enforce business rules before building transactions. Combine them with `buildPaymentTransaction` to construct the release or refund operation.

Stellar does not have native on-chain escrow, but the pattern is implemented off-chain: a time-locked signing policy held by a trusted coordinator (or a smart contract). This recipe shows the off-chain coordinator pattern.

## Code

```ts
import {
  validateEscrow,
  validateEscrowAction,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { buildPaymentTransaction } from "sorokit-core/transaction";
import type { EscrowParams } from "sorokit-core";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl } = network.data;

const BUYER_KEY  = "GBUY…BUYER";
const SELLER_KEY = "GSEL…SELLER";
const ESCROW_KEY = "GESC…ESCROW"; // coordinator/custodial key

const nowSeconds = Math.floor(Date.now() / 1000);

// Escrow parameters
const escrowParams: EscrowParams = {
  buyer:       BUYER_KEY,
  seller:      SELLER_KEY,
  amount:      "500",
  assetCode:   "USDC",
  assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  // Release funds to seller 7 days from now
  releaseAfter:  nowSeconds + 7 * 24 * 60 * 60,
  // Buyer can reclaim 14 days from now if seller hasn't triggered release
  refundAfter:   nowSeconds + 14 * 24 * 60 * 60,
  action: "release",
  state:  "pending",
};

// ── 2. Validate the escrow configuration ─────────────────────────────────────

const validation = validateEscrow(escrowParams);
if (validation.status === "error") {
  console.error("Invalid escrow config:", validation.error.message);
  process.exit(1);
}

const { timelock } = validation.data;
console.log("Escrow configured:");
console.log("  Release after:", new Date(timelock.releaseAfter * 1000).toISOString());
if (timelock.refundAfter) {
  console.log("  Refund after: ", new Date(timelock.refundAfter * 1000).toISOString());
}

// ── 3. Lock funds (buyer deposits to escrow account) ─────────────────────────

const lockTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  BUYER_KEY,
  {
    destination: ESCROW_KEY,
    amount:      escrowParams.amount,
    assetCode:   escrowParams.assetCode,
    assetIssuer: escrowParams.assetIssuer,
    memo:        "escrow-lock",
    memoType:    "text",
  },
);

if (lockTx.status === "error") {
  console.error("Lock tx build failed:", lockTx.error.message);
  process.exit(1);
}

// Sign and submit the lock — buyer signs here
const signedLock = await buyerWallet.signTransaction(lockTx.data, network.data.networkPassphrase);
const lockResult = await submitTransaction(horizonUrl, network.data, signedLock);
if (lockResult.status === "error") {
  console.error("Lock failed:", lockResult.error.message);
  process.exit(1);
}
console.log("Funds locked, tx hash:", lockResult.data.hash);

// ── 4. Release funds to seller (after releaseAfter) ──────────────────────────

async function releaseEscrow() {
  const now = Math.floor(Date.now() / 1000);

  // Validate that the action is legal at this time
  const actionCheck = validateEscrowAction(
    "pending",           // current escrow state
    "release",           // desired action
    now,
    escrowParams.releaseAfter,
    escrowParams.refundAfter,
  );

  if (actionCheck.status === "error") {
    console.error("Release not yet valid:", actionCheck.error.message);
    return;
  }

  const releaseTx = await buildPaymentTransaction(
    horizonUrl,
    network.data,
    ESCROW_KEY,
    {
      destination: SELLER_KEY,
      amount:      escrowParams.amount,
      assetCode:   escrowParams.assetCode,
      assetIssuer: escrowParams.assetIssuer,
      memo:        "escrow-release",
      memoType:    "text",
    },
  );

  if (releaseTx.status === "error") {
    console.error("Release tx build failed:", releaseTx.error.message);
    return;
  }

  const signedRelease = await escrowWallet.signTransaction(
    releaseTx.data,
    network.data.networkPassphrase,
  );
  const releaseResult = await submitTransaction(horizonUrl, network.data, signedRelease);
  if (releaseResult.status === "error") {
    console.error("Release failed:", releaseResult.error.message);
    return;
  }
  console.log("Funds released to seller:", releaseResult.data.hash);
}

// ── 5. Refund buyer (after refundAfter, if release not triggered) ─────────────

async function refundEscrow() {
  const now = Math.floor(Date.now() / 1000);

  const actionCheck = validateEscrowAction(
    "pending",
    "refund",
    now,
    escrowParams.releaseAfter,
    escrowParams.refundAfter,
  );

  if (actionCheck.status === "error") {
    console.error("Refund not yet valid:", actionCheck.error.message);
    return;
  }

  const refundTx = await buildPaymentTransaction(
    horizonUrl,
    network.data,
    ESCROW_KEY,
    {
      destination: BUYER_KEY,
      amount:      escrowParams.amount,
      assetCode:   escrowParams.assetCode,
      assetIssuer: escrowParams.assetIssuer,
      memo:        "escrow-refund",
      memoType:    "text",
    },
  );

  if (refundTx.status === "error") {
    console.error("Refund tx build failed:", refundTx.error.message);
    return;
  }

  const signedRefund = await escrowWallet.signTransaction(
    refundTx.data,
    network.data.networkPassphrase,
  );
  const refundResult = await submitTransaction(horizonUrl, network.data, signedRefund);
  if (refundResult.status === "error") {
    console.error("Refund failed:", refundResult.error.message);
    return;
  }
  console.log("Funds refunded to buyer:", refundResult.data.hash);
}
```

## State machine

```
         Buyer locks funds
               │
               ▼
           [pending]
          /         \
   releaseAfter    refundAfter
      reached       reached
        │               │
        ▼               ▼
   [released]       [refunded]
```

`validateEscrowAction` enforces the state machine. Calling `release` before `releaseAfter` returns an error. Calling `refund` before `refundAfter` returns an error. Both actions from any state other than `pending` return an error.

## Edge cases

**Double-spend prevention** — Store the escrow state (`pending` / `released` / `refunded`) in your database. Before calling `validateEscrowAction`, check that the record is still `pending`. After a successful submission, update the record atomically.

**Partial amounts** — `validateEscrow` enforces that `amount` is positive. For partial releases, create a new escrow record for the remainder.

**On-chain alternative** — For trustless escrow without a coordinator, deploy a Soroban contract that holds funds and enforces the timelock natively. See [Contract deployment](./14-contract-deployment.md).

## Testing tips

```ts
import { validateEscrow, validateEscrowAction } from "sorokit-core";

// Simulate a past releaseAfter (should fail)
const past = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
const badResult = validateEscrow({ ...escrowParams, releaseAfter: past });
expect(badResult.status).toBe("error");
expect(badResult.error.message).toMatch("future Unix timestamp");

// Simulate release before releaseAfter (should fail)
const now = Math.floor(Date.now() / 1000);
const future = now + 7 * 24 * 60 * 60;
const tooEarly = validateEscrowAction("pending", "release", now - 100, future);
expect(tooEarly.status).toBe("error");

// Simulate release after releaseAfter (should succeed)
const onTime = validateEscrowAction("pending", "release", future + 1, future);
expect(onTime.status).toBe("ok");
```

## See also

- [Multi-sig approval workflow](./01-multisig-approval.md) — require multiple approvers for release
- [Contract deployment](./14-contract-deployment.md) — trustless on-chain escrow with Soroban
