# Governance and voting (#686)

`src/integration/governance.ts` supports on-chain governance. You can list proposals, vote
on them, read voting power and track a proposal as it changes. Every function returns a
`SorokitResult` and never throws.

Stellar has no single protocol-level governance contract, so the module is
**provider-based**. The SDK handles validation, normalisation, errors and polling. A
`GovernanceProvider` handles transport and signing for a specific DAO, contract or indexer.

## Setup

```ts
import { configureGovernance, createHttpGovernanceProvider } from "sorokit-core/integration";

configureGovernance(
  createHttpGovernanceProvider({ endpoints: { testnet: "https://gov.example.org/testnet" } }),
  { network: "testnet" }, // default network
);
```

Each function also accepts `options.provider` and `options.network`, which override the
defaults for that one call.

## Usage

```ts
const proposals = await client.integration.getProposals("testnet");
// ok([{ id: 1, title: "Protocol upgrade", status: "active", tally: { yes: 10n, no: 2n, abstain: 0n } }])

const voted = await client.integration.voteOnProposal(1, "yes", { voter: "G..." });
// ok({ proposalId: 1, vote: "yes", voter: "G...", txHash: "…" })

const power = await client.integration.getVotingPower("G...");
// ok({ publicKey: "G...", network: "testnet", power: 5000n })

const tracker = await client.integration.trackProposal(1, {
  intervalMs: 15_000,
  onUpdate: (p) => console.log(p.status, p.tally),
});
tracker.data?.stop();
```

| Function | Behaviour |
|---|---|
| `getProposals(network?, { status? })` | Returns `active` proposals by default. `status: "all"` returns every proposal, or pass a specific status. |
| `getProposal(id)` | A single proposal. An unknown id gives `VALIDATION` ("not found"). |
| `voteOnProposal(id, vote, { voter? })` | `vote` is `yes`, `no` or `abstain` (case-insensitive). The proposal is re-read first and only `active` proposals accept votes. Returns the transaction hash. |
| `getVotingPower(publicKey)` | Voting weight as a `bigint`. The key must be a valid `G…` address. |
| `trackProposal(id, options)` | Polls (at least every 1 s; default 15 s) and calls `onUpdate` only when the status, tally or `endsAt` changes. Polling stops when the proposal reaches a terminal status (`passed`, `rejected`, `executed`, `cancelled`, `expired`), when you call `stop()`, when the `AbortSignal` fires, or after `maxConsecutiveErrors` (default 5) failed polls in a row. |

From the package root, `getVotingPower` is exported as **`getGovernanceVotingPower`**. The
older #456 helper already uses the root name `getVotingPower`. The unaliased name is
available from `sorokit-core/integration` and on `client.integration`.

## Errors

| Code | When |
|---|---|
| `INVALID_CONFIG` | No provider is configured and none was passed. |
| `INVALID_NETWORK` | The network is not `mainnet`, `testnet` or `futurenet`. |
| `INVALID_ADDRESS` | The public key or voter is invalid. |
| `VALIDATION` | Bad input (id, vote, options), a malformed provider response, an unknown proposal, or a vote on a proposal that isn't active. |
| `NETWORK_ERROR` | A provider or transport failure while reading. |
| `TX_SUBMIT_FAILED` | The vote submission failed. |

## HTTP provider contract

`createHttpGovernanceProvider({ endpoints, fetch?, timeoutMs?, headers? })` expects the
following endpoints under each network's base URL:

| Method | Path | Response |
|---|---|---|
| GET | `/proposals` | `Proposal[]` or `{ proposals: Proposal[] }` |
| GET | `/proposals/{id}` | `Proposal` (a 404 means not found) |
| POST | `/proposals/{id}/votes` | Body `{ vote, voter? }`; returns `{ txHash }` |
| GET | `/voting-power/{publicKey}` | `{ power }` (an integer or an integer string) |

`Proposal` is `{ id, title, status, description?, endsAt?, tally?: { yes, no, abstain } }`.
Path segments are URL-encoded, and requests time out after `timeoutMs` (default 10 s).
