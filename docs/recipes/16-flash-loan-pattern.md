# Recipe: Flash Loan Pattern

## Problem
You need to borrow a large amount of an asset, use it in an arbitrage or liquidation opportunity, and repay it within the same transaction. If the repayment fails, the entire transaction should revert. Doing this manually across multiple contract calls is complex and prone to errors.

## Solution
Use a Soroban smart contract to orchestrate the flash loan. The transaction will invoke a `borrow` function on the liquidity pool, which transfers the funds to your contract and immediately calls back into your contract's `receive_loan` method. You perform your logic (e.g., arbitrage) and then return the funds plus a fee.

## Code
```typescript
import { SorokitClient, SorokitResult } from "sorokit-core";
import { Keypair } from "@stellar/stellar-sdk";

export async function executeFlashLoan(
  client: SorokitClient,
  poolId: string,
  myContractId: string,
  signer: Keypair
): Promise<SorokitResult<string>> {
  // We invoke our custom contract which will internally initiate the flash loan
  return await client.soroban
    .contract(myContractId)
    .call("initiate_flash_loan")
    .withArgs({
      pool: poolId,
      amount: 1000000000n, // 1000 tokens
      asset: "USDC_CONTRACT_ID"
    })
    .send({ signer });
}
```

## Tests
```typescript
import { describe, it, expect } from "vitest";
import { executeFlashLoan } from "./flash-loan";
import { SorokitClient } from "sorokit-core";

describe("Flash Loan Pattern", () => {
  it("should successfully execute a profitable flash loan", async () => {
    // Setup mock client
    const client = new SorokitClient({ network: "testnet" });
    const result = await executeFlashLoan(client, "POOL_ID", "MY_CONTRACT", mockSigner);
    expect(result.ok).toBe(true);
  });
});
```

## Edge Cases
- **Insufficient Liquidity:** The pool may not have enough tokens to lend. Always check pool reserves before initiating.
- **Unprofitable Execution:** If the arbitrage doesn't yield enough to cover the loan fee, the transaction will revert. This is by design, protecting you from losses, but costs gas.
- **Reentrancy Attacks:** Ensure your callback function (`receive_loan`) cannot be called by unauthorized contracts.
