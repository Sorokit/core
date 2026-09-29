# Architecture Decision Records

An ADR captures a significant design decision: the problem it responds to, the
options that were weighed, the decision itself, and its consequences. They
exist so a future contributor can understand *why* `sorokit-core` looks the
way it does, not just what it does — see [`../architecture.md`](../architecture.md)
for the latter.

An ADR is not updated in place once accepted. If a decision changes, write a
new ADR that supersedes it and links back to the one it replaces, so the
history of *why* stays intact.

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-001](./001-sorokitresult-no-throw-model.md) | SorokitResult No-Throw Model | Accepted |
| [ADR-002](./002-stateless-client-design.md) | Stateless Client Design | Accepted |
| [ADR-003](./003-wallet-adapter-pattern.md) | Wallet Adapter Pattern | Accepted |
| [ADR-004](./004-error-code-classification.md) | Error Code Classification | Accepted |
| [ADR-005](./005-streaming-polling-vs-sse.md) | Streaming: Polling by Default, Opt-in SSE for Transactions | Accepted |
| [ADR-006](./006-module-structure.md) | Module Structure (wallet, account, transaction, soroban, network, shared) | Accepted |
