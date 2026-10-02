# Recipe: Bridge Integration

## Problem
You need to lock assets on the Stellar network and securely relay a message to mint or release equivalent assets on another chain (e.g., Ethereum), or vice-versa, ensuring atomicity and proof of burn/lock.

## Solution
Interact with a decentralized bridge contract. The recipe involves calling a `lock_and_bridge` function on Soroban, which emits an event. A relayer network listens to this event and processes the transaction on the destination chain.

## Code
```typescript
import { SorokitClient, SorokitResult } from "sorokit-core";
import { Keypair } from "@stellar/stellar-sdk";

export async function bridgeTokens(
  client: SorokitClient,
  bridgeContractId: string,
  destinationChain: string,
  destinationAddress: string,
  amount: bigint,
  signer: Keypair
): Promise<SorokitResult<string>> {
  return await client.soroban
    .contract(bridgeContractId)
    .call("lock_tokens")
    .withArgs({
      dest_chain: destinationChain,
      dest_address: destinationAddress,
      amount: amount
    })
    .send({ signer });
}
```

## Tests
```typescript
import { describe, it, expect } from "vitest";
import { bridgeTokens } from "./bridge-integration";
import { SorokitClient } from "sorokit-core";

describe("Bridge Integration", () => {
  it("locks tokens and emits bridge event", async () => {
    const client = new SorokitClient({ network: "testnet" });
    const result = await bridgeTokens(client, "BRIDGE", "ethereum", "0x123...", 50000n, mockSigner);
    expect(result.ok).toBe(true);
  });
});
```

## Edge Cases
- **Relayer Downtime:** If the relayer is offline, funds may be locked longer than expected. Provide a timeout or refund mechanism in the contract.
- **Malformed Destination Addresses:** Validate destination addresses format before locking to prevent permanent loss.
- **Slippage and Bridge Fees:** Bridge contracts usually deduct a fee. Account for this in the UI so users know exactly what they will receive.
