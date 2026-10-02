# Recipe: Real-Time Balance Alerts and Streaming

## Problem

You want to react immediately when an account balance changes — for example:
- Alert when XLM drops below a reserve threshold.
- Trigger a rebalancing workflow when USDC exceeds a target.
- Display a live balance feed in a UI component.
- Log all incoming transactions for auditing.

Polling Horizon yourself is error-prone and wastes connections. You need a managed stream.

## Solution

Use `createBalanceAlert` for threshold-based callbacks and `client.account.stream` / `client.transaction.stream` for full streaming. Both support `AbortController` for clean teardown.

## Code

### Balance alerts (threshold callbacks)

```ts
import {
  createBalanceAlert,
  resolveNetwork,
} from "sorokit-core";
import type { BalanceAlert } from "sorokit-core";

const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);
const { horizonUrl } = network.data;

const ACCOUNT = "GABC…ACCOUNT";

// Set up multiple alert rules on one account
const unsubscribe = createBalanceAlert(
  horizonUrl,
  ACCOUNT,
  [
    // Alert when XLM drops below 100 (critical reserve)
    {
      assetCode:  "XLM",
      condition:  "below",
      threshold:  "100",
    },
    // Alert when USDC exceeds 50,000 (sweep threshold)
    {
      assetCode:   "USDC",
      assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      condition:   "above",
      threshold:   "50000",
    },
    // Alert when yBTC balance changes at all
    {
      assetCode:   "yBTC",
      assetIssuer: "GBTC…ISSUER",
      condition:   "above",
      threshold:   "0",
    },
  ],
  (alert: BalanceAlert) => {
    console.log(
      `[ALERT] ${alert.assetCode} balance ${alert.condition} threshold:`,
      `current=${alert.currentBalance}, threshold=${alert.threshold}`,
    );

    // Trigger business logic
    if (alert.assetCode === "XLM" && alert.condition === "below") {
      triggerXlmTopUp(ACCOUNT, alert.currentBalance);
    }

    if (alert.assetCode === "USDC" && alert.condition === "above") {
      triggerUsdcSweep(ACCOUNT, alert.currentBalance);
    }
  },
  {
    pollIntervalMs: 5_000, // check every 5 seconds (default)
  },
);

// Stop monitoring when the application shuts down
process.on("SIGTERM", () => {
  unsubscribe();
  console.log("Balance monitoring stopped.");
});

function triggerXlmTopUp(account: string, currentBalance: string) {
  console.log(`XLM reserve low (${currentBalance}). Initiating top-up for ${account}.`);
  // ... build and submit a top-up transaction
}

function triggerUsdcSweep(account: string, currentBalance: string) {
  console.log(`USDC above sweep threshold (${currentBalance}). Moving to cold storage.`);
  // ... build and submit a sweep transaction
}
```

### Account streaming (async generator)

```ts
import { createSorokitClient } from "sorokit-core";

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const ac = new AbortController();
const ACCOUNT = "GABC…ACCOUNT";

// Start streaming account state changes
const stream = client.account.stream(
  ACCOUNT,
  {
    intervalMs: 3_000, // poll every 3 seconds
  },
  ac.signal,
);

for await (const result of stream) {
  if (result.status === "error") {
    console.error("Stream error:", result.error.code, result.error.message);

    // Transient errors (network blips) are emitted as errors in the stream —
    // they do not stop iteration. The generator retries on the next interval.
    if (result.error.code === "ACCOUNT_NOT_FOUND") {
      console.error("Account does not exist — stopping stream.");
      ac.abort();
      break;
    }
    continue;
  }

  const { balances, sequence } = result.data;
  console.log(`[${new Date().toISOString()}] Sequence: ${sequence}`);

  for (const b of balances) {
    console.log(`  ${b.assetCode.padEnd(6)} ${b.balance}`);
  }
}

// Stop from outside the loop (e.g., on user navigation away)
setTimeout(() => ac.abort(), 30_000);
```

### Transaction streaming

```ts
import { createSorokitClient } from "sorokit-core";

const clientResult = createSorokitClient({ network: "testnet" });
if (clientResult.status === "error") throw new Error(clientResult.error.message);
const client = clientResult.data;

const ac = new AbortController();
const ACCOUNT = "GABC…ACCOUNT";

// Stream incoming and outgoing transactions
const txStream = client.transaction.stream(
  ACCOUNT,
  {
    intervalMs: 5_000,
    transport:  "auto", // uses SSE when available, falls back to polling
  },
  ac.signal,
);

for await (const result of txStream) {
  if (result.status === "error") {
    console.error("Tx stream error:", result.error.message);
    continue;
  }

  const { transactions } = result.data;
  for (const tx of transactions) {
    console.log(`  ${tx.hash.slice(0, 8)}… ${tx.status} at ledger ${tx.ledger}`);
  }
}
```

### React integration example

```tsx
import { useEffect, useRef, useState } from "react";
import { createSorokitClient } from "sorokit-core";
import type { AccountInfo } from "sorokit-core";

export function LiveBalance({ publicKey }: { publicKey: string }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const abortRef              = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;

    const clientResult = createSorokitClient({ network: "testnet" });
    if (clientResult.status === "error") {
      setError(clientResult.error.message);
      return;
    }
    const client = clientResult.data;

    async function run() {
      for await (const result of client.account.stream(
        publicKey,
        { intervalMs: 5_000 },
        ac.signal,
      )) {
        if (result.status === "ok") {
          setAccount(result.data);
          setError(null);
        } else {
          setError(result.error.message);
        }
      }
    }

    run().catch((err) => {
      if (err.name !== "AbortError") {
        setError(String(err));
      }
    });

    return () => ac.abort();
  }, [publicKey]);

  if (error)   return <p className="error">Stream error: {error}</p>;
  if (!account) return <p>Connecting…</p>;

  return (
    <ul>
      {account.balances.map((b) => (
        <li key={`${b.assetCode}-${b.assetIssuer}`}>
          {b.assetCode}: {b.balance}
        </li>
      ))}
    </ul>
  );
}
```

## Alert condition reference

| Condition | Fires when |
|-----------|------------|
| `"below"` | Balance drops below threshold |
| `"above"` | Balance rises above threshold |

Alerts fire once per crossing. If the balance stays below threshold across multiple polls, the callback is called only on the first detection.

## Combining alerts with AbortController

```ts
// Stop all monitors after 1 hour
const ac = new AbortController();
setTimeout(() => ac.abort(), 3_600_000);

const unsubscribe = createBalanceAlert(
  horizonUrl,
  ACCOUNT,
  [{ assetCode: "XLM", condition: "below", threshold: "50" }],
  (alert) => console.log("Alert:", alert),
  { signal: ac.signal },  // stop when aborted
);

// Also stop on user action
button.onclick = () => unsubscribe();
```

## Testing tips

```ts
import { createMockClient } from "sorokit-core/testing";

// Simulate a balance change across two polls
const client = createMockClient();

client.account.stream = vi.fn(async function* () {
  yield { status: "ok", data: { balances: [{ assetCode: "XLM", balance: "150" }] }, error: null };
  yield { status: "ok", data: { balances: [{ assetCode: "XLM", balance: "80" }] }, error: null };
});

// Verify the alert fires when balance crosses below 100
const alerts: string[] = [];
// createBalanceAlert internally uses streamAccount which the mock controls
```

## See also

- [Portfolio rebalancing](./06-portfolio-rebalancing.md) — trigger rebalancing from balance events
- [Real-time transaction SSE](../workflows.md) — Horizon SSE transport for lower latency
