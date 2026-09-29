# sorokit-core DevTools extension

A Manifest V3 browser extension that adds a "sorokit" panel to your
browser's DevTools, showing sorokit-core SDK operations (wallet
connect/disconnect, account fetches, transaction build/submit, Soroban
invocations) in real time as your app runs: what ran, whether it succeeded,
how long it took, and the full error context on failure.

## How it works

The SDK side is `enableDevtoolsBridge()` (`sorokit-core/shared`): a
[`LogTransport`](../../src/shared/logger.ts) that forwards every structured
log record the SDK already produces to a `window` `CustomEvent`. This
extension does the rest:

```
page (your app + sorokit-core)
  -> window CustomEvent "sorokit:devtools"      [enableDevtoolsBridge()]
  -> page-hook.js (injected into the page's own JS context)
  -> window.postMessage                          (crosses the isolated-world boundary)
  -> content-script.js (isolated world)
  -> chrome.runtime.sendMessage
  -> background.js (service worker, routes by tab id)
  -> panel.js (the open DevTools panel for that tab)
```

Two hops (page-hook.js + content-script.js) are needed because a Manifest V3
content script runs in an isolated JS world and cannot see a `CustomEvent`
dispatched by the page's own script, even on the same `window` object — only
`postMessage` crosses that boundary.

## Try it locally

1. In your app, before creating a client:

   ```ts
   import { enableDevtoolsBridge } from "sorokit-core/shared";
   import { createSorokitClient } from "sorokit-core";

   if (process.env.NODE_ENV !== "production") {
     enableDevtoolsBridge();
   }
   const client = createSorokitClient({ network: "testnet", debug: true });
   ```

   `debug: true` (or an explicit `logLevel`) is required — the bridge only
   forwards what the logger actually emits, same as any other transport.

2. **Chrome**: open `chrome://extensions`, enable "Developer mode", click
   "Load unpacked", and select this `packages/devtools-extension` directory.
3. **Firefox**: open `about:debugging#/runtime/this-firefox`, click
   "Load Temporary Add-on...", and select `manifest.json` in this directory.
4. Open your app, open DevTools, and select the "sorokit" panel.

## What's covered today

- Wallet connect/disconnect (`wallet.connect`, `wallet.disconnect`)
- Account fetches (`account.get`, `account.getBalances`, etc.)
- Transaction build/submit/status/preview
- Soroban contract calls (`soroban.invoke`, `soroban.simulate`, etc.)
- Full error context on failure: `errorCode`, `errorMessage`, and whatever
  metadata the call site attached (public keys, transaction hashes, etc.)
- A duration per operation, computed by pairing each operation's `start`
  record with its matching completion record

## Known limitations

- **Cache hit/miss is not separately surfaced.** `withLogging` records don't
  currently carry a distinct "served from cache" flag, so the panel can't
  show it. A future change to `logger.ts`/`cacheInvalidation.ts` to attach
  `cacheHit: boolean` to the relevant operations' log context would let the
  panel surface it without any extension-side changes.
- **Only forwards what the client's `logLevel` allows through.** If a client
  is created with `debug: false` and no explicit `logLevel`, no log records
  (and therefore no panel events) are produced at all, by design.
- **Not published to the Chrome Web Store or addons.mozilla.org.** This
  ships as source, loaded unpacked/temporarily, per the "Try it locally"
  steps above. Store distribution (and MV3's stricter CSP for permanent
  installs) is a separate follow-up.
