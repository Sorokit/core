# Lazy modules, anchors, federation, and key management

## Lazy entry points

Applications that want to load the client asynchronously can use the lightweight `core` entry:

```ts
import { createSorokitClient } from "sorokit-core/core";

const result = await createSorokitClient({ network: "testnet" });
```

The Soroban and SEP integration code is split from the client entry and loaded when those methods are first called. Applications can also import feature modules directly:

```ts
const { invokeContract } = await import("sorokit-core/soroban");
const { resolveFederatedAddress } = await import("sorokit-core/integration");
```

`loadSoroban()`, `loadIntegration()`, and `loadKeyManagement()` are also exported from `sorokit-core/lazy` and the package root for typed on-demand loading.

## Anchor transfer flows

Anchor methods discover endpoints from the anchor's HTTPS `stellar.toml`. SEP-10 authentication validates the anchor challenge with the signing key published in that file, then asks the caller's signer (typically a wallet) to sign the verified XDR. Secret keys are never accepted by the anchor integration API.

```ts
const started = await client.integration.initiateSep24Interactive(
  "https://anchor.example",
  { code: "USDC", issuer: "G..." },
  {
    accountId: connectedAccount,
    signChallenge: (xdr) => connectedWalletSigner.signChallenge(xdr),
    networkPassphrase: "Test SDF Network ; September 2015",
    direction: "deposit",
  },
);
```

The result contains the HTTPS interactive URL and anchor transaction ID. SEP-6 initiation and transaction-status calls use the `TRANSFER_SERVER`; SEP-24 initiation uses `TRANSFER_SERVER_SEP0024`. Caller-provided JWTs can be passed as `authToken` to reuse an existing SEP-10 session.

## SEP-2 federation lookup

```ts
const result = await client.integration.resolveFederatedAddress("alice@example.com", {
  cacheTtlMs: 60_000,
  timeoutMs: 5_000,
});
```

Federation lookup accepts `name*domain` and `name@domain`, discovers `FEDERATION_SERVER` through the Stellar SDK's `stellar.toml` resolver, validates the resolved account ID, and caches successful results for the configured TTL.

## Stellar key derivation and signer rotation

`deriveKey` accepts a valid English BIP-39 mnemonic and a hardened SEP-5 path such as `m/44'/148'/0'`. It returns both the Stellar public key and secret seed in a `SorokitResult`; handle the secret only in a secure signer or secret store, and do not log it. Non-hardened paths are rejected because SEP-5 uses SLIP-0010 Ed25519 derivation.

`rotateSecretKey` builds, but never signs or submits, a transaction that adds a replacement signer and removes an old non-master signer. Stellar account master keys cannot be rotated by this operation; the resulting transaction must be reviewed and signed by the account's configured threshold signers.

```ts
const derived = await client.shared.deriveKey(mnemonic, "m/44'/148'/0'");
const checked = await client.shared.validateSecretKey(secretSeed);
```
