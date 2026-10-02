# Recipe: Batch Payment with Progress Tracking

## Problem

You need to send payments to many recipients — for example, a payroll run, an airdrop, or a distributor payout. You want to:

1. Submit payments concurrently (not one at a time).
2. Track which succeed and which fail.
3. Retry transient failures without re-sending already-confirmed payments.
4. Produce a final report of all outcomes.

## Solution

Build each transaction individually with `buildPaymentTransaction`, then submit them using `batchSubmitter` from `sorokit-core/transaction`. `batchSubmitter` handles concurrency, deduplication, and per-item results.

For a simpler single-operation batch (many operations in one transaction), use `compose()` — but Stellar limits a single transaction to 100 operations, so `batchSubmitter` is needed for larger batches.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
} from "sorokit-core";
import { buildPaymentTransaction, submitTransaction } from "sorokit-core/transaction";

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

// ── 2. Define recipients ──────────────────────────────────────────────────────

interface PayoutItem {
  id:          string;
  destination: string;
  amount:      string;
  memo?:       string;
}

const payouts: PayoutItem[] = [
  { id: "emp-001", destination: "GAAA…", amount: "1500.00", memo: "payroll-2026-09" },
  { id: "emp-002", destination: "GBBB…", amount: "2200.00", memo: "payroll-2026-09" },
  { id: "emp-003", destination: "GCCC…", amount:  "800.00", memo: "payroll-2026-09" },
  // ... up to thousands of entries
];

// ── 3. Build, sign, and submit with progress tracking ────────────────────────

interface PayoutResult {
  id:     string;
  status: "success" | "failed" | "skipped";
  hash?:  string;
  error?: string;
}

const results: PayoutResult[] = [];
let completed = 0;

function reportProgress() {
  const pct = Math.round((completed / payouts.length) * 100);
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed    = results.filter((r) => r.status === "failed").length;
  console.log(`[${pct}%] ${completed}/${payouts.length} — ✓ ${succeeded}  ✗ ${failed}`);
}

// Process in parallel batches to avoid overwhelming Horizon
const BATCH_SIZE        = 5;
const MAX_RETRIES       = 2;
const RETRY_DELAY_MS    = 2000;

async function submitWithRetry(
  xdr:    string,
  itemId: string,
  attempt = 1,
): Promise<PayoutResult["status"]> {
  const result = await submitTransaction(horizonUrl, network.data, xdr);

  if (result.status === "ok") return "success";

  const isTransient =
    result.error.message.includes("timeout") ||
    result.error.message.includes("connection") ||
    result.error.code === "NETWORK_ERROR";

  if (isTransient && attempt < MAX_RETRIES) {
    console.warn(`[${itemId}] Transient error, retry ${attempt}/${MAX_RETRIES}…`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    return submitWithRetry(xdr, itemId, attempt + 1);
  }

  return "failed";
}

for (let i = 0; i < payouts.length; i += BATCH_SIZE) {
  const batch = payouts.slice(i, i + BATCH_SIZE);

  const batchPromises = batch.map(async (payout) => {
    // Build
    const built = await buildPaymentTransaction(horizonUrl, network.data, publicKey, {
      destination: payout.destination,
      amount:      payout.amount,
      assetCode:   "USDC",
      assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      memo:        payout.memo,
      memoType:    "text",
    });

    if (built.status === "error") {
      console.error(`[${payout.id}] Build failed: ${built.error.message}`);
      return { id: payout.id, status: "failed" as const, error: built.error.message };
    }

    // Sign
    const signed = await client.wallet.signTransaction(adapter, {
      transactionXdr: built.data,
      networkPassphrase,
    });

    if (signed.status === "error") {
      console.error(`[${payout.id}] Sign failed: ${signed.error.message}`);
      return { id: payout.id, status: "failed" as const, error: signed.error.message };
    }

    // Submit (with retry)
    const submitResult = await submitTransaction(horizonUrl, network.data, signed.data);

    if (submitResult.status === "ok") {
      return {
        id:     payout.id,
        status: "success" as const,
        hash:   submitResult.data.hash,
      };
    }

    const isTransient =
      submitResult.error.message.includes("timeout") ||
      submitResult.error.code === "NETWORK_ERROR";

    if (isTransient) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      const retry = await submitTransaction(horizonUrl, network.data, signed.data);
      if (retry.status === "ok") {
        return { id: payout.id, status: "success" as const, hash: retry.data.hash };
      }
    }

    return {
      id:     payout.id,
      status: "failed" as const,
      error:  submitResult.error.message,
    };
  });

  const batchResults = await Promise.all(batchPromises);
  results.push(...batchResults);
  completed += batch.length;
  reportProgress();
}

// ── 4. Final report ───────────────────────────────────────────────────────────

const succeeded = results.filter((r) => r.status === "success");
const failed    = results.filter((r) => r.status === "failed");

console.log("\n── Batch payment complete ──────────────────────");
console.log(`✓  Succeeded: ${succeeded.length}/${payouts.length}`);
console.log(`✗  Failed:    ${failed.length}/${payouts.length}`);

if (failed.length > 0) {
  console.log("\nFailed payments:");
  for (const f of failed) {
    console.log(`  ${f.id}: ${f.error}`);
  }
}

// Export for audit
const report = {
  timestamp:  new Date().toISOString(),
  total:      payouts.length,
  succeeded:  succeeded.length,
  failed:     failed.length,
  items:      results,
};

console.log("\nAudit report:", JSON.stringify(report, null, 2));
```

## Packing multiple payments into one transaction

For batches under 100 recipients, pack operations into one transaction for a single fee:

```ts
import { compose, resolveNetwork } from "sorokit-core";

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);

const builder = compose({ network: network.data, source: publicKey });

for (const payout of payouts.slice(0, 100)) {
  builder.payment({
    destination: payout.destination,
    amount:      payout.amount,
    asset:       { code: "USDC", issuer: USDC_ISSUER },
  });
}

const built = await builder.build();
if (built.status === "error") {
  console.error("Compose failed:", built.error.message);
}

// One signature, one fee, all 100 payments — atomic
const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: built.data,
  networkPassphrase,
});
```

## Idempotency and resumption

To avoid double-payments on restart:

1. Before starting, load already-confirmed hashes from your database.
2. For each item, check if a hash already exists — skip if it does.
3. After confirmation, write the hash to the database before moving to the next item.

```ts
const confirmedIds = new Set(await db.getConfirmedPayoutIds(runId));

for (const payout of payouts) {
  if (confirmedIds.has(payout.id)) {
    results.push({ id: payout.id, status: "skipped" });
    continue;
  }
  // ... build, sign, submit ...
  // After success:
  await db.recordPayout(runId, payout.id, hash);
}
```

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Simulate one failure and two successes
client.transaction.submit
  .mockResolvedValueOnce({ status: "error", data: null, error: { code: "TX_SUBMIT_FAILED", message: "timeout" } })
  .mockResolvedValueOnce({ status: "ok", data: { hash: "HASH_B" }, error: null })
  .mockResolvedValueOnce({ status: "ok", data: { hash: "HASH_C" }, error: null });

// Verify that the first retry succeeds
client.transaction.submit
  .mockResolvedValueOnce({ status: "ok", data: { hash: "HASH_A_RETRY" }, error: null });
```

## See also

- [Payment with memo](./09-payment-with-memo.md) — attach exchange routing memos
- [DEX atomic swap](./03-dex-atomic-swap.md) — batch multiple swap operations
