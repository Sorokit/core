# Recipe: NFT Minting (via contracts)

## Problem
You want to mint unique non-fungible tokens (NFTs) on Soroban, associating them with metadata (e.g., an IPFS hash) and assigning ownership to a user, ensuring that no two tokens share the same identifier.

## Solution
Interact with a Soroban NFT contract that implements a mint function. The contract tracks a monotonic counter or accepts a unique ID, storing the owner and metadata URI in contract state.

## Code
```typescript
import { SorokitClient, SorokitResult } from "sorokit-core";
import { Keypair } from "@stellar/stellar-sdk";

export async function mintNFT(
  client: SorokitClient,
  nftContractId: string,
  toAddress: string,
  metadataUri: string,
  signer: Keypair
): Promise<SorokitResult<string>> {
  return await client.soroban
    .contract(nftContractId)
    .call("mint")
    .withArgs({
      to: toAddress,
      uri: metadataUri
    })
    .send({ signer });
}
```

## Tests
```typescript
import { describe, it, expect } from "vitest";
import { mintNFT } from "./nft-minting";
import { SorokitClient } from "sorokit-core";

describe("NFT Minting", () => {
  it("mints an NFT with the correct metadata", async () => {
    const client = new SorokitClient({ network: "testnet" });
    const result = await mintNFT(client, "NFT_CONTRACT", mockSigner.publicKey(), "ipfs://bafy...", mockSigner);
    expect(result.ok).toBe(true);
  });
});
```

## Edge Cases
- **Authorization:** Only the contract admin or an authorized minter should be able to call the mint function, unless it is a public mint.
- **Supply Caps:** If the NFT collection has a maximum supply, attempting to mint past the cap will cause the transaction to revert.
- **Metadata Immutability:** Decide whether the `uri` can be updated later by the owner or if it's permanently sealed at mint time.
