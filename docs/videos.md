# Video Tutorial Series (in progress)

Tracks issue #609. **This is a script/outline scaffold, not finished
videos** — no recording, narration, editing, or hosting has happened yet.
An AI coding agent can draft scripts and code examples, but can't record
screen capture, narrate audio, edit footage, or upload to YouTube; those
still need a human. This page exists so a contributor picking up recording
doesn't have to design each tutorial's content from scratch — the scope,
structure, and code examples below are ready to record against.

Once a video is actually recorded and hosted, update its entry below with
the real link and mark it done, and add the same link to the README under
"Learn more"/tutorials.

## Status

| # | Tutorial | Target length | Script | Recorded |
|---|---|---|---|---|
| 1 | Wallet Connection | 2 min | ✅ below | ⬜ |
| 2 | Building a Payment | 2 min | ✅ below | ⬜ |
| 3 | Multi-Sig Approval | 4 min | ✅ below | ⬜ |
| 4 | Soroban Contract Invoke | 3 min | ✅ below | ⬜ |
| 5 | Error Handling | 2 min | ✅ below | ⬜ |
| 6 | Testing | 3 min | ✅ below | ⬜ |
| 7 | Deployment Guide | 3 min | ✅ below | ⬜ |

## Production notes (for whoever records these)

- **Audio**: an external mic, not a laptop's built-in one — the single
  biggest quality gap in most tutorial videos is audio, not video.
- **Screen recording**: 1080p minimum, code editor font size large enough
  to read on a phone screen.
- **Pacing**: run each script once un-recorded first: if it runs long,
  cut content rather than talk faster.
- **Transcripts**: acceptance criteria for #609 requires transcripts —
  the script text below is written to double as one (adjust for whatever
  is actually said during recording).
- **Code examples**: every snippet below is real, working `sorokit-core`
  API surface — verify it still matches the current API before recording,
  since the SDK evolves.

---

## 1. Wallet Connection (2 min)

**Goal**: viewer can connect a browser wallet and read the connected public key.

**Script**:
1. (0:00) "This is the fastest way to get a Stellar wallet connected with `sorokit-core`." Show `npm install sorokit-core`.
2. (0:20) Create a client:
   ```ts
   import { createSorokitClient } from "sorokit-core";

   const clientResult = createSorokitClient({ network: "testnet" });
   if (clientResult.status === "error") throw new Error(clientResult.error.message);
   const client = clientResult.data;
   ```
3. (0:45) Connect a wallet (Freighter, in the demo):
   ```ts
   const connection = await client.wallet.connect("freighter");
   if (connection.status === "ok") {
     console.log("Connected:", connection.data.publicKey);
   }
   ```
4. (1:15) Point out the no-throw result pattern — no `try/catch` needed, branch on `.status`.
5. (1:40) Mention `client.wallet.discovery()` for listing which wallets are actually installed in the browser, and cut.

---

## 2. Building a Payment (2 min)

**Goal**: viewer builds, signs, and submits a real testnet payment.

**Script**:
1. (0:00) "Every transaction in Sorokit is build → sign → submit — three explicit steps, no hidden magic."
2. (0:15) Build:
   ```ts
   const unsigned = await client.transaction.buildPayment(sourcePublicKey, {
     destination: "GDEST...",
     amount: "10.5000000",
     memo: "Tutorial payment",
   });
   ```
3. (0:50) Sign with the connected wallet adapter from Video 1:
   ```ts
   const signed = await client.wallet.sign(unsigned.data);
   ```
4. (1:15) Submit and check status:
   ```ts
   const submitted = await client.transaction.submit(signed.data);
   const status = await client.transaction.getStatus(submitted.data.hash);
   ```
5. (1:50) Show the result on a testnet explorer, cut.

---

## 3. Multi-Sig Approval (4 min)

**Goal**: viewer understands adding a co-signer and collecting a multi-sig approval before submission.

**Script**:
1. (0:00) "Multi-sig on Stellar means signature *weights* against a *threshold* — here's how Sorokit represents that."
2. (0:30) Add a co-signer via `client.transaction.buildSetOptions` (raise `medThreshold` so one key alone is no longer enough).
3. (1:15) Build the payment that will need multi-sig, same as Video 2.
4. (1:45) Wrap it in an envelope:
   ```ts
   import { buildMultiSigEnvelope, collectSignature } from "sorokit-core/transaction";

   const envelope = buildMultiSigEnvelope(unsigned.data, networkPassphrase, {
     signers: [{ publicKey: primaryKey, weight: 1 }, { publicKey: cosignerKey, weight: 1 }],
     threshold: 2,
   });
   ```
5. (2:30) Collect each signature and check `thresholdMet`:
   ```ts
   const step1 = await collectSignature(envelope.data, primaryKey, signFn);
   const step2 = await collectSignature(step1.data, cosignerKey, signFn);
   // step2.data.thresholdMet === true
   ```
6. (3:30) Submit `step2.data.envelopeXdr` once the threshold is met, cut.

---

## 4. Soroban Contract Invoke (3 min)

**Goal**: viewer reads from and invokes a Soroban contract.

**Script**:
1. (0:00) "Reading contract state and invoking a state-changing method are two different calls — here's why, and how."
2. (0:25) Read-only call (simulation only, no signature, no fee):
   ```ts
   const balance = await client.soroban.read({
     contractId,
     method: "balance",
     args: [addressScVal],
     publicKey: readerPublicKey,
   });
   ```
3. (1:15) State-changing invoke (needs a signer):
   ```ts
   const result = await client.soroban.invoke(
     { contractId, method: "transfer", args: [...] },
     signFn,
   );
   ```
4. (2:15) Point out `client.soroban.getContractMethods` for discovering a contract's callable methods without reading its source.
5. (2:45) Mention contract errors surface through the same `SorokitResult`/`SorokitErrorCode` pattern as everything else — no special-casing, cut.

---

## 5. Error Handling (2 min)

**Goal**: viewer understands the no-throw result model and how to branch on error codes.

**Script**:
1. (0:00) "Nothing in Sorokit throws for an expected failure — every call returns a result you check."
2. (0:20) Show the shape:
   ```ts
   const result = await client.account.get(publicKey);
   if (result.status === "error") {
     // result.error.code, .message, .category, .recovery
   }
   ```
3. (0:50) Branch on a specific code:
   ```ts
   if (result.error.code === SorokitErrorCode.ACCOUNT_NOT_FOUND) {
     // prompt the user to fund the account
   }
   ```
4. (1:20) Use `result.error.recovery?.retryable` for generic retry logic that works across every error source (Horizon, RPC, wallet).
5. (1:50) Link to `docs/adr/001-sorokitresult-no-throw-model.md` for the full rationale, cut.

---

## 6. Testing (3 min)

**Goal**: viewer writes a test against `sorokit-core` without hitting real network.

**Script**:
1. (0:00) "You don't need real testnet calls to test code that uses Sorokit — here's the testing utilities."
2. (0:30) Import from `sorokit-core/testing` (mock client/wallet helpers).
3. (1:15) Show a Vitest example asserting a `SorokitResult` shape from a mocked call.
4. (2:00) Contrast with the SDK's own live-testnet E2E suite (`npm run test:e2e`, `src/tests/e2e.test.ts`) — self-funds via Friendbot, no secrets needed, for the rare case a change needs real-network verification.
5. (2:45) Cut.

---

## 7. Deployment Guide (3 min)

**Goal**: viewer deploys a Soroban contract and gets its contract ID.

**Script**:
1. (0:00) "Deploying a Soroban contract from a compiled `.wasm` — here's the flow."
2. (0:30) Show `client.transaction.buildDeployContract` (upload + create + constructor invoke).
3. (1:30) Sign and submit, same build → sign → submit shape as every other transaction.
4. (2:15) Extract the resulting contract ID and immediately do a read call against it to confirm it's live.
5. (2:50) Cut.

---

## Hosting and linking (once recorded)

- Host on YouTube (a channel or playlist — TBD by whoever owns publishing).
- Update the table at the top of this file with real links.
- Add a "Video Tutorials" section to the README linking here, using the same list.
