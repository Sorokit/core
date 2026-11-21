# Verification: contract upgrade cache invalidation (#840)

Issue #840 asked for Soroban contract-upgrade detection with invalidation of
caches holding stale state from before the upgrade (method signatures,
storage snapshots), naming a `ContractInvocationCache` as the expected
location.

No `ContractInvocationCache` class exists in this codebase. Instead, the same
functionality already ships on `main` (commit `f1e3185`, "feat(soroban):
detect contract upgrades and invalidate caches") under a different shape:

- `src/soroban/upgradeDetection.ts` exports `detectContractUpgrade`, which
  fetches the deployed Wasm, hashes it (`sha256`), and compares it against
  the previously recorded hash for that `contractId`. A hash change marks
  `upgraded: true` on the returned `UpgradeEvent`.
- On an upgrade, `invalidateContractCaches` clears every cache keyed to that
  contract: the method-metadata cache (`src/soroban/contractMetadata.ts`,
  both its external `SorokitCache` entry and its internal in-memory LRU),
  plus the `contract-schema`, `contract-read`, `contract-state`, and
  `contract-metadata` key prefixes.
- The function is exposed on the public client as
  `client.soroban.detectContractUpgrade(contractId, onUpgrade?, timeoutMs?)`
  (`src/client/createSorokitClient.ts:982`).
- `src/tests/upgradeDetection.test.ts` covers both the first-seen-hash case
  (no upgrade reported) and the hash-change case (upgrade reported, caches
  invalidated, `onUpgrade` callback invoked).

All three acceptance criteria in #840 are met:
- [x] Contract upgrades detected (by Wasm code-hash change)
- [x] Related caches invalidated on upgrade
- [x] Tests verify cache invalidation on contract update

No code change needed. `npx vitest run src/tests/upgradeDetection.test.ts`
passes against a clean `main` checkout.
