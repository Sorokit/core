# Recipe: Trustline Management

## Problem

Before an account can receive or hold a non-native asset (e.g., USDC), it must establish a **trustline** to that asset's issuer. You need to:

1. Check if a trustline already exists.
2. Add a trustline for a new asset.
3. Evaluate whether the issuer allows the asset on this account (policy checks).
4. Remove (revoke) a trustline when no longer needed.

## Solution

Use `buildTrustlineTransaction` for adding trustlines, `evaluateTrustlineApproval` for policy checks, and `buildApprovedTrustlineTransaction` for the full approved workflow.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import {
  buildTrustlineTransaction,
  evaluateTrustlineApproval,
  buildApprovedTrustlineTransaction,
} from "sorokit-core/transaction";

// ── 1. Setup ─────────────────────────────────────────────────────────────────

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl, networkPassphrase } = network.data;

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const adapter = new FreighterAdapter(swkInstance);
const conn = await client.wallet.connect(adapter);
if (conn.status === "error") throw new Error(conn.error.message);
const { publicKey } = conn.data;

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ── 2. Check existing trustlines ──────────────────────────────────────────────

const balancesResult = await client.account.getBalances(publicKey);
if (balancesResult.status === "error") {
  console.error("Could not fetch balances:", balancesResult.error.message);
  process.exit(1);
}

const hasTrustline = balancesResult.data.some(
  (b) => b.assetCode === "USDC" && b.assetIssuer === USDC_ISSUER,
);

if (hasTrustline) {
  console.log("USDC trustline already exists.");
} else {
  console.log("No USDC trustline — will add one.");
}

// ── 3. Add a trustline ────────────────────────────────────────────────────────

async function sign(xdr: string): Promise<string> {
  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: xdr,
    networkPassphrase,
  });
  if (signed.status === "error") throw new Error(signed.error.message);
  return signed.data;
}

if (!hasTrustline) {
  const trustlineTx = await buildTrustlineTransaction(
    horizonUrl,
    network.data,
    publicKey,
    {
      assetCode:   "USDC",
      assetIssuer: USDC_ISSUER,
      // limit defaults to max. Set an explicit limit to cap holding risk:
      // limit: "10000",
    },
  );

  if (trustlineTx.status === "error") {
    console.error("Trustline build failed:", trustlineTx.error.message);
    process.exit(1);
  }

  const signedTx = await sign(trustlineTx.data);
  const result = await submitTransaction(horizonUrl, network.data, signedTx);

  if (result.status === "error") {
    console.error("Trustline submission failed:", result.error.message);
    process.exit(1);
  }

  console.log("USDC trustline added! Tx hash:", result.data.hash);
}

// ── 4. Add multiple trustlines in one transaction ────────────────────────────

import { buildBulkTrustlineTransaction } from "sorokit-core/transaction";

const assetsToTrust = [
  { assetCode: "EURC", assetIssuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP" },
  { assetCode: "yBTC", assetIssuer: "GBTC…ISSUER" },
  { assetCode: "yETH", assetIssuer: "GETH…ISSUER" },
];

const bulkResult = await buildBulkTrustlineTransaction(
  horizonUrl,
  network.data,
  publicKey,
  assetsToTrust,
);

if (bulkResult.status === "error") {
  console.error("Bulk trustline build failed:", bulkResult.error.message);
} else {
  const signedBulk = await sign(bulkResult.data);
  const bulkSubmit = await submitTransaction(horizonUrl, network.data, signedBulk);
  if (bulkSubmit.status === "ok") {
    console.log("Bulk trustlines added:", bulkSubmit.data.hash);
  }
}

// ── 5. Evaluate issuer approval policy ───────────────────────────────────────
//
// Some issuers use SEP-8 regulated assets that require explicit approval.

const REGULATED_ISSUER = "GREG…ISSUER";

const approvalPolicy = {
  issuer:          REGULATED_ISSUER,
  assetCode:       "STKN",
  requiresApproval: true,
  approvalUrl:     "https://api.regulated-asset.example.com/approval",
};

const evalResult = await evaluateTrustlineApproval(
  publicKey,
  { assetCode: "STKN", assetIssuer: REGULATED_ISSUER },
  approvalPolicy,
);

if (evalResult.status === "error") {
  console.error("Trustline approval denied:", evalResult.error.message);
  process.exit(1);
}

const decision = evalResult.data;
console.log("Approval decision:", decision.approved ? "✓ Approved" : "✗ Denied");
console.log("Reason:", decision.reason);

// For approved regulated assets, use buildApprovedTrustlineTransaction
if (decision.approved) {
  const approvedTx = await buildApprovedTrustlineTransaction(
    horizonUrl,
    network.data,
    publicKey,
    { assetCode: "STKN", assetIssuer: REGULATED_ISSUER },
    decision,
  );

  if (approvedTx.status === "ok") {
    const signedApproved = await sign(approvedTx.data);
    const approvedResult = await submitTransaction(horizonUrl, network.data, signedApproved);
    console.log("Regulated trustline added:", approvedResult.data?.hash);
  }
}

// ── 6. Remove a trustline ─────────────────────────────────────────────────────
//
// Set limit to "0" to remove the trustline.
// The balance must be 0 first or the operation will fail.

async function removeTrustline(assetCode: string, assetIssuer: string): Promise<void> {
  // First check balance is zero
  const currentBalances = await client.account.getAssetBalances(publicKey, {
    assetCode,
    assetIssuer,
  });

  if (currentBalances.status === "ok") {
    const asset = currentBalances.data[0];
    if (asset && Number(asset.balance) > 0) {
      console.error(
        `Cannot remove trustline for ${assetCode}: balance is ${asset.balance}. ` +
        "Send or swap the remaining balance first.",
      );
      return;
    }
  }

  const removeTx = await buildTrustlineTransaction(
    horizonUrl,
    network.data,
    publicKey,
    {
      assetCode,
      assetIssuer,
      limit: "0", // limit 0 = remove trustline
    },
  );

  if (removeTx.status === "error") {
    console.error("Remove trustline build failed:", removeTx.error.message);
    return;
  }

  const signedRemove = await sign(removeTx.data);
  const removeResult = await submitTransaction(horizonUrl, network.data, signedRemove);

  if (removeResult.status === "ok") {
    console.log(`Trustline for ${assetCode} removed:`, removeResult.data.hash);
  } else {
    console.error("Remove failed:", removeResult.error.message);
  }
}

// Only call after balance is zero
await removeTrustline("EURC", "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP");
```

## Reserve cost

Each trustline reserves **0.5 XLM** in the account's minimum balance. Before adding trustlines, verify the account has sufficient XLM:

```ts
const accountInfo = await client.account.get(publicKey);
if (accountInfo.status === "ok") {
  const xlmBalance = Number(accountInfo.data.balances
    .find((b) => b.assetCode === "XLM")?.balance ?? "0");
  const numTrustlines = accountInfo.data.subentryCount ?? 0;
  const minBalance = (2 + numTrustlines) * 0.5;
  const available = xlmBalance - minBalance;
  const canAdd = Math.floor(available / 0.5);
  console.log(`Can add up to ${canAdd} more trustlines (${available.toFixed(2)} XLM available)`);
}
```

## Testing tips

```ts
import { buildTrustlineTransaction } from "sorokit-core/transaction";

// Invalid issuer — should fail
const badIssuer = await buildTrustlineTransaction(horizonUrl, network.data, "GAAA…", {
  assetCode:   "TEST",
  assetIssuer: "not-a-valid-key",
});
expect(badIssuer.status).toBe("error");
expect(badIssuer.error.message).toMatch("issuer");

// Native asset — no trustline needed (should fail or be a no-op)
const nativeTrustline = await buildTrustlineTransaction(horizonUrl, network.data, "GAAA…", {
  assetCode:   "XLM",
  assetIssuer: null,
});
expect(nativeTrustline.status).toBe("error");
```

## See also

- [Path payment (cross-asset)](./12-path-payment.md) — trustlines are required for the destination asset
- [Soroban contract invoke](./04-soroban-invoke.md) — SAC (Stellar Asset Contract) tokens also need trustlines
