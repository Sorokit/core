# Recipe: Payment with Memo (SEP-7 Style)

## Problem

Many exchanges and custodians require a **memo** to route deposits to the correct user account. Without a memo, the deposit goes to the exchange's pool address and gets lost. You need to:

1. Build a payment with the correct memo type (text, ID, or hash).
2. Validate the memo before submitting.
3. Handle memo requirements enforced by the destination account (SEP-7 / federation).

## Solution

Use the `memo` and `memoType` fields on `PaymentParams`. Add a `memoValidator` for custom format checks. For SEP-7 federation lookups, resolve the destination address first.

## Code

```ts
import {
  createSorokitClient,
  FreighterAdapter,
  resolveNetwork,
  submitTransaction,
} from "sorokit-core";
import { buildPaymentTransaction } from "sorokit-core/transaction";

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

// ── 2. Text memo (most common for exchange deposits) ─────────────────────────

const EXCHANGE_POOL_ADDRESS = "GDST…EXCHANGE";
const MY_USER_MEMO          = "user12345"; // your exchange account ID

const textMemoTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  publicKey,
  {
    destination: EXCHANGE_POOL_ADDRESS,
    amount:      "100",
    assetCode:   "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    memo:        MY_USER_MEMO,
    memoType:    "text",
  },
);

if (textMemoTx.status === "error") {
  console.error("Build failed:", textMemoTx.error.message);
  process.exit(1);
}

// ── 3. ID memo (for exchanges that assign numeric account IDs) ────────────────

const NUMERIC_MEMO_ID = "9876543210"; // must fit in uint64

const idMemoTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  publicKey,
  {
    destination: EXCHANGE_POOL_ADDRESS,
    amount:      "50",
    memo:        NUMERIC_MEMO_ID,
    memoType:    "id",
  },
);

if (idMemoTx.status === "error") {
  console.error("Build failed:", idMemoTx.error.message);
  process.exit(1);
}

// ── 4. Memo validation — enforce a specific format ────────────────────────────

const validatedTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  publicKey,
  {
    destination: EXCHANGE_POOL_ADDRESS,
    amount:      "25",
    memo:        MY_USER_MEMO,
    memoType:    "text",
    requireMemo: true,
    // Reject memos that don't start with "user"
    memoValidator: (memo) => {
      if (!memo.startsWith("user")) {
        return {
          status: "error",
          data: null,
          error: {
            code: "TX_BUILD_FAILED",
            message: `Memo "${memo}" must start with "user" for this exchange.`,
          },
        };
      }
      return { status: "ok", data: undefined, error: null };
    },
  },
);

if (validatedTx.status === "error") {
  console.error("Memo validation failed:", validatedTx.error.message);
  process.exit(1);
}

// ── 5. Using memoValidation policy ───────────────────────────────────────────

// "required" — the transaction is rejected if no memo is provided
const requiredMemoTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  publicKey,
  {
    destination: EXCHANGE_POOL_ADDRESS,
    amount:      "10",
    // memo intentionally omitted — will fail with TX_BUILD_FAILED
    memoValidation: "required",
  },
);

if (requiredMemoTx.status === "error") {
  console.log("Expected error — memo is required:", requiredMemoTx.error.message);
}

// "require_format" — enforce a regex pattern
const formattedMemoTx = await buildPaymentTransaction(
  horizonUrl,
  network.data,
  publicKey,
  {
    destination: EXCHANGE_POOL_ADDRESS,
    amount:      "10",
    memo:        "order-20260927-001",
    memoType:    "text",
    memoValidation: {
      rule:   "require_format",
      format: /^order-\d{8}-\d{3}$/,
      errorMessage: "Memo must match format: order-YYYYMMDD-NNN",
    },
  },
);

if (formattedMemoTx.status === "error") {
  console.error("Format check failed:", formattedMemoTx.error.message);
}

// ── 6. Sign and submit ────────────────────────────────────────────────────────

async function signAndSubmit(xdr: string): Promise<void> {
  const signed = await client.wallet.signTransaction(adapter, {
    transactionXdr: xdr,
    networkPassphrase,
  });

  if (signed.status === "error") {
    console.error("Sign failed:", signed.error.message);
    return;
  }

  const result = await submitTransaction(horizonUrl, network.data, signed.data);
  if (result.status === "ok") {
    console.log("Payment confirmed:", result.data.hash);
  } else {
    console.error("Submit failed:", result.error.message);
  }
}

await signAndSubmit(textMemoTx.data);
```

## Memo type reference

| Type | Use case | Constraints |
|------|----------|-------------|
| `text` | Exchange account identifier (string) | Max 28 bytes UTF-8 |
| `id`   | Numeric exchange user ID | Unsigned 64-bit integer (string) |
| `hash` | Payment reference / invoice hash | 32-byte hex string |
| `return` | Return payment reference | 32-byte hex string |

## SEP-7 deep link format

If you need to generate a SEP-7 payment URI for QR codes or wallet deep links:

```ts
const sep7Uri = [
  "web+stellar:pay",
  `?destination=${EXCHANGE_POOL_ADDRESS}`,
  `&amount=100`,
  `&asset_code=USDC`,
  `&asset_issuer=${USDC_ISSUER}`,
  `&memo=${encodeURIComponent(MY_USER_MEMO)}`,
  `&memo_type=text`,
  `&msg=${encodeURIComponent("Deposit to your exchange account")}`,
].join("");

console.log("SEP-7 URI:", sep7Uri);
// Open in Freighter, xBull, etc. — the wallet pre-fills all fields
```

## Hash memo for payment receipts

```ts
import { createHash } from "crypto";

// Generate a deterministic reference hash from an order ID
const orderId  = "order-20260927-001";
const hashHex  = createHash("sha256").update(orderId).digest("hex");

const hashMemoTx = await buildPaymentTransaction(horizonUrl, network.data, publicKey, {
  destination: EXCHANGE_POOL_ADDRESS,
  amount:      "75",
  memo:        hashHex,
  memoType:    "hash",
});
```

## Testing tips

```ts
import { buildPaymentTransaction } from "sorokit-core/transaction";

// Text memo too long (> 28 bytes)
const longMemo = "a".repeat(29);
const result = await buildPaymentTransaction(horizonUrl, network.data, "GAAA…", {
  destination: "GDST…",
  amount: "1",
  memo: longMemo,
  memoType: "text",
});
expect(result.status).toBe("error");
expect(result.error.message).toMatch("28 bytes");

// requireMemo with no memo provided
const noMemo = await buildPaymentTransaction(horizonUrl, network.data, "GAAA…", {
  destination: "GDST…",
  amount: "1",
  requireMemo: true,
});
expect(noMemo.status).toBe("error");
```

## See also

- [Batch payment with progress tracking](./05-batch-payment.md) — send many payments with memos
- [Path payment (cross-asset)](./12-path-payment.md) — cross-asset payments with memos
