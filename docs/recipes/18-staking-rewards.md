# Recipe: Staking and Rewards

## Problem
Users want to lock up tokens in a protocol to earn yield over time. The application needs to handle deposits, calculating accrued rewards, and allowing users to claim or withdraw without causing rounding errors.

## Solution
Use a staking contract that tracks the user's share of a global reward pool using a "reward per token" accumulator. The client orchestrates `stake`, `withdraw`, and `claim` operations.

## Code
```typescript
import { SorokitClient, SorokitResult } from "sorokit-core";
import { Keypair } from "@stellar/stellar-sdk";

export async function stakeTokens(
  client: SorokitClient,
  stakingContractId: string,
  amount: bigint,
  signer: Keypair
): Promise<SorokitResult<string>> {
  return await client.soroban
    .contract(stakingContractId)
    .call("stake")
    .withArgs({ amount })
    .send({ signer });
}

export async function claimRewards(
  client: SorokitClient,
  stakingContractId: string,
  signer: Keypair
): Promise<SorokitResult<string>> {
  return await client.soroban
    .contract(stakingContractId)
    .call("claim_rewards")
    .send({ signer });
}
```

## Tests
```typescript
import { describe, it, expect } from "vitest";
import { stakeTokens, claimRewards } from "./staking-rewards";
import { SorokitClient } from "sorokit-core";

describe("Staking and Rewards", () => {
  it("allows a user to stake and then claim rewards", async () => {
    const client = new SorokitClient({ network: "testnet" });
    const stakeResult = await stakeTokens(client, "STAKE_ID", 1000n, mockSigner);
    expect(stakeResult.ok).toBe(true);
    
    // Simulate time passing
    const claimResult = await claimRewards(client, "STAKE_ID", mockSigner);
    expect(claimResult.ok).toBe(true);
  });
});
```

## Edge Cases
- **Precision Loss:** Ensure that the contract handles large numbers correctly when distributing rewards to prevent rounding to zero for small stakers.
- **Zero Stake:** Attempting to claim with zero staked tokens should safely return zero instead of failing.
- **Reward Pool Depletion:** The client should check if the reward pool is sufficiently funded before showing estimated APY.
