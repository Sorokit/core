# Recipe: Fee Estimation and Surge Pricing

## Problem

The Stellar network uses a fee market — fees vary with network congestion. Submitting with too low a fee results in transaction rejection or long delays. Submitting with too high a fee wastes money. You need to:

1. Estimate the right fee before building a transaction.
2. Handle surge pricing during network congestion.
3. Use adaptive fees that adjust to real-time network conditions.

## Solution

Use `client.transaction.estimateFee` for pre-build estimation, and the adaptive fee options in `buildPaymentTransaction` to let the SDK pick the right fee automatically.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import {
  buildPaymentTransaction,
  estimateFee,
  calculateAdaptiveFee,
  fetchCongestionFeeEstimate,
  recordFeeEstimate,
  getFeeHistory,
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

// ── 2. Estimate fee from payment parameters ───────────────────────────────────

const feeEstimate = await client.transaction.estimateFee({
  kind:        "payment",
  publicKey,
  destination: "GDST…RECIP",
  amount:      "100",
});

if (feeEstimate.status === "error") {
  console.error("Fee estimation failed:", feeEstimate.error.message);
  // Fall back to BASE_FEE (100 stroops)
} else {
  const { baseFee, percentiles } = feeEstimate.data;
  console.log("Fee estimate:");
  console.log("  Base (minimum):     ", baseFee, "stroops");
  console.log("  P50 (median):       ", percentiles?.p50 ?? "N/A", "stroops");
  console.log("  P90 (fast):         ", percentiles?.p90 ?? "N/A", "stroops");
  console.log("  P99 (high-priority):", percentiles?.p99 ?? "N/A", "stroops");
}

// ── 3. Estimate fee from existing XDR ────────────────────────────────────────

// First build without a fee to get the transaction structure
const builtTx = await buildPaymentTransaction(horizonUrl, network.data, publicKey, {
  destination: "GDST…RECIP",
  amount:      "100",
});

if (builtTx.status === "ok") {
  const xdrFeeEstimate = await client.transaction.estimateFee({
    kind:           "xdr",
    transactionXdr: builtTx.data,
  });

  if (xdrFeeEstimate.status === "ok") {
    console.log("XDR-based fee estimate:", xdrFeeEstimate.data.baseFee, "stroops");
  }
}

// ── 4. Surge pricing detection ────────────────────────────────────────────────

const congestionEstimate = await fetchCongestionFeeEstimate(horizonUrl);

if (congestionEstimate.status === "ok") {
  const { baseFeeMedian, feeSurge, lastLedgerFee } = congestionEstimate.data;

  console.log("\nCongestion report:");
  console.log("  Median fee:    ", baseFeeMedian, "stroops");
  console.log("  Surge active:  ", feeSurge ? "YES ⚠" : "no");
  console.log("  Last ledger:   ", lastLedgerFee, "stroops");

  if (feeSurge) {
    console.warn("Network is experiencing surge pricing. Consider waiting or paying the higher fee.");
  }
}

// ── 5. Build with adaptive fee (automatically handles surge) ─────────────────

const PRIORITY: "normal" | "fast" | "urgent" = "fast";

// Fetch the current adaptive fee for this priority level
const adaptiveFee = await calculateAdaptiveFee(
  horizonUrl,
  PRIORITY,
  {
    maxFee:    50_000, // cap at 50,000 stroops (0.005 XLM) regardless
    fallback:  200,    // use 200 stroops if Horizon is unreachable
  },
);

const feeToUse = adaptiveFee.status === "ok" ? adaptiveFee.data.fee : "200";
console.log(`\nUsing adaptive fee: ${feeToUse} stroops (priority: ${PRIORITY})`);

// Build the transaction with the computed fee
const txWithFee = await buildPaymentTransaction(horizonUrl, network.data, publicKey, {
  destination:  "GDST…RECIP",
  amount:       "100",
  estimatedFee: feeToUse,
});

if (txWithFee.status === "error") {
  console.error("Build failed:", txWithFee.error.message);
  process.exit(1);
}

// ── 6. Sign and submit ────────────────────────────────────────────────────────

const signed = await client.wallet.signTransaction(adapter, {
  transactionXdr: txWithFee.data,
  networkPassphrase,
});

if (signed.status === "error") {
  console.error("Sign failed:", signed.error.message);
  process.exit(1);
}

const result = await submitTransaction(horizonUrl, network.data, signed.data);

if (result.status === "error") {
  if (result.error.message.includes("tx_insufficient_fee")) {
    console.error("Fee too low — network rejected the transaction. Retry with a higher fee.");
  } else {
    console.error("Submit failed:", result.error.message);
  }
  process.exit(1);
}

console.log("Transaction confirmed:", result.data.hash);

// ── 7. Record and review fee history ─────────────────────────────────────────

// After confirmation, record the actual fee for future estimates
if (result.data.fee) {
  recordFeeEstimate({
    fee:       result.data.fee,
    timestamp: Date.now(),
    priority:  PRIORITY,
  });
}

// Review recent fee history to inform future decisions
const history = getFeeHistory();
console.log("\nFee history (last entries):");
for (const entry of history.slice(-5)) {
  console.log(`  ${new Date(entry.timestamp).toISOString()}: ${entry.fee} stroops (${entry.priority})`);
}
```

## Fee tiers reference

| Priority | Use case | Percentile target |
|----------|----------|-------------------|
| `normal` | Non-urgent, off-peak | P50 (median) |
| `fast`   | Time-sensitive operations | P90 |
| `urgent` | Arbitrage, time-locked | P99 |

## Fee bump for stuck transactions

If a transaction was submitted with too low a fee and is stuck:

```ts
import { buildFeeBumpTransaction } from "sorokit-core/transaction";

// The inner transaction was submitted but not included due to low fee
const STUCK_INNER_XDR = "AAAA…XDR_OF_STUCK_TX";
const BUMP_FEE         = "10000"; // stroops — must be higher than original

const feeBump = await buildFeeBumpTransaction(horizonUrl, network.data, {
  feeSource:      publicKey,
  innerXdr:       STUCK_INNER_XDR,
  baseFee:        BUMP_FEE,
});

if (feeBump.status === "ok") {
  const signedBump = await client.wallet.signTransaction(adapter, {
    transactionXdr: feeBump.data,
    networkPassphrase,
  });
  if (signedBump.status === "ok") {
    const bumpResult = await submitTransaction(horizonUrl, network.data, signedBump.data);
    console.log("Fee bump submitted:", bumpResult.data?.hash);
  }
}
```

## Testing tips

```ts
import { calculateAdaptiveFee } from "sorokit-core/transaction";
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Simulate a surge pricing scenario
client.transaction.estimateFee.mockResolvedValueOnce({
  status: "ok",
  data: {
    baseFee: "100",
    percentiles: { p50: "500", p90: "2000", p99: "10000" },
    feeSurge: true,
  },
  error: null,
});

// Verify caller handles feeSurge=true (e.g., warns user)

// Simulate Horizon unreachable — adaptive fee should fall back
client.transaction.estimateFee.mockResolvedValueOnce({
  status: "error",
  data: null,
  error: { code: "NETWORK_ERROR", message: "timeout" },
});
const fallbackFee = await calculateAdaptiveFee(horizonUrl, "normal", { fallback: 200 });
expect(fallbackFee.data?.fee).toBe("200");
```

## See also

- [Batch payment with progress tracking](./05-batch-payment.md) — apply adaptive fees per batch
- [Soroban contract invoke](./04-soroban-invoke.md) — Soroban operations have higher base fees
