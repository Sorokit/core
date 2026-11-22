# Wallet Security Audit Checklist

This security checklist guides developers and end-users through best practices for securing Stellar wallets, keypairs, and Soroban smart contract interactions when integrating with Sorokit.

---

## 1. Private Key & Secret Management

- [ ] **Never Hardcode Secrets**: Never include secret keys (`S...`), mnemonics, or recovery seeds in client-side code, git repositories, or frontend bundles.
- [ ] **Use Non-Custodial Connectors**: Delegate all signing operations to browser extensions (Freighter, xBull, Lobstr, Albedo) via `connectWallet` and `signTransaction`.
- [ ] **Enforce Ephemeral Memory**: Clear in-memory secret material immediately after use; avoid global variable storage for signing credentials.
- [ ] **Hardware Wallet Priority**: Recommend Ledger or other hardware devices for high-value treasury accounts.

---

## 2. Seed Phrase & Backup Redundancy

- [ ] **Offline Physical Backup**: Store recovery seed phrases offline in a fireproof and waterproof physical location.
- [ ] **No Digital Screenshots**: Prohibit storing plaintext seeds in digital notebooks, cloud storage, photos, or password managers without zero-knowledge encryption.
- [ ] **Restoration Dry-Runs**: Periodically verify that backup seed phrases can successfully derive expected Stellar account public keys on isolated air-gapped devices.

---

## 3. Passphrase & Multi-Signature Safeguards

- [ ] **Network Passphrase Isolation**: Always match transaction network passphrases (`Public Global Stellar Network ; September 2015` vs `Test SDF Network ; September 2015`) to prevent replay attacks across environments.
- [ ] **Multi-Signature Thresholds**: Configure multi-signature schemes (e.g. 2-of-3) for administrative or high-volume disbursement accounts using `Sorokit` multi-sig coordinator.
- [ ] **Weight & Signer Audits**: Routinely inspect account thresholds (`low_threshold`, `med_threshold`, `high_threshold`) and revoke obsolete signer keys.

---

## 4. Network Confirmation & Phishing Defense

- [ ] **Verify Domain & Origin**: Ensure your application origin matches HTTPS domains registered with wallet connectors.
- [ ] **Explicit Simulation Review**: Before asking users to sign, present clear simulation previews showing expected balance deductions and contract state mutations.
- [ ] **Inspect Unsigned Envelopes**: Inspect operation counts and destination addresses before dispatching signing prompts.

---

## 5. Device Security & Browser Environment

- [ ] **Isolate Wallet Extensions**: Use dedicated browser profiles for blockchain administration free of untrusted third-party extensions.
- [ ] **Keep Extensions Updated**: Use Sorokit's `checkWalletVersion()` helper to ensure wallet extensions meet minimum security patch levels.
- [ ] **Automatic Inactivity Timeouts**: Enforce session TTLs via `WalletStateManager` / `saveSession` and auto-disconnect inactive sessions.

---

## 6. Implementation Example

```typescript
import {
  checkWalletVersion,
  createWalletStateManager,
  connectWallet,
  WalletType,
} from "sorokit-core";

// 1. Check wallet version before connecting
const versionStatus = checkWalletVersion(WalletType.FREIGHTER, "5.1.0");
if (versionStatus.status === "ok" && versionStatus.data.isOutdated) {
  console.warn("Security Alert:", versionStatus.data.warning);
}

// 2. Persist state securely
const stateManager = createWalletStateManager();
await stateManager.saveState({
  connectedWallets: [WalletType.FREIGHTER],
  activeAccount: "GABC...",
  network: "testnet",
  settings: { timeoutMinutes: 15 },
});
```

---

## Additional Security Resources
- [Stellar Security Guidelines](https://developers.stellar.org/docs/learn/encyclopedia/security)
- [Soroban Smart Contract Security](https://soroban.stellar.org/docs)
- [OWASP Top 10 Security Checklist](https://owasp.org/www-project-top-ten/)
