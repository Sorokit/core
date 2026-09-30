# Lazy loading (#682)

Large, optional parts of the SDK can be loaded on demand with dynamic `import()`,
keeping them out of an application's initial bundle.

## Entry point

```ts
import { loadModule, isModuleLoaded, getLoadedModules } from "sorokit-core/lazy";
```

`sorokit-core/lazy` is a standalone entry (≈0.5 KiB gzip) that only contains the
module registry and `import()` stubs. The same functions are also re-exported from
the package root.

## Lazy-loadable modules

| Name            | Contents                                               |
|-----------------|--------------------------------------------------------|
| `soroban`       | Contract read/invoke/deploy, events, SAC helpers       |
| `integration`   | SEP-2 federation, SEP-6/10/24 anchors, DID, governance |
| `governance`    | Proposals, voting, voting power, tracking (#686)       |
| `keyManagement` | Mnemonic derivation, secret validation, key rotation   |
| `streaming`     | Persistent streaming cursor store                      |
| `privacy`       | Zero-knowledge proof helpers                           |
| `compliance`    | Audit trail and compliance reports                     |

`LAZY_MODULES` lists these names at runtime.

## API

| Function | Description |
|---|---|
| `loadModule(name)` | Dynamically imports the module once. Returns `SorokitResult<Module>`; never throws. Unknown names → `VALIDATION`; a failed import (e.g. a chunk that failed to download) → `INTERNAL`, with the original error as `cause`. |
| `preloadModules(names = LAZY_MODULES)` | Loads several modules in parallel, for example during idle time. |
| `isModuleLoaded(name)` | `true` once the module has finished loading. |
| `getLoadedModules()` | Loaded module names, in load order. |
| `loadSoroban()`, `loadIntegration()`, `loadKeyManagement()`, `loadGovernance()` | Typed shortcuts that resolve to the module itself (and reject on failure). |

```ts
const soroban = await loadModule("soroban");
if (soroban.status === "ok") {
  const result = await soroban.data.readContract(/* ... */);
}
```

### Guarantees

- Each module is imported at most once. Concurrent `loadModule` calls for the same name
  share one in-flight import.
- A failed import is not cached, so calling again retries it.
- Tracking (`isModuleLoaded`, `getLoadedModules`) only reports modules that loaded successfully.

Automatic, implicit loading (for example, loading `soroban` when a contract method is first
used) is intentionally out of scope. The application decides when to load.

## Bundle size

This was measured with esbuild using the same settings as `tsup.config.ts`: ESM, minified,
code splitting, and `@stellar/stellar-sdk` / `@walletconnect/sign-client` external.

| Import style | Initial load (gzip) | All chunks (gzip) |
|---|---|---|
| Eager `import * as …` of the seven modules above | 50.3 KiB | 50.3 KiB |
| `sorokit-core/lazy` + `loadModule(...)` | **0.5 KiB** | 54.7 KiB across 15 files, fetched only when requested |

`npm run size:check` enforces a 5 KiB gzip budget on `dist/lazy/index.mjs`. It also checks
that the entry doesn't reference the full root bundle.
