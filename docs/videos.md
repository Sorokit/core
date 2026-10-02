# Video Tutorial Series — sorokit-core

> **Status**: Scripts and code examples are complete and ready to record.
> No recording, narration, editing, or YouTube hosting has happened yet — those steps
> still need a human contributor. This document gives whoever picks up recording
> everything they need: scope, timestamped scripts, verbatim transcripts, working
> code examples, and a production checklist.
>
> Once a video is recorded and hosted, replace the `<!-- TODO: add YouTube link -->` placeholder
> in that tutorial's section with the real URL, update the status table below, and
> add the same link to the README.

---

## Status

| #  | Tutorial                                     | Target Length | Script       | Recorded |
|----|----------------------------------------------|:-------------:|:------------:|:--------:|
| 1  | Getting Started & Wallet Connection          | 2 min         | ✅ below     | ⬜        |
| 2  | Building and Submitting a Payment            | 2 min         | ✅ below     | ⬜        |
| 3  | Multi-Sig Approval (setup)                   | 4 min         | ✅ below     | ⬜        |
| 4  | Soroban Contract Read & Invoke               | 3 min         | ✅ below     | ⬜        |
| 5  | The SorokitResult No-Throw Model             | 2 min         | ✅ below     | ⬜        |
| 6  | Unit Testing with Sorokit Mocks              | 3 min         | ✅ below     | ⬜        |
| 7  | Deploying a Soroban Contract                 | 3 min         | ✅ below     | ⬜        |
| 8  | Debugging with DevTools & Diagnostics        | 3 min         | ✅ below     | ⬜        |
| 9  | Multi-Signature Workflows End-to-End         | 4 min         | ✅ below     | ⬜        |
| 10 | Error Handling Patterns & Recovery           | 2 min         | ✅ below     | ⬜        |

**Total planned runtime**: ~28 min across 10 videos.

---

## Transcript Format

Each tutorial section below contains two sub-sections:

- **Script** — timestamped bullet-point outline for the recorder; used to plan
  visuals and pacing. Each bullet says what is shown on screen and what is
  said aloud. Code blocks are what appears in the editor.
- **Transcript** — the verbatim text the narrator speaks. Written in the same
  order as the script. This is the transcript that gets posted as closed
  captions / subtitles on the hosted video. Adjust for anything said slightly
  differently during actual recording.

When editing the raw recording:

1. Export an `.srt` caption file from your editing tool (DaVinci Resolve, Premiere,
   CapCut, etc.) or generate one from the transcript with a tool like
   [whisper.cpp](https://github.com/ggerganov/whisper.cpp).
2. Upload the `.srt` alongside the video to YouTube (Creator Studio →
   Subtitles).
3. Place a copy of the final `.srt` at `docs/transcripts/tutorial-N.srt` and
   commit it so the repo has a durable archive independent of YouTube.

---

## Production Recording Checklist

Before pressing record, verify each item below. Post-production fixes are
expensive; most quality problems are preventable.

### Audio

- [ ] Using an **external USB or XLR microphone**, not the laptop's built-in mic.
      Recommended budget options: Blue Yeti, Audio-Technica ATR2100x, RØDE NT-USB Mini.
- [ ] Room is quiet — door closed, notifications silenced (macOS Do Not Disturb /
      Windows Focus Assist on), phone on airplane mode.
- [ ] Record a 10-second silence clip and check for hum, HVAC noise, or clock tick
      before starting the real recording.
- [ ] Speak at a consistent distance (~15 cm) from the mic.
- [ ] Target level: peaks at around –6 dBFS, average RMS around –18 dBFS. Use
      Audacity's Amplify or a compressor plug-in (e.g. ReaComp) to normalise after
      recording.
- [ ] Apply a gentle high-pass filter (≥ 80 Hz) to remove low-frequency rumble.

### Video / Screen Recording

- [ ] Resolution: **1080p minimum** (1920 × 1080). 4K source with 1080p export is
      acceptable if your machine handles it.
- [ ] Frame rate: **30 fps** (or 60 fps if your GPU allows). Do not mix frame rates
      within a series.
- [ ] Code editor font size: **≥ 18 px** so code is readable on a phone screen.
      Recommended: VS Code with the "Operator Mono" or "JetBrains Mono" font.
- [ ] Editor theme: high-contrast dark theme (One Dark Pro, Catppuccin Mocha, GitHub
      Dark). Avoid themes with very low contrast for viewers watching in bright light.
- [ ] Browser DevTools font size ≥ 16 px when shown.
- [ ] Hide personal information: close tabs, hide bookmarks bar, use a clean browser
      profile, hide the taskbar.
- [ ] Cursor: use a cursor-highlighter plug-in (macOS: Cursor Pro; Windows: Cursor
      Highlight) so viewers can follow mouse movement.

### Recommended Screen Recording Tools

| Tool | Platform | Notes |
|------|----------|-------|
| **OBS Studio** | Windows / macOS / Linux | Free, open-source. Best for high-quality local recording with separate audio/video tracks. |
| **Loom** | Windows / macOS (browser) | Quick-start for developer demos. Free tier has watermark; Pro removes it. |
| **Camtasia** | Windows / macOS | All-in-one record + edit. Good for beginners. Paid. |
| **ScreenFlow** | macOS only | Polished editor, easy export. Paid. |
| **DaVinci Resolve** | Windows / macOS / Linux | Free, professional-grade editing. Steeper learning curve. |

**Recommendation**: OBS Studio for capture + DaVinci Resolve for editing. Both free,
both produce broadcast-quality output.

### Before Each Take

- [ ] Run the full script at least **once** without recording. If it runs over the
      target time by more than 20%, cut content — do not talk faster.
- [ ] Close all git diffs / uncommitted changes in the editor so the starting state is
      clean.
- [ ] Pre-type any long import blocks off-screen so live typing during recording stays
      focused on the important parts.
- [ ] Have the Stellar testnet Friendbot URL (`https://friendbot.stellar.org`) open in
      a browser tab for tutorials that fund accounts.

### After Recording

- [ ] Export at H.264 (MP4) or H.265 (MP4/MOV). Target bitrate ≥ 8 Mbps for 1080p.
- [ ] Add a 3-second intro card with the tutorial title and number (a simple static
      slide is fine — no elaborate animation needed).
- [ ] Add a 5-second outro card with: "Full docs at docs.sorokit.dev", the GitHub
      repo link, and a subscribe prompt.
- [ ] Generate / export `.srt` captions and upload them.
- [ ] Upload to YouTube as **Unlisted** first, watch back the full video, then switch
      to Public.

---

## YouTube Hosting Guide

### Playlist organisation

Create a single playlist called **"sorokit-core — SDK Walkthroughs"** on the
official channel. Add all 10 videos in order (1–10). Set playlist visibility to
**Public**. In the playlist description include:

```
sorokit-core is a framework-agnostic TypeScript SDK for the Stellar blockchain.
This playlist walks you through the most common workflows — from connecting a
wallet to deploying Soroban smart contracts.

Full documentation: https://github.com/Sorokit/core
npm package: https://www.npmjs.com/package/sorokit-core
```

### SEO title template

```
[sorokit-core #N] {Tutorial Title} — Stellar SDK TypeScript Walkthrough
```

Example:
```
[sorokit-core #1] Getting Started & Wallet Connection — Stellar SDK TypeScript Walkthrough
```

### Description template (per video)

```
{1–2 sentence description of what the viewer will learn.}

⏱ Chapters
{paste the chapter timestamps here — see "Chapter markers" below}

📦 Code from this video
GitHub: https://github.com/Sorokit/core/tree/main/examples/tutorial-{N}-{slug}

📄 Transcript
Full transcript available in: docs/videos.md (link in pinned comment)

🔗 Links
• sorokit-core docs: https://github.com/Sorokit/core
• npm: https://www.npmjs.com/package/sorokit-core
• Issue tracker: https://github.com/Sorokit/core/issues
• Stellar Developer Docs: https://developers.stellar.org

👇 Playlist (all 10 videos)
<!-- TODO: add playlist URL once created -->

#stellar #blockchain #typescript #sdk #soroban #webdev
```

### Chapter markers

YouTube automatically creates chapter markers when the video description contains
timestamps in `MM:SS Description` format starting from `0:00`. Paste the script
timestamps into the description as-is. Example for Tutorial 1:

```
0:00 Introduction
0:20 Install sorokit-core
0:45 Create a Sorokit client
1:15 Connect a Freighter wallet
1:40 Discover installed wallets
```

### Tags (apply to every video)

```
stellar, soroban, typescript, sdk, blockchain, wallet, freighter, smart contracts,
web3, javascript, tutorial, walkthrough, sorokit, stellar development
```

---

## Example Repositories

Each tutorial has a matching minimal example project that viewers can clone and
run. The structure below is the agreed scaffold — contributors record the video
against this layout, then commit the finished code under `examples/`.

```
examples/
├── tutorial-01-wallet-connection/
│   ├── README.md          # "npm install && npm run dev" quick-start
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts       # entry point shown in the video
│       └── client.ts      # createSorokitClient factory helper
│
├── tutorial-02-payment/
│   ├── README.md
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       └── payment.ts     # buildPayment / sign / submit helpers
│
├── tutorial-03-multisig-setup/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── signers.ts     # buildSetOptions, co-signer key helpers
│
├── tutorial-04-soroban-invoke/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── contract.ts    # soroban.read / soroban.invoke wrappers
│
├── tutorial-05-result-model/
│   ├── README.md
│   ├── package.json
│   └── src/
│       └── index.ts       # demonstrates SorokitResult branching
│
├── tutorial-06-testing/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── payment.ts     # function-under-test
│       └── payment.test.ts# Vitest spec using mock client
│
├── tutorial-07-deploy-contract/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── deploy.ts      # buildDeployContract helpers
│
├── tutorial-08-debugging/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── diagnostics.ts # sorokitClient.diagnostics usage
│
├── tutorial-09-multisig-e2e/
│   ├── README.md
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── workflow.ts    # full end-to-end multi-sig flow
│
└── tutorial-10-error-recovery/
    ├── README.md
    ├── package.json
    └── src/
        ├── index.ts
        └── recovery.ts    # retry / fallback / error classification
```

Each `README.md` should include:

1. One-sentence description of what the example demonstrates.
2. Prerequisites (Node ≥ 18, a Freighter wallet extension, a funded testnet account).
3. `npm install` / `npm run dev` quick-start.
4. A link back to the corresponding tutorial video (`<!-- TODO: add YouTube link -->`).

---

## Tutorial 1 — Getting Started & Wallet Connection (2 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer installs `sorokit-core`, creates a Sorokit client pointing at
testnet, connects a Freighter browser wallet, and reads the connected public key — all
in under 2 minutes.

**Prerequisites shown on screen**: Node ≥ 18, a browser with the
[Freighter extension](https://www.freighter.app/) installed and set to testnet.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card: "Getting Started & Wallet Connection" | Intro line |
| 0:05 | Terminal, empty project folder | Install command |
| 0:20 | `src/client.ts` open in VS Code | Create client |
| 0:45 | `src/index.ts` open | Connect wallet |
| 1:15 | Highlight `.status` check in editor | Explain no-throw pattern |
| 1:40 | Browser DevTools console showing public key | Wallet discovery demo |
| 1:55 | Outro card | Close |

**Step 1 — Install (0:05)**

```bash
npm install sorokit-core
```

**Step 2 — Create a client (0:20)**

```ts
// src/client.ts
import { createSorokitClient } from "sorokit-core";
import type { SorokitClient } from "sorokit-core";

export function getClient(): SorokitClient {
  const result = createSorokitClient({ network: "testnet" });
  if (result.status === "error") {
    throw new Error(`Failed to initialise Sorokit: ${result.error.message}`);
  }
  return result.data;
}
```

**Step 3 — Connect Freighter (0:45)**

```ts
// src/index.ts
import { getClient } from "./client";

const client = getClient();

// Discover which wallets are installed in this browser
const discoveryResult = await client.wallet.discovery();
if (discoveryResult.status === "ok") {
  console.log("Installed wallets:", discoveryResult.data.map(w => w.id));
}

// Connect to Freighter specifically
const connectionResult = await client.wallet.connect("freighter");
if (connectionResult.status === "error") {
  console.error("Could not connect:", connectionResult.error.message);
} else {
  const { publicKey, network } = connectionResult.data;
  console.log("Connected public key:", publicKey);
  console.log("Active network:", network); // "testnet"
}
```

**Step 4 — Show no-throw branching (1:15)**  
Highlight that the result object has `.status === "ok"` or `"error"`, no `try/catch`
needed, and the type narrows automatically in TypeScript.

**Step 5 — Wallet discovery (1:40)**  
Show the console output listing `["freighter"]` (or whichever wallets are installed).
Explain `discovery()` returns only actually-installed wallets so you can render a
conditional UI.

---

### Transcript

> "This is the fastest path from zero to a connected Stellar wallet using sorokit-core.
> Let's start with the install. In your terminal, run npm install sorokit-core.
>
> With that done, create a file called client-dot-ts. We call createSorokitClient
> with the network set to testnet. That returns a SorokitResult — not a raw client
> directly, because the factory validates your config. If it fails, we throw early;
> if it succeeds, we pull the client out of result-dot-data.
>
> Now in index-dot-ts, we grab that client and call wallet-dot-discovery to see which
> wallet extensions the browser currently has installed. On my machine, that logs
> freighter.
>
> Then we call wallet-dot-connect passing the string freighter. The result comes back
> with a status of ok or error — no try/catch, no thrown exceptions. If it's ok, the
> data object has publicKey and network. We log both to the console.
>
> Notice the no-throw pattern: every operation returns a result you inspect, not an
> exception you catch. TypeScript narrows the type automatically on each branch, so
> inside the ok branch you know data exists, and inside error you know error exists.
>
> That's it — two files, zero configuration, and you have a type-safe wallet connection.
> In the next video we'll use this client to build and submit a real payment."

---

## Tutorial 2 — Building and Submitting a Payment (2 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer builds a native XLM payment transaction, signs it with the
connected wallet from Tutorial 1, submits it to testnet Horizon, and confirms the
transaction hash in a block explorer.

**Prerequisites**: Tutorial 1 complete; testnet account funded via
[Stellar Laboratory Friendbot](https://laboratory.stellar.org/#?network=test).

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:10 | Stellar Laboratory Friendbot tab | Fund source account |
| 0:25 | `src/payment.ts` in editor | Build transaction |
| 0:55 | Same file, sign step | Sign with wallet |
| 1:15 | Same file, submit + status | Submit and poll |
| 1:40 | Stellar Expert testnet explorer tab | Show confirmed tx |
| 1:55 | Outro card | Close |

**Step 1 — Fund the account (0:10)**

Open `https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>` to fund the testnet account.

**Step 2 — Build the payment (0:25)**

```ts
// src/payment.ts
import type { SorokitClient } from "sorokit-core";

export async function sendPayment(
  client: SorokitClient,
  sourcePublicKey: string,
): Promise<void> {
  // --- BUILD ---
  const buildResult = await client.transaction.buildPayment(sourcePublicKey, {
    destination: "GDEST7YQAFPLBFK3OOOH7QW4PXZQ5Y5GHKF3GGQXZQK7AAAAAAAAAA",
    amount: "10.5000000", // 7 decimal places — Stellar's native precision
    asset: "native",     // XLM; swap for { code: "USDC", issuer: "G..." } for other assets
    memo: "Tutorial payment — sorokit-core demo",
  });

  if (buildResult.status === "error") {
    console.error("Build failed:", buildResult.error.message);
    return;
  }

  // --- SIGN ---
  const signResult = await client.wallet.sign(buildResult.data);
  if (signResult.status === "error") {
    console.error("Sign failed:", signResult.error.message);
    return;
  }

  // --- SUBMIT ---
  const submitResult = await client.transaction.submit(signResult.data);
  if (submitResult.status === "error") {
    console.error("Submit failed:", submitResult.error.message);
    return;
  }

  const txHash = submitResult.data.hash;
  console.log("Submitted! Hash:", txHash);

  // --- POLL STATUS ---
  const statusResult = await client.transaction.getStatus(txHash);
  if (statusResult.status === "ok") {
    console.log("Transaction status:", statusResult.data.status); // "SUCCESS"
    console.log("Ledger:", statusResult.data.ledger);
  }
}
```

**Step 3 — Wire it up (1:15)**

```ts
// src/index.ts  (add after connection from Tutorial 1)
import { sendPayment } from "./payment";

if (connectionResult.status === "ok") {
  await sendPayment(client, connectionResult.data.publicKey);
}
```

**Step 4 — Block explorer (1:40)**  
Open `https://stellar.expert/explorer/testnet/tx/<HASH>` to show the confirmed
transaction, ledger number, and fee paid.

---

### Transcript

> "Every transaction in sorokit-core follows the same three-step pattern: build, sign,
> submit. There's no hidden state and no implicit signing — you always get a chance to
> inspect what you're about to submit before it goes anywhere.
>
> Before we send anything, let's fund our testnet account. I'll open Friendbot in the
> browser, paste the public key we got in Tutorial 1, and hit enter. After a second,
> the account has 10,000 XLM to experiment with.
>
> Back in the editor, I'll create payment-dot-ts. The build step calls
> client-dot-transaction-dot-buildPayment, passing the source public key and a
> destination, amount, and memo. The amount uses seven decimal places — that's Stellar's
> native precision. The result is a SorokitResult; if building fails — say, because
> the destination doesn't exist yet — the error surfaces here before anything hits the
> network.
>
> The sign step calls client-dot-wallet-dot-sign with the unsigned transaction envelope
> from buildResult-dot-data. Freighter will show a popup; the user approves, and the
> signed XDR comes back.
>
> Submit calls client-dot-transaction-dot-submit. Once that succeeds, we have a
> transaction hash. We then call getStatus with that hash to confirm the transaction
> landed in a ledger.
>
> Over in the browser, pasting the hash into Stellar Expert shows the confirmed
> transaction, the ledger it landed in, and the fee that was paid — all in a few
> seconds.
>
> Build, sign, submit. Same pattern for every transaction in the SDK."

---

## Tutorial 3 — Multi-Sig Approval (Setup) (4 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer raises the signing threshold on a testnet account so that two
keys are required before any transaction can be submitted, then verifies the threshold
with `client.account.get`.

**Note**: This tutorial covers the *setup* of a multi-sig account (changing account
options). Tutorial 9 covers the full end-to-end flow of collecting signatures from
multiple parties and submitting.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro — what multi-sig is |
| 0:30 | Stellar concept diagram (weights + thresholds) | Explain weights vs thresholds |
| 1:00 | `src/signers.ts` — build setOptions | Build the setOptions tx |
| 1:45 | Same file — sign and submit | Sign and submit |
| 2:30 | `client.account.get` call | Verify thresholds were applied |
| 3:20 | Stellar Expert — account tab | Show signers list on-chain |
| 3:45 | Preview Tutorial 9 | Tease end-to-end flow |
| 3:55 | Outro | Close |

**Step 1 — Concept (0:30)**

Explain on a whiteboard / slide:
- Every account has three thresholds: low, medium, high.
- Each signer has a weight (1 by default).
- A transaction only succeeds if the combined weight of its signers meets or exceeds
  the relevant threshold.
- We'll raise `medThreshold` to 2 and add a co-signer with weight 1, so any
  state-changing transaction needs both keys.

**Step 2 — Build setOptions (1:00)**

```ts
// src/signers.ts
import type { SorokitClient } from "sorokit-core";

export async function raiseThreshold(
  client: SorokitClient,
  primaryPublicKey: string,
  cosignerPublicKey: string,
): Promise<void> {
  // Build a SetOptions transaction that:
  //   - Adds a co-signer with weight 1
  //   - Raises the medium threshold to 2 (requires both keys for state changes)
  const buildResult = await client.transaction.buildSetOptions(primaryPublicKey, {
    signer: {
      ed25519PublicKey: cosignerPublicKey,
      weight: 1,
    },
    medThreshold: 2,
    highThreshold: 2,
  });

  if (buildResult.status === "error") {
    console.error("buildSetOptions failed:", buildResult.error.message);
    return;
  }

  // Sign with the primary key (this is still a single-sig operation —
  // the account isn't multi-sig until this transaction lands).
  const signResult = await client.wallet.sign(buildResult.data);
  if (signResult.status === "error") {
    console.error("Sign failed:", signResult.error.message);
    return;
  }

  const submitResult = await client.transaction.submit(signResult.data);
  if (submitResult.status === "ok") {
    console.log("Thresholds updated! Hash:", submitResult.data.hash);
  }
}
```

**Step 3 — Verify the new thresholds (2:30)**

```ts
// src/index.ts
import { getClient } from "./client";
import { raiseThreshold } from "./signers";

const client = getClient();
const connectionResult = await client.wallet.connect("freighter");
if (connectionResult.status !== "ok") return;

const primaryKey = connectionResult.data.publicKey;
const cosignerKey = "GCOSIGNER..."; // second account key — fund it on Friendbot too

await raiseThreshold(client, primaryKey, cosignerKey);

// Verify the thresholds
const accountResult = await client.account.get(primaryKey);
if (accountResult.status === "ok") {
  const { thresholds, signers } = accountResult.data;
  console.log("Med threshold:", thresholds.medThreshold); // 2
  console.log("Signers:", signers.map(s => `${s.key} (weight ${s.weight})`));
}
```

---

### Transcript

> "Multi-signature on Stellar isn't just adding a second key — it's a threshold
> system where each signer has a weight, and a transaction only processes when the
> combined weight of signatures meets the threshold for that operation's category.
>
> There are three thresholds: low, medium, and high. Things like setting options or
> making payments use the medium threshold by default. We're going to raise that to 2,
> meaning a single key with weight 1 can't authorise a payment on its own.
>
> In signers-dot-ts, we call buildSetOptions. We pass the primary public key as the
> source, and in the options object we add a signer — the co-signer's public key with
> weight 1 — and set medThreshold and highThreshold both to 2.
>
> Notice the important timing here: the account is still single-sig when we build and
> sign this SetOptions transaction. We only need the primary key to submit it. Once it
> lands, the account becomes multi-sig and future transactions will require both keys.
>
> We sign with client-dot-wallet-dot-sign, submit, and then verify by calling
> client-dot-account-dot-get on the primary key. The returned object has thresholds
> and signers fields. Medium threshold is now 2, and we can see both public keys in the
> signers array.
>
> Over in Stellar Expert, the account's Signers tab shows the same thing — two signers,
> threshold 2.
>
> In Tutorial 9, we'll walk end-to-end: building a payment that needs multi-sig,
> collecting both signatures, and submitting it. Stay tuned."

---

## Tutorial 4 — Soroban Contract Read & Invoke (3 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer reads state from a deployed Soroban contract without signing,
then invokes a state-changing method with a signed transaction.

**Prerequisites**: A Soroban contract already deployed on testnet (use the contract
from Tutorial 7, or any public testnet counter contract).

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro — read vs invoke |
| 0:25 | `src/contract.ts` — soroban.read | Read-only simulation |
| 1:15 | Same file — soroban.invoke | State-changing invoke |
| 2:00 | Highlight error surface pattern | Errors via SorokitResult |
| 2:25 | `soroban.getContractMethods` | Contract introspection |
| 2:50 | Outro | Close |

**Step 1 — Read-only call (0:25)**

```ts
// src/contract.ts
import { xdr } from "stellar-sdk";
import type { SorokitClient } from "sorokit-core";

const CONTRACT_ID = "CCONTRACTIDHERE..."; // replace with a real testnet contract ID

export async function readBalance(
  client: SorokitClient,
  readerPublicKey: string,
  accountPublicKey: string,
): Promise<bigint | null> {
  // Build the ScVal argument representing the address
  const addressScVal = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.AccountID.publicKeyTypeEd25519(
        Buffer.from(accountPublicKey, "base64"),
      ),
    ),
  );

  const result = await client.soroban.read({
    contractId: CONTRACT_ID,
    method: "balance",
    args: [addressScVal],
    publicKey: readerPublicKey,
  });

  if (result.status === "error") {
    console.error("Read failed:", result.error.code, result.error.message);
    return null;
  }

  // result.data is the return ScVal from the contract
  return result.data.value() as bigint;
}
```

**Step 2 — State-changing invoke (1:15)**

```ts
export async function transferTokens(
  client: SorokitClient,
  fromPublicKey: string,
  toPublicKey: string,
  amount: bigint,
  signFn: (xdr: string) => Promise<string>,
): Promise<string | null> {
  const fromScVal = xdr.ScVal.scvAddress(/* ... fromPublicKey as ScAddress ... */);
  const toScVal   = xdr.ScVal.scvAddress(/* ... toPublicKey as ScAddress ... */);
  const amountScVal = xdr.ScVal.scvI128(new xdr.Int128Parts({
    hi: BigInt(0),
    lo: amount,
  }));

  const result = await client.soroban.invoke(
    {
      contractId: CONTRACT_ID,
      method: "transfer",
      args: [fromScVal, toScVal, amountScVal],
    },
    signFn,
  );

  if (result.status === "error") {
    console.error("Invoke failed:", result.error.code, result.error.message);
    return null;
  }

  return result.data.hash;
}
```

**Step 3 — Contract introspection (2:25)**

```ts
// Discover callable methods without reading contract source
const methodsResult = await client.soroban.getContractMethods(CONTRACT_ID);
if (methodsResult.status === "ok") {
  console.log("Available methods:", methodsResult.data.map(m => m.name));
  // e.g. ["balance", "transfer", "approve", "allowance"]
}
```

---

### Transcript

> "With Soroban contracts, there's an important distinction: reading state is free and
> doesn't need a signature, because it's just a simulation that never lands on-chain.
> Invoking a method that changes state is a real transaction — it needs a signer, costs
> a fee, and goes into a ledger.
>
> In contract-dot-ts, the read path calls client-dot-soroban-dot-read. We pass the
> contract ID, the method name — balance — the arguments as Stellar ScVal objects, and
> a public key to run the simulation as. The result comes back with the return value
> as an ScVal. No signature, no fee, no ledger change.
>
> The invoke path calls client-dot-soroban-dot-invoke. We pass the same contract ID
> and method — this time transfer — and we also pass a signFn callback. The SDK builds
> the transaction, simulates it to get the resource footprint, assembles the final
> transaction, calls your signFn for a signature, and submits it — all in one call.
> The result gives you the transaction hash.
>
> Errors from contract execution — like insufficient balance, or a failed assertion
> inside the contract — surface through the same SorokitResult pattern. You check
> result-dot-error-dot-code, and there are specific SorokitErrorCode values for
> contract execution failures.
>
> Finally, if you're working with an unfamiliar contract, call
> client-dot-soroban-dot-getContractMethods with the contract ID. It returns an array
> of callable method signatures, so you know what arguments each method expects without
> reading the source code."

---

## Tutorial 5 — The SorokitResult No-Throw Model (2 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer understands why `sorokit-core` never throws for expected errors,
how to branch on `SorokitResult`, how to use error codes, and how to apply the
`recovery` field for generic retry logic.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro — why no-throw |
| 0:15 | Code: SorokitResult type | Shape of the result type |
| 0:40 | Code: branching on status | Status branching |
| 1:00 | Code: SorokitErrorCode switch | Error code example |
| 1:25 | Code: recovery.retryable | Generic retry |
| 1:50 | Link to ADR | Where to read the rationale |

**Step 1 — The result type (0:15)**

```ts
import type { SorokitResult, SorokitError, SorokitErrorCode } from "sorokit-core";

// Every SDK function returns SorokitResult<T>:
// { status: "ok";    data: T }  | { status: "error"; error: SorokitError }
//
// SorokitError shape:
// {
//   code: SorokitErrorCode;    // machine-readable enum value
//   message: string;           // human-readable explanation
//   category: "network" | "validation" | "wallet" | "contract" | "unknown";
//   recovery?: {
//     retryable: boolean;
//     suggestion: string;      // human-readable recovery hint
//   };
// }
```

**Step 2 — Status branching (0:40)**

```ts
import { SorokitErrorCode } from "sorokit-core";

const result = await client.account.get(publicKey);

if (result.status === "error") {
  switch (result.error.code) {
    case SorokitErrorCode.ACCOUNT_NOT_FOUND:
      console.log("Account doesn't exist yet — fund it via Friendbot.");
      break;

    case SorokitErrorCode.NETWORK_TIMEOUT:
      console.log("Horizon is slow — try again shortly.");
      break;

    default:
      console.error("Unexpected error:", result.error.message);
  }
} else {
  // TypeScript knows result.data is AccountRecord here
  console.log("Sequence number:", result.data.sequenceNumber);
}
```

**Step 3 — Generic retry using recovery (1:25)**

```ts
async function withRetry<T>(
  operation: () => Promise<SorokitResult<T>>,
  maxAttempts = 3,
): Promise<SorokitResult<T>> {
  let lastResult: SorokitResult<T> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await operation();

    if (lastResult.status === "ok") return lastResult;

    const { retryable } = lastResult.error.recovery ?? { retryable: false };
    if (!retryable) {
      console.error(`Non-retryable error on attempt ${attempt}:`, lastResult.error.message);
      return lastResult;
    }

    console.warn(`Attempt ${attempt} failed (retryable), waiting before retry...`);
    await new Promise(r => setTimeout(r, 1000 * attempt)); // exponential-ish back-off
  }

  return lastResult!;
}

// Usage:
const result = await withRetry(() => client.transaction.submit(signedEnvelope));
```

---

### Transcript

> "sorokit-core has a design rule: it never throws for an expected failure. Instead,
> every function returns a SorokitResult — either status ok with a data field, or
> status error with an error field. TypeScript narrows the type automatically on each
> branch, so you get full type safety without any try/catch.
>
> The error object has four fields. Code is a SorokitErrorCode enum value —
> machine-readable so you can switch on it. Message is a human-readable explanation.
> Category classifies the source: network, validation, wallet, contract, or unknown.
> And recovery is an optional object that tells you whether it's safe to retry and
> gives a human-readable suggestion.
>
> In practice, you handle errors with a simple if on status. For specific cases —
> like account not found — you switch on the error code. For generic infrastructure
> errors you can use the recovery-dot-retryable flag to decide whether to retry at all.
>
> The withRetry helper here shows a simple exponential back-off loop. It works for any
> SDK operation because SorokitResult is consistent across all of them — wallet,
> transaction, Soroban, account — they all follow the same shape.
>
> For a full write-up of why this design was chosen over exceptions, see the ADR at
> docs/adr/001-sorokitresult-no-throw-model.md."

---

## Tutorial 6 — Unit Testing with Sorokit Mocks (3 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer writes a Vitest unit test for application code that uses
`sorokit-core` — without hitting the real testnet — using the mock client helpers
from `sorokit-core/testing`.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:20 | Terminal: `npm install vitest` | Test runner setup |
| 0:35 | `src/payment.ts` — function under test | Show the function |
| 1:00 | `src/payment.test.ts` — mock client import | Mock helpers |
| 1:30 | Same file — mock wallet.sign | Mocking sign |
| 2:00 | Same file — assertion | Assert result shape |
| 2:30 | `npm run test:e2e` mention | E2E tests |
| 2:50 | Outro | Close |

**Step 1 — Function under test (0:35)**

```ts
// src/payment.ts
import type { SorokitClient, SorokitResult } from "sorokit-core";

export async function runPayment(
  client: SorokitClient,
  source: string,
  destination: string,
  amount: string,
): Promise<SorokitResult<{ hash: string }>> {
  const buildResult = await client.transaction.buildPayment(source, {
    destination,
    amount,
    asset: "native",
  });
  if (buildResult.status === "error") return buildResult;

  const signResult = await client.wallet.sign(buildResult.data);
  if (signResult.status === "error") return signResult;

  return client.transaction.submit(signResult.data);
}
```

**Step 2 — Vitest spec with mocked client (1:00)**

```ts
// src/payment.test.ts
import { describe, it, expect, vi } from "vitest";
import { createMockSorokitClient, okResult, errorResult } from "sorokit-core/testing";
import { SorokitErrorCode } from "sorokit-core";
import { runPayment } from "./payment";

describe("runPayment", () => {
  const SOURCE = "GSOURCE...";
  const DEST   = "GDEST...";

  it("returns the transaction hash on success", async () => {
    const client = createMockSorokitClient({
      transaction: {
        buildPayment: vi.fn().mockResolvedValue(okResult({ xdr: "UNSIGNED_XDR" })),
        submit:       vi.fn().mockResolvedValue(okResult({ hash: "ABC123" })),
      },
      wallet: {
        sign: vi.fn().mockResolvedValue(okResult({ xdr: "SIGNED_XDR" })),
      },
    });

    const result = await runPayment(client, SOURCE, DEST, "10.0000000");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.hash).toBe("ABC123");
    }
    expect(client.wallet.sign).toHaveBeenCalledWith({ xdr: "UNSIGNED_XDR" });
  });

  it("returns an error when signing is rejected", async () => {
    const client = createMockSorokitClient({
      transaction: {
        buildPayment: vi.fn().mockResolvedValue(okResult({ xdr: "UNSIGNED_XDR" })),
      },
      wallet: {
        sign: vi.fn().mockResolvedValue(
          errorResult(SorokitErrorCode.WALLET_USER_REJECTED, "User rejected the request"),
        ),
      },
    });

    const result = await runPayment(client, SOURCE, DEST, "10.0000000");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.WALLET_USER_REJECTED);
    }
  });
});
```

**Step 3 — Running the tests (2:30)**

```bash
# Unit tests (no network)
npm test

# Live testnet E2E (optional — self-funds via Friendbot, no secrets needed)
npm run test:e2e
```

---

### Transcript

> "You don't need a real testnet connection to test code that uses sorokit-core. The
> package ships a testing sub-module at sorokit-core/testing that provides a mock
> client factory and result builders.
>
> Here's the function we want to test — runPayment. It chains buildPayment, sign, and
> submit, short-circuiting on any error. Simple enough, but it has three branches to
> cover.
>
> In the test file, we import createMockSorokitClient from sorokit-core/testing.
> We pass it a partial implementation — only the methods we want to stub. Everything
> else throws NotImplementedError, which helps catch accidental calls.
>
> The okResult and errorResult helpers create properly-shaped SorokitResult objects so
> our mocks return the same type as the real SDK.
>
> In the first test, all three stubs succeed. We assert the result is ok and the hash
> matches. We also check that wallet-dot-sign was called with the XDR that came from
> buildPayment — that verifies the chain passes data correctly.
>
> In the second test, sign rejects with WALLET_USER_REJECTED. We assert the result is
> error and the code matches. Submit should never be called — and because our mock
> doesn't define it, any accidental call would throw, which is exactly the safety net
> we want.
>
> For the rare case where you need real-network verification — like testing Soroban
> contract interactions — the SDK's own E2E suite at npm run test:e2e spins up a
> Friendbot-funded account automatically. No secrets or config files needed."

---

## Tutorial 7 — Deploying a Soroban Contract (3 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer compiles a minimal Soroban contract to `.wasm`, deploys it to
testnet using `sorokit-core`, and reads from it to confirm it's live.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:20 | Terminal: `cargo build --target wasm32-unknown-unknown --release` | Compile contract |
| 0:45 | `src/deploy.ts` — buildDeployContract | Upload + create + init |
| 1:30 | Sign and submit | Sign and submit |
| 2:00 | Extract contract ID | Get the contract ID |
| 2:15 | Immediate read call | Confirm it's live |
| 2:50 | Outro | Close |

**Step 1 — Compile (0:20)**

```bash
# From inside the Soroban contract project
cargo build --target wasm32-unknown-unknown --release
# Output: target/wasm32-unknown-unknown/release/my_contract.wasm
```

**Step 2 — Deploy with sorokit-core (0:45)**

```ts
// src/deploy.ts
import * as fs from "fs";
import type { SorokitClient } from "sorokit-core";

export async function deployContract(
  client: SorokitClient,
  deployerPublicKey: string,
  signFn: (xdr: string) => Promise<string>,
): Promise<string | null> {
  const wasmBuffer = fs.readFileSync(
    "target/wasm32-unknown-unknown/release/my_contract.wasm",
  );

  // buildDeployContract handles three Soroban transactions internally:
  //   1. Upload the WASM to the ledger (UploadContractWasm)
  //   2. Create the contract instance (CreateContract)
  //   3. Invoke the constructor (if your contract has __init)
  const deployResult = await client.transaction.buildDeployContract(
    deployerPublicKey,
    {
      wasm: wasmBuffer,
      constructorArgs: [], // pass ScVal[] if your contract has an __init function
    },
  );

  if (deployResult.status === "error") {
    console.error("Deploy build failed:", deployResult.error.message);
    return null;
  }

  // Sign each transaction in sequence
  let envelopeXdr = deployResult.data.envelopeXdr;
  for (const tx of deployResult.data.transactions) {
    const signResult = await client.wallet.sign(tx);
    if (signResult.status === "error") {
      console.error("Sign failed:", signResult.error.message);
      return null;
    }
    const submitResult = await client.transaction.submit(signResult.data);
    if (submitResult.status === "error") {
      console.error("Submit failed:", submitResult.error.message);
      return null;
    }
  }

  const contractId = deployResult.data.contractId;
  console.log("Contract deployed! ID:", contractId);
  return contractId;
}
```

**Step 3 — Confirm live (2:15)**

```ts
// src/index.ts
const contractId = await deployContract(client, publicKey, signFn);
if (!contractId) return;

// Immediately read from the contract to confirm it's live
const readResult = await client.soroban.read({
  contractId,
  method: "get_count", // example method on a counter contract
  args: [],
  publicKey,
});

if (readResult.status === "ok") {
  console.log("Initial count:", readResult.data.value()); // 0
  console.log("Contract is live and responding correctly.");
}
```

---

### Transcript

> "Deploying a Soroban contract from a compiled wasm file is a three-transaction
> process on Stellar: first you upload the wasm bytes to the ledger, then you create
> a contract instance from them, and optionally you invoke the constructor. sorokit-core
> wraps all three steps behind a single buildDeployContract call.
>
> Start by compiling your Rust contract with cargo build targeting wasm32. The output
> wasm goes into target/wasm32-unknown-unknown/release.
>
> In deploy-dot-ts, we read the wasm file into a Buffer and pass it to
> buildDeployContract along with the deployer's public key and any constructor
> arguments as ScVal arrays. If your contract has no constructor, pass an empty array.
>
> The return value includes a transactions array — typically two or three transactions
> in sequence — and the final contractId. We iterate the transactions, sign each one,
> and submit each one before moving to the next. Each submit waits for the ledger to
> confirm before we proceed.
>
> Once all three transactions land, we immediately do a read call to confirm the
> contract is live and returning sensible values. If that read succeeds, the deployment
> is complete and you can start interacting with the contract via the same
> soroban-dot-invoke path we covered in Tutorial 4."

---

## Tutorial 8 — Debugging with DevTools & Sorokit Diagnostics (3 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer learns how to use `sorokit-core`'s built-in diagnostics mode,
how to read structured error output, and how to use browser DevTools (Network tab,
Console) to trace SDK calls through to Horizon and Soroban RPC.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:15 | `createSorokitClient` with debug option | Enable diagnostics |
| 0:40 | Console showing structured log output | Read diagnostic logs |
| 1:10 | DevTools Network tab — Horizon request | Inspect raw HTTP request |
| 1:40 | DevTools Network tab — Horizon error response | Map HTTP error to SorokitErrorCode |
| 2:10 | `client.diagnostics.getLastError()` | Programmatic access |
| 2:40 | Tips: Stellar Lab simulation | Test contract args before code |
| 2:55 | Outro | Close |

**Step 1 — Enable diagnostics (0:15)**

```ts
// src/client.ts
import { createSorokitClient } from "sorokit-core";

const result = createSorokitClient({
  network: "testnet",
  debug: true,           // enables verbose structured logging to console
  logLevel: "verbose",   // "error" | "warn" | "info" | "verbose"
});

if (result.status === "error") throw new Error(result.error.message);

const client = result.data;
```

When `debug: true`, every SDK call logs a structured entry to `console.debug`:

```json
{
  "ts": "2026-09-29T23:00:00.000Z",
  "module": "transaction",
  "op": "buildPayment",
  "durationMs": 42,
  "result": "ok",
  "meta": { "source": "GSOURCE...", "destination": "GDEST..." }
}
```

**Step 2 — Reading diagnostic logs (0:40)**

The console groups SDK calls by module. Look for:

- `result: "error"` entries — these show `errorCode` and `errorMessage`.
- `durationMs` outliers — a buildPayment taking > 500 ms usually indicates Horizon
  latency or a misconfigured network URL.
- `module: "soroban"` entries with `simulationUnits` — these show the resource
  footprint used by contract simulations.

**Step 3 — DevTools Network tab (1:10)**

Horizon REST API calls are plain HTTP. In Chrome DevTools:

1. Open **Network** tab, filter by `horizon` or `soroban-rpc`.
2. Look for the failed request (red). Click it.
3. **Headers** tab: check the request URL — confirm it points to
   `https://horizon-testnet.stellar.org` (not mainnet!).
4. **Response** tab: Horizon returns structured JSON errors:
   ```json
   {
     "status": 400,
     "title": "Transaction Failed",
     "extras": {
       "result_codes": {
         "transaction": "tx_failed",
         "operations": ["op_underfunded"]
       }
     }
   }
   ```
   The `result_codes.operations[0]` value maps directly to a `SorokitErrorCode`:
   `op_underfunded` → `SorokitErrorCode.INSUFFICIENT_FUNDS`.

**Step 4 — Programmatic last-error access (2:10)**

```ts
// After any failed operation, inspect the full diagnostic context
const lastError = client.diagnostics.getLastError();
if (lastError) {
  console.log("Error code:", lastError.code);
  console.log("Raw Horizon response:", lastError.rawResponse);
  console.log("Request URL:", lastError.requestUrl);
  console.log("Request body:", lastError.requestBody);
}

// You can also subscribe to all errors as a stream
client.diagnostics.onError(err => {
  // Send to your error monitoring service (Sentry, Datadog, etc.)
  reportToSentry(err);
});
```

**Step 5 — Stellar Lab for contract debugging (2:40)**

Before writing code, test contract arguments in
[Stellar Lab → Contract Explorer](https://laboratory.stellar.org/#contract-explorer).
Paste the contract ID, choose a method, and simulate the call with different argument
values. This catches argument shape errors before they become SDK bugs.

---

### Transcript

> "When something goes wrong with a Sorokit SDK call, there are three places to look:
> the SDK's structured diagnostic logs, the raw HTTP calls in DevTools, and the
> programmatic diagnostics API. Let's cover all three.
>
> First, enable diagnostics by adding debug: true and logLevel: verbose to
> createSorokitClient. This activates structured console-dot-debug logging for every
> SDK operation. Each log entry tells you which module, which operation, how long it
> took in milliseconds, and whether it succeeded.
>
> In the console, filter for result: error. That entry will have errorCode and
> errorMessage alongside the module and operation. If you see a durationMs over 500
> milliseconds, that's a network latency issue — check your Horizon URL.
>
> For deeper inspection, open the Network tab in DevTools and filter for
> horizon-testnet. Find the failing request — it'll be red. The Response tab shows
> the raw Horizon JSON, including result_codes. The operations array inside
> result_codes maps one-to-one to SorokitErrorCode values, so op_underfunded becomes
> SorokitErrorCode-dot-INSUFFICIENT_FUNDS.
>
> If you need this data programmatically — for example to send to an error monitor
> like Sentry — call client-dot-diagnostics-dot-getLastError. It returns the full
> context: the error code, the raw response body, the request URL, and the request
> body. There's also an onError subscription if you want to hook every error as it
> happens.
>
> Finally, for Soroban contract issues specifically: before writing any SDK code,
> test your argument shapes in Stellar Lab's Contract Explorer. Paste your contract
> ID, pick the method, and run a simulation in the browser. If it fails there, the
> arguments are wrong — fix them in the UI before touching your TypeScript."

---

## Tutorial 9 — Multi-Signature Workflows End-to-End (4 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: Given a multi-sig account set up in Tutorial 3, the viewer builds a payment
that requires two signatures, collects each signature separately (simulating a
co-signer on a different machine), verifies the threshold is met, and submits.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:20 | Diagram: multi-sig flow | Explain the coordination problem |
| 0:50 | `src/workflow.ts` — buildMultiSigEnvelope | Wrap unsigned tx in envelope |
| 1:30 | Same file — collectSignature (signer 1) | First signature |
| 2:10 | Same file — collectSignature (signer 2) | Second signature |
| 2:50 | Same file — thresholdMet check | Verify threshold |
| 3:15 | Submit once threshold met | Submit |
| 3:40 | Stellar Expert — multi-sig tx | Show confirmed tx with two signers |
| 3:55 | Outro | Close |

**Step 1 — Build the multi-sig envelope (0:50)**

```ts
// src/workflow.ts
import {
  buildMultiSigEnvelope,
  collectSignature,
} from "sorokit-core/transaction";
import type { SorokitClient } from "sorokit-core";

export async function runMultiSigPayment(
  client: SorokitClient,
  sourcePublicKey: string,
  cosignerPublicKey: string,
  signAsPrimary:  (xdr: string) => Promise<string>,
  signAsCosigner: (xdr: string) => Promise<string>,
): Promise<string | null> {
  // 1. Build the payment (needs multi-sig because account threshold is 2)
  const buildResult = await client.transaction.buildPayment(sourcePublicKey, {
    destination: "GDEST7YQAFPLBFK3OOOH7QW4PXZQ5Y5GHKF3GGQXZQK7AAAAAAAAAA",
    amount: "25.0000000",
    asset: "native",
    memo: "Multi-sig payment demo",
  });

  if (buildResult.status === "error") {
    console.error("Build failed:", buildResult.error.message);
    return null;
  }

  // 2. Wrap in a multi-sig envelope — declares expected signers and threshold
  const networkPassphrase = "Test SDF Network ; September 2015";
  const envelopeResult = buildMultiSigEnvelope(
    buildResult.data,
    networkPassphrase,
    {
      signers: [
        { publicKey: sourcePublicKey,   weight: 1 },
        { publicKey: cosignerPublicKey, weight: 1 },
      ],
      threshold: 2,
    },
  );

  if (envelopeResult.status === "error") {
    console.error("Envelope build failed:", envelopeResult.error.message);
    return null;
  }

  let envelope = envelopeResult.data;
  console.log("Threshold met?", envelope.thresholdMet); // false — no sigs yet

  // 3. Collect signature from the primary signer
  const step1 = await collectSignature(envelope, sourcePublicKey, signAsPrimary);
  if (step1.status === "error") {
    console.error("Primary sign failed:", step1.error.message);
    return null;
  }
  envelope = step1.data;
  console.log("After primary sig — threshold met?", envelope.thresholdMet); // false (weight 1 < threshold 2)

  // 4. Collect signature from the co-signer
  //    (In a real workflow this XDR would be serialised and sent to the co-signer
  //    via email, a coordination API, or a multi-sig service like Lobstr Vaults)
  const step2 = await collectSignature(envelope, cosignerPublicKey, signAsCosigner);
  if (step2.status === "error") {
    console.error("Co-signer sign failed:", step2.error.message);
    return null;
  }
  envelope = step2.data;
  console.log("After co-signer sig — threshold met?", envelope.thresholdMet); // true

  if (!envelope.thresholdMet) {
    console.error("Threshold not met — cannot submit.");
    return null;
  }

  // 5. Submit the fully-signed envelope
  const submitResult = await client.transaction.submit({
    xdr: envelope.envelopeXdr,
  });

  if (submitResult.status === "error") {
    console.error("Submit failed:", submitResult.error.message);
    return null;
  }

  console.log("Multi-sig payment submitted! Hash:", submitResult.data.hash);
  return submitResult.data.hash;
}
```

**Step 2 — Serialise the partial envelope for out-of-band signing (2:10)**

In a real production workflow, the co-signer is on a different machine. After
collecting the primary signature, serialise the partial envelope:

```ts
// Serialise after step1 — send this to the co-signer
const partialXdr = step1.data.envelopeXdr;
// → email it, POST it to your backend, or push it to Lobstr Vaults

// On the co-signer's machine, deserialise and continue:
import { deserialiseMultiSigEnvelope } from "sorokit-core/transaction";
const resumedEnvelope = deserialiseMultiSigEnvelope(partialXdr, {
  signers: [/* same signer config */],
  threshold: 2,
});
const step2 = await collectSignature(resumedEnvelope.data, cosignerPublicKey, signAsCosigner);
```

---

### Transcript

> "In Tutorial 3 we set up a multi-sig account — raised the threshold to 2, added a
> co-signer. Now let's use it: build a payment, collect two signatures, verify the
> threshold is met, and submit.
>
> The coordination problem with multi-sig is: how do you get two signatures from two
> different keys, possibly on different machines, without one of them submitting before
> both have signed? sorokit-core's answer is the multi-sig envelope — a wrapper around
> the unsigned transaction that tracks which signers have signed, what their weights
> are, and whether the threshold is met. Nothing gets submitted until you explicitly
> call submit and thresholdMet is true.
>
> In workflow-dot-ts, we first build the payment exactly as in Tutorial 2. Then we
> call buildMultiSigEnvelope, passing the unsigned transaction, the network
> passphrase, and a signers array with each key and its weight. After this call,
> thresholdMet is false — no signatures yet.
>
> We call collectSignature with the envelope, the primary key's public key, and a
> sign function. The result is a new envelope with one signature applied. Threshold
> is still false — weight 1 out of 2 needed.
>
> We call collectSignature again for the co-signer. Now thresholdMet is true —
> combined weight is 2, matching the threshold.
>
> In a real app, after the primary signature you'd serialise the partial envelope XDR
> — envelope-dot-envelopeXdr — and send it to the co-signer out-of-band: email, a
> backend API, or a service like Lobstr Vaults. The co-signer deserialises it with
> deserialiseMultiSigEnvelope and continues from there.
>
> Once thresholdMet is true, we call client-dot-transaction-dot-submit with the
> envelope XDR. In Stellar Expert you can see the confirmed transaction has two
> signatures in the envelope — the full end-to-end multi-sig flow."

---

## Tutorial 10 — Error Handling Patterns & Recovery (2 min)

<!-- TODO: add YouTube link once recorded -->

**Goal**: The viewer sees three concrete error-handling patterns in real application
code: user-facing messages, category-based fallback logic, and the `recovery`
field for automatic retry with exponential back-off.

---

### Script

| Timestamp | Visual / Action | Narration cue |
|-----------|----------------|---------------|
| 0:00 | Title card | Intro |
| 0:10 | Code: user-facing error message | Pattern 1 — user messages |
| 0:35 | Code: category switch | Pattern 2 — category fallback |
| 1:05 | Code: withRetry helper | Pattern 3 — automatic retry |
| 1:35 | Highlight retryable vs non-retryable errors | Distinguish error classes |
| 1:50 | Outro | Close |

**Pattern 1 — User-facing messages (0:10)**

```ts
// src/recovery.ts
import { SorokitErrorCode } from "sorokit-core";
import type { SorokitError } from "sorokit-core";

/** Convert a SorokitError into a message safe to show the end user. */
export function toUserMessage(error: SorokitError): string {
  switch (error.code) {
    case SorokitErrorCode.ACCOUNT_NOT_FOUND:
      return "This account doesn't exist on the Stellar network yet. Fund it first.";

    case SorokitErrorCode.INSUFFICIENT_FUNDS:
      return "Your account doesn't have enough XLM to cover this transaction.";

    case SorokitErrorCode.WALLET_USER_REJECTED:
      return "You declined the transaction in your wallet. Try again when you're ready.";

    case SorokitErrorCode.NETWORK_TIMEOUT:
      return "The Stellar network is taking longer than expected. Please try again.";

    case SorokitErrorCode.CONTRACT_EXECUTION_FAILED:
      return "The smart contract rejected this operation. Check your inputs and try again.";

    default:
      // Fall back to the SDK's own message — it's always human-readable
      return error.message;
  }
}
```

**Pattern 2 — Category-based fallback (0:35)**

```ts
import type { SorokitError } from "sorokit-core";

/** Decide what to do based on error category rather than specific code. */
export function handleByCategory(error: SorokitError): void {
  switch (error.category) {
    case "network":
      // Show an offline/retry banner, queue the operation for when connectivity returns
      showOfflineBanner(error.recovery?.suggestion ?? "Check your internet connection.");
      break;

    case "wallet":
      // Prompt the user to re-connect or unlock their wallet
      promptWalletReconnect();
      break;

    case "validation":
      // The inputs are wrong — don't retry, show a validation error in the form
      showFormError(error.message);
      break;

    case "contract":
      // Contract rejected the call — surface the contract's own error message
      showContractError(error.message);
      break;

    default:
      // Unknown — log it and show a generic message
      console.error("Unexpected error:", error);
      showGenericError();
  }
}
```

**Pattern 3 — Automatic retry with exponential back-off (1:05)**

```ts
import type { SorokitResult } from "sorokit-core";

const RETRYABLE_DELAYS_MS = [500, 1000, 2000, 4000];

/** Retry an SDK operation up to 4 times, but only if the error is marked retryable. */
export async function withExponentialRetry<T>(
  operation: () => Promise<SorokitResult<T>>,
): Promise<SorokitResult<T>> {
  let result = await operation();

  for (const delay of RETRYABLE_DELAYS_MS) {
    if (result.status === "ok") return result;

    const retryable = result.error.recovery?.retryable ?? false;
    if (!retryable) {
      console.warn("Error is non-retryable, not retrying:", result.error.code);
      return result;
    }

    console.info(
      `Retrying in ${delay}ms (suggestion: ${result.error.recovery?.suggestion})`,
    );
    await new Promise(r => setTimeout(r, delay));
    result = await operation();
  }

  return result; // return the last failure after exhausting retries
}

// Usage — works with any SDK call:
const txResult = await withExponentialRetry(() =>
  client.transaction.submit(signedEnvelope),
);

const accountResult = await withExponentialRetry(() =>
  client.account.get(publicKey),
);
```

---

### Transcript

> "Error handling in sorokit-core comes down to three patterns that cover almost every
> case. Let's look at each one.
>
> Pattern one: user-facing messages. The SorokitErrorCode enum has human-meaningful
> names, so you can switch on them to produce messages that make sense to end users.
> Account not found? Tell them to fund the account. Wallet user rejected? Tell them
> they cancelled. Don't just pass raw SDK messages to the UI — translate them.
>
> Pattern two: category-based fallback. Instead of handling every code, branch on
> error-dot-category. Network errors get a retry banner and maybe offline queueing.
> Wallet errors prompt re-connection. Validation errors go straight to form fields.
> Contract errors surface the contract's own explanation. This pattern scales as the
> SDK adds new error codes — you handle the category even when you don't recognise the
> specific code.
>
> Pattern three: automatic retry. The recovery object on each SorokitError has a
> retryable boolean. Network timeouts, temporary Horizon errors, and some RPC
> failures are retryable. User rejections, validation failures, and contract assertion
> errors are not. The withExponentialRetry helper here reads that flag and only retries
> when the SDK says it's safe to do so — with exponential back-off so you don't hammer
> a struggling network.
>
> These three patterns — user messages, category fallback, and conditional retry —
> cover the full spectrum from individual error codes all the way up to infrastructure
> resilience. Combine them to build a robust, user-friendly Stellar application."

---

## Hosting and Linking (Once Recorded)

When a video is recorded and published:

1. Replace `<!-- TODO: add YouTube link once recorded -->` in the relevant tutorial
   section above with the real YouTube URL, e.g.:
   ```
   **YouTube**: https://youtu.be/XXXXXXXXXXX
   ```
2. Update the **Recorded** column in the status table at the top from ⬜ to ✅.
3. Update the README video table with the YouTube URL as a hyperlink on the tutorial
   title.
4. Commit the `.srt` transcript file to `docs/transcripts/tutorial-N.srt`.
5. Pin a comment on the YouTube video linking to this document for the full
   transcript and code examples.
