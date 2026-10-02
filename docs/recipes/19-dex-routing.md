# Recipe: DEX Routing

## Problem
You want to swap Token A for Token C, but there is no direct liquidity pool. You need to route the trade through Token B (A -> B -> C) optimally to minimize slippage, executing it as a single atomic transaction.

## Solution
Use a router contract that accepts a "path" of tokens. The contract performs sequential swaps across multiple pools within a single invocation.

## Code
```typescript
import { SorokitClient, SorokitResult } from "sorokit-core";
import { Keypair } from "@stellar/stellar-sdk";

export async function executeRoutedSwap(
  client: SorokitClient,
  routerContractId: string,
  amountIn: bigint,
  minAmountOut: bigint,
  path: string[],
  signer: Keypair
): Promise<SorokitResult<string>> {
  return await client.soroban
    .contract(routerContractId)
    .call("swap_exact_tokens_for_tokens")
    .withArgs({
      amount_in: amountIn,
      amount_out_min: minAmountOut,
      path: path,
      to: signer.publicKey(),
      deadline: Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes
    })
    .send({ signer });
}
```

## Tests
```typescript
import { describe, it, expect } from "vitest";
import { executeRoutedSwap } from "./dex-routing";
import { SorokitClient } from "sorokit-core";

describe("DEX Routing", () => {
  it("executes a multi-hop swap within slippage bounds", async () => {
    const client = new SorokitClient({ network: "testnet" });
    const path = ["TOKEN_A", "TOKEN_B", "TOKEN_C"];
    const result = await executeRoutedSwap(client, "ROUTER", 100n, 90n, path, mockSigner);
    expect(result.ok).toBe(true);
  });
});
```

## Edge Cases
- **High Slippage:** If intermediate hops suffer from low liquidity, the final output might fall below `amount_out_min`. The transaction will revert.
- **Expired Deadline:** Network congestion might delay the transaction past the `deadline`. Provide reasonable timeframes.
- **Path Validation:** Ensure tokens in the path are valid Soroban token contracts, otherwise the transaction will fail at the first invalid hop.
