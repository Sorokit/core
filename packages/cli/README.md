# sorokit CLI

A command-line tool for common Stellar/sorokit-core operations: inspecting
accounts and transactions, funding testnet accounts, sending payments, and
deploying Soroban contracts.

## Install / build

```bash
cd packages/cli
npm install
npm run build
```

This links against the local `sorokit-core` build (`file:../..`), so run
`npm run build` at the repo root first (`npm run build`, from `core/`) so
`dist/` exists there.

Run it directly with `node dist/index.js <command>`, or `npm link` to get a
global `sorokit` binary.

## Commands

| Command | Description |
| --- | --- |
| `sorokit account <address>` | Show account sequence, subentry count, and balances |
| `sorokit tx <hash>` | Show transaction status by hash |
| `sorokit fund <address>` | Fund a testnet/futurenet account via Friendbot |
| `sorokit pay <destination> <amount>` | Send a native XLM payment |
| `sorokit contract deploy <wasmPath>` | Deploy a compiled `.wasm` contract |
| `sorokit config [--set key=value]` | Show or set network/secret/endpoint config |

Every command accepts `--json` for machine-readable output.

## Configuration

Config is stored at `~/.sorokit/config.json` (mode `0600`, directory `0700`).

```bash
sorokit config --set network=testnet
sorokit config --set secret=S...     # required for `pay` and `contract deploy`
sorokit config --set horizonUrl=https://your-horizon.example
sorokit config --set rpcUrl=https://your-rpc.example
```

`sorokit config` (no `--set`) prints the current config with the secret
masked (`SABC...WXYZ`), never the full value. `pay`/`contract deploy` also
accept `--secret S...` to override the configured key for a single call
without writing it to disk.

## Try it against testnet

```bash
sorokit config --set network=testnet
sorokit fund GABC...            # fund a fresh testnet keypair
sorokit config --set secret=S...
sorokit account GABC...         # confirm the funded balance
sorokit pay GDEF... 25          # send 25 XLM
sorokit tx <hash-from-pay>      # look up the transaction you just sent
```

## Known limitations

- **`contract deploy` does not compute the resulting contract ID locally.**
  Stellar derives a deployed contract's address deterministically from the
  deployer account and salt, but no such helper exists yet in sorokit-core
  (`src/soroban/`) to reuse here, and this CLI didn't want to introduce its
  own possibly-wrong reimplementation of that derivation. The command
  prints the submission's transaction hash; look up the deployed contract
  ID from that hash via `sorokit tx <hash>` or a block explorer, or use
  `soroban contract deploy` from the official Soroban CLI when you need the
  ID printed directly. A follow-up that adds a `getDeployedContractId()`
  helper to `sorokit-core` itself would let this command report it inline.
- **Not tested against a real compiled Soroban `.wasm` contract in this
  environment** (no Rust/Soroban toolchain available here to produce one).
  `contract deploy`'s validation paths (missing file, invalid WASM magic
  bytes, oversized WASM) were verified directly; the full happy path
  reuses `sorokit-core`'s own `buildContractDeploy()`, which has its own
  test coverage in `src/tests/`.
- **Windows is untested.** The CLI uses only `node:fs`/`node:path`/`node:os`
  APIs with no shell-specific behavior, so it's expected to work, but
  wasn't run on Windows as part of this change.
