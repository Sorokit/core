# Recipe: Portfolio Rebalancing

## Problem

An account holds several assets. You want to rebalance the portfolio to a set of target allocations (e.g., 40% XLM, 30% USDC, 30% BTC). The workflow should:

1. Fetch current balances and compute their USD values.
2. Compare current allocations to targets.
3. Build swap transactions to correct the imbalance.
4. Execute only swaps that exceed a minimum drift threshold (to avoid churning on small deviations).

## Solution

Use `client.account.getBalances` for current state, `getAssetPrice` to value each position, and `findSwapPath` + `buildAtomicSwap` to build the rebalancing trades.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  findSwapPath,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { getAssetPrice } from "sorokit-core/transaction";
import { buildAtomicSwap } from "sorokit-core/transaction";

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

// ── 2. Define target allocations ─────────────────────────────────────────────

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

interface AllocationTarget {
  assetCode:   string;
  assetIssuer: string | null;
  targetPct:   number; // 0–100
}

const targets: AllocationTarget[] = [
  { assetCode: "XLM",  assetIssuer: null,         targetPct: 40 },
  { assetCode: "USDC", assetIssuer: USDC_ISSUER,   targetPct: 35 },
  { assetCode: "yBTC", assetIssuer: "GBTC…ISSUER", targetPct: 25 },
];

const DRIFT_THRESHOLD_PCT = 2;  // only rebalance if drift > 2%
const SLIPPAGE_PCT        = 0.5;

// ── 3. Fetch current balances ─────────────────────────────────────────────────

const balancesResult = await client.account.getBalances(publicKey);
if (balancesResult.status === "error") {
  console.error("Could not fetch balances:", balancesResult.error.message);
  process.exit(1);
}

const balances = balancesResult.data;

// ── 4. Price each asset in USD ────────────────────────────────────────────────

interface Position {
  assetCode:    string;
  assetIssuer:  string | null;
  balance:      number;
  usdValue:     number;
  currentPct:   number;
  targetPct:    number;
  driftPct:     number;
}

async function priceAsset(code: string, issuer: string | null): Promise<number> {
  if (code === "USDC") return 1.0;

  const priceResult = await getAssetPrice(
    { code, issuer },
    { code: "USDC", issuer: USDC_ISSUER },
    { horizonUrl },
  );

  return priceResult.status === "ok" ? Number(priceResult.data.price) : 0;
}

const positions: Position[] = [];
let totalUsd = 0;

for (const target of targets) {
  const bal = balances.find(
    (b) =>
      b.assetCode === target.assetCode &&
      (target.assetIssuer === null ? b.assetCode === "XLM" : b.assetIssuer === target.assetIssuer),
  );

  const balance   = bal ? Number(bal.balance) : 0;
  const usdPrice  = await priceAsset(target.assetCode, target.assetIssuer);
  const usdValue  = balance * usdPrice;

  totalUsd += usdValue;
  positions.push({
    assetCode:   target.assetCode,
    assetIssuer: target.assetIssuer,
    balance,
    usdValue,
    currentPct:  0,
    targetPct:   target.targetPct,
    driftPct:    0,
  });
}

// Compute current percentages and drift
for (const pos of positions) {
  pos.currentPct = totalUsd > 0 ? (pos.usdValue / totalUsd) * 100 : 0;
  pos.driftPct   = pos.currentPct - pos.targetPct;
}

console.log("\n── Current portfolio ───────────────────────────");
for (const pos of positions) {
  const arrow = pos.driftPct > 0 ? "▲" : pos.driftPct < 0 ? "▼" : "●";
  console.log(
    `  ${pos.assetCode.padEnd(6)} ${pos.currentPct.toFixed(1).padStart(5)}% `+
    `(target ${pos.targetPct}%) ${arrow} drift ${pos.driftPct.toFixed(1)}%`,
  );
}

// ── 5. Build and execute rebalancing trades ───────────────────────────────────

// Separate over- and under-weight positions
const overweight  = positions.filter((p) => p.driftPct > DRIFT_THRESHOLD_PCT);
const underweight = positions.filter((p) => p.driftPct < -DRIFT_THRESHOLD_PCT);

if (overweight.length === 0 && underweight.length === 0) {
  console.log("\nPortfolio is within tolerance — no rebalancing needed.");
  process.exit(0);
}

console.log("\n── Rebalancing trades ──────────────────────────");

for (const source of overweight) {
  for (const dest of underweight) {
    if (source.driftPct <= DRIFT_THRESHOLD_PCT) break;
    if (dest.driftPct >= -DRIFT_THRESHOLD_PCT) continue;

    // How much USD value to move
    const moveUsd      = Math.min(source.driftPct, -dest.driftPct) / 100 * totalUsd;
    const sendAmount   = (moveUsd / (source.usdValue / source.balance)).toFixed(7);

    console.log(`  Sell ${sendAmount} ${source.assetCode} → ${dest.assetCode}`);

    // Find path
    const pathsResult = await findSwapPath(horizonUrl, {
      sourcePublicKey: publicKey,
      sendAssetCode:   source.assetCode,
      sendAssetIssuer: source.assetIssuer,
      destAssetCode:   dest.assetCode,
      destAssetIssuer: dest.assetIssuer,
      amount:          sendAmount,
      mode:            "strict-send",
    });

    if (pathsResult.status === "error" || pathsResult.data.length === 0) {
      console.warn(`  No path found for ${source.assetCode} → ${dest.assetCode}, skipping`);
      continue;
    }

    const route       = pathsResult.data[0]!;
    const minDest     = (Number(sendAmount) * Number(route.price) * (1 - SLIPPAGE_PCT / 100)).toFixed(7);

    const swapTx = await buildAtomicSwap(horizonUrl, network.data, {
      sourcePublicKey: publicKey,
      sendAssetCode:   source.assetCode,
      sendAssetIssuer: source.assetIssuer,
      destAssetCode:   dest.assetCode,
      destAssetIssuer: dest.assetIssuer,
      sendAmount,
      destMinAmount:   minDest,
      path:            route.path,
      destination:     publicKey,
    });

    if (swapTx.status === "error") {
      console.error(`  Swap build failed: ${swapTx.error.message}`);
      continue;
    }

    const signed = await client.wallet.signTransaction(adapter, {
      transactionXdr: swapTx.data,
      networkPassphrase,
    });

    if (signed.status === "error") {
      console.error(`  Sign failed: ${signed.error.message}`);
      continue;
    }

    const submitted = await submitTransaction(horizonUrl, network.data, signed.data);
    if (submitted.status === "ok") {
      console.log(`  ✓ ${submitted.data.hash}`);
      // Update drift estimates for subsequent iterations
      source.driftPct -= moveUsd / totalUsd * 100;
      dest.driftPct   += moveUsd / totalUsd * 100;
    } else {
      console.error(`  ✗ ${submitted.error.message}`);
    }
  }
}

console.log("\nRebalancing complete.");
```

## Dry-run mode

Before executing, print the plan without signing:

```ts
console.log("── Dry run (no transactions submitted) ─────────");
for (const source of overweight) {
  for (const dest of underweight) {
    const moveUsd = Math.min(source.driftPct, -dest.driftPct) / 100 * totalUsd;
    const sendAmount = (moveUsd / (source.usdValue / source.balance)).toFixed(7);
    console.log(`  Would sell ${sendAmount} ${source.assetCode} → buy ${dest.assetCode}`);
  }
}
```

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

const client = createMockClient();

// Mock balances
client.account.getBalances.mockResolvedValueOnce({
  status: "ok",
  data: [
    { assetCode: "XLM",  balance: "1000", balanceFloat: 1000 },
    { assetCode: "USDC", balance: "500",  balanceFloat: 500, assetIssuer: USDC_ISSUER },
  ],
  error: null,
});

// Verify that no swap is triggered when drift is within threshold
```

## See also

- [DEX atomic swap](./03-dex-atomic-swap.md) — single swap mechanics
- [Offer management on DEX](./07-offer-management.md) — limit orders for gradual rebalancing
- [Real-time balance alerts](./13-balance-alerts-streaming.md) — trigger rebalancing on balance events
