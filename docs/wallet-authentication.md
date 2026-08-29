# Wallet Authentication

Application-level authentication layer for wallet access control, providing an additional security layer before sensitive wallet operations.

## Overview

The wallet authentication module adds biometric and PIN-based authentication to wallet operations without exposing private keys or raw biometric data. It supports:

- **WebAuthn authentication** (Touch ID, Windows Hello, security keys) where available
- **PIN-based fallback** for environments without WebAuthn support
- **Rate limiting** to prevent brute-force attacks
- **Session management** with configurable timeouts
- **Authentication state tracking** (locked/unlocked/expired)

## Quick Start

```typescript
import {
  WalletAuthenticationManager,
  detectAuthenticationCapabilities,
} from "sorokit-core";

// Detect available authentication methods
const capabilities = await detectAuthenticationCapabilities();

// Create authentication manager
const authManager = new WalletAuthenticationManager({
  sessionTimeoutMs: 900000, // 15 minutes
  maxFailedAttempts: 5,
  rateLimitDurationMs: 300000, // 5 minutes
});

// Setup authentication
if (capabilities.data.webauthn) {
  await authManager.setupWebAuthnAuthentication("wallet-123", {
    authenticatorName: "Touch ID",
    requireUserVerification: true,
  });
} else {
  await authManager.setupPINAuthentication("wallet-123", {
    pin: "1234",
    hint: "Birth year",
  });
}

// Lock wallet (e.g., on app background)
await authManager.lock("wallet-123");

// Unlock wallet before sensitive operations
const unlockResult = await authManager.unlock("wallet-123", {
  method: "PIN",
  pin: "1234",
});

if (unlockResult.status === "ok") {
  // Wallet is now unlocked
}
```

## Authentication Methods

### WebAuthn (Biometric/Security Key)

WebAuthn provides the highest level of security using:
- Platform authenticators (Touch ID, Face ID, Windows Hello)
- Cross-platform authenticators (USB security keys like YubiKey)
- User verification (biometric or device PIN)

**Setup:**
```typescript
const result = await authManager.setupWebAuthnAuthentication("wallet-123", {
  authenticatorName: "Touch ID",
  requireUserVerification: true,
});
```

**Authentication:**
```typescript
const result = await authManager.unlock("wallet-123", {
  method: AuthenticationMethod.WEBAUTHN,
});
```

**Graceful Degradation:**
WebAuthn is only available in secure contexts (HTTPS) and modern browsers. The module automatically detects availability and falls back to PIN authentication when unavailable.

### PIN Authentication

PIN authentication provides a fallback method that works everywhere:
- 4-8 digit numeric PIN
- Hashed and salted storage (never stored in plaintext)
- Optional recovery hint
- Change and reset flows

**Setup:**
```typescript
const result = await authManager.setupPINAuthentication("wallet-123", {
  pin: "1234",
  hint: "Birth year",
});
```

**Authentication:**
```typescript
const result = await authManager.unlock("wallet-123", {
  method: AuthenticationMethod.PIN,
  pin: "1234",
});
```

## Authentication States

The authentication manager tracks wallet state through four distinct states:

### UNINITIALIZED
No authentication has been configured for the wallet. Wallet operations can proceed without authentication (backward compatible).

### LOCKED
Authentication is configured but not currently active. Sensitive operations should be blocked until unlocked.

### UNLOCKED
Successfully authenticated and within the session timeout period. Operations are permitted.

### EXPIRED
Session timeout has elapsed. Requires re-authentication.

**Checking State:**
```typescript
const statusResult = await authManager.getStatus("wallet-123");
if (statusResult.status === "ok") {
  console.log("State:", statusResult.data.state);
  console.log("Authenticated at:", statusResult.data.authenticatedAt);
  console.log("Expires at:", statusResult.data.expiresAt);
}
```

## Rate Limiting

The authentication manager includes built-in protection against brute-force attacks:

- Tracks failed authentication attempts
- Enforces rate limiting after max attempts exceeded
- Configurable rate limit duration
- Automatically resets on successful authentication

**Configuration:**
```typescript
const authManager = new WalletAuthenticationManager({
  maxFailedAttempts: 5, // Lock after 5 failures
  rateLimitDurationMs: 300000, // 5 minute lockout
});
```

**Rate Limited Response:**
```typescript
{
  status: "error",
  error: {
    code: "WALLET_SIGN_REJECTED",
    message: "Too many failed attempts. Try again in 298 seconds."
  }
}
```

## Session Management

Sessions automatically expire after a configurable timeout period:

**Configuration:**
```typescript
const authManager = new WalletAuthenticationManager({
  sessionTimeoutMs: 900000, // 15 minutes
});
```

**Manual Locking:**
```typescript
// Lock wallet immediately (e.g., on app background)
await authManager.lock("wallet-123");
```

**Requiring Authentication:**
```typescript
// Before sensitive operations, require active authentication
const authCheck = await authManager.requireAuthentication("wallet-123");
if (authCheck.status === "error") {
  // Prompt user to unlock wallet
  return;
}

// Proceed with sensitive operation
await wallet.signTransaction(...);
```

## PIN Management

### Change PIN
```typescript
const result = await authManager.changePINAuthentication("wallet-123", {
  currentPin: "1234",
  newPin: "5678",
});
```

### Reset Authentication
```typescript
// Removes all authentication data
const result = await authManager.resetAuthentication("wallet-123");
```

## Storage

### In-Memory Storage (Default)
```typescript
import { InMemoryAuthenticationStorage } from "sorokit-core";

const storage = new InMemoryAuthenticationStorage();
const authManager = new WalletAuthenticationManager({}, storage);
```

### localStorage Storage
```typescript
import { createLocalStorageAuthenticationStorage } from "sorokit-core";

const storage = createLocalStorageAuthenticationStorage();
const authManager = new WalletAuthenticationManager({}, storage);
```

### Custom Storage
Implement the `AuthenticationStorage` interface:

```typescript
interface AuthenticationStorage {
  storeCredential(walletId: string, credential: AuthenticationCredential): Promise<SorokitResult<void>>;
  getCredential(walletId: string): Promise<SorokitResult<AuthenticationCredential | null>>;
  removeCredential(walletId: string): Promise<SorokitResult<void>>;
  storeSession(walletId: string, status: AuthenticationStatus): Promise<SorokitResult<void>>;
  getSession(walletId: string): Promise<SorokitResult<AuthenticationStatus | null>>;
  clearSession(walletId: string): Promise<SorokitResult<void>>;
}
```

## Integration with Wallet Connection

Authentication is separate from wallet connection. Applications can layer authentication on top of existing wallet workflows:

```typescript
import { createSorokitClient, FreighterAdapter } from "sorokit-core";

const client = createSorokitClient({ network: "testnet" });
const adapter = new FreighterAdapter(swkInstance);

// 1. Connect wallet (unchanged)
const connResult = await client.wallet.connect(adapter);

// 2. Setup authentication
const authManager = new WalletAuthenticationManager();
await authManager.setupPINAuthentication(connResult.data.publicKey, {
  pin: "1234",
});

// 3. Lock wallet
await authManager.lock(connResult.data.publicKey);

// 4. Before signing, require authentication
const authCheck = await authManager.requireAuthentication(connResult.data.publicKey);
if (authCheck.status === "error") {
  // Show unlock UI
  const unlockResult = await authManager.unlock(connResult.data.publicKey, {
    method: AuthenticationMethod.PIN,
    pin: userProvidedPin,
  });
  if (unlockResult.status === "error") {
    return unlockResult;
  }
}

// 5. Proceed with transaction signing
const signResult = await client.wallet.signTransaction(adapter, {
  transactionXdr,
  networkPassphrase,
});
```

## Security Considerations

### What is NOT stored:
- ❌ Private keys
- ❌ Raw biometric data
- ❌ Plaintext PINs
- ❌ Signature bytes

### What IS stored:
- ✅ Hashed PINs with random salts
- ✅ WebAuthn public keys (never private keys)
- ✅ Session state and expiration times
- ✅ Authentication attempt counters

### Best Practices:

1. **Use WebAuthn when available** - Provides the strongest security with hardware-backed key storage

2. **Set appropriate session timeouts** - Balance security and user experience
   - High security: 5-15 minutes
   - Standard: 15-30 minutes
   - Convenience: 1-2 hours

3. **Implement rate limiting** - Prevent brute-force attacks
   - Recommended: 3-5 max attempts, 5-15 minute lockout

4. **Use secure storage** - Implement encrypted storage in production
   - Mobile: Use native secure storage (Keychain, Keystore)
   - Web: Consider IndexedDB with encryption
   - Server: Use proper secrets management

5. **Lock on app background** - Clear sessions when app is backgrounded
   ```typescript
   window.addEventListener('blur', () => {
     authManager.lock(walletId);
   });
   ```

6. **Never log authentication data** - Credentials and PINs should never appear in logs

## Browser Compatibility

### WebAuthn Support:
- ✅ Chrome 67+
- ✅ Firefox 60+
- ✅ Safari 13+
- ✅ Edge 18+

### Fallback Behavior:
When WebAuthn is unavailable:
- Automatically falls back to PIN authentication
- Detection is automatic via `detectAuthenticationCapabilities()`
- Applications don't need to handle browser differences

## Testing

The module includes comprehensive test coverage:

```bash
npm test -- walletAuthentication.test.ts
```

**Test Coverage:**
- ✅ PIN setup, verification, change, and reset
- ✅ WebAuthn registration and authentication flows
- ✅ Rate limiting enforcement
- ✅ Session expiration
- ✅ Authentication state transitions
- ✅ Storage integration
- ✅ Error handling
- ✅ Backward compatibility

## Migration Guide

Existing applications using `sorokit-core` wallet functionality:

**No breaking changes** - Authentication is opt-in:

```typescript
// Existing code continues to work
const connResult = await client.wallet.connect(adapter);
const signResult = await client.wallet.signTransaction(adapter, input);

// Add authentication incrementally
const authManager = new WalletAuthenticationManager();
await authManager.setupPINAuthentication(walletId, { pin: "1234" });
// Now require authentication before signing
await authManager.requireAuthentication(walletId);
```

## API Reference

### WalletAuthenticationManager

Main authentication coordination class.

**Constructor:**
```typescript
new WalletAuthenticationManager(
  config?: AuthenticationConfig,
  storage?: AuthenticationStorage
)
```

**Methods:**
- `getStatus(walletId)` - Get current authentication status
- `setupPINAuthentication(walletId, options)` - Setup PIN authentication
- `setupWebAuthnAuthentication(walletId, options)` - Setup WebAuthn authentication
- `unlock(walletId, options)` - Unlock wallet with authentication
- `lock(walletId)` - Lock wallet
- `changePINAuthentication(walletId, options)` - Change PIN
- `resetAuthentication(walletId)` - Reset all authentication
- `requireAuthentication(walletId)` - Check if unlocked

### Helper Functions

- `detectAuthenticationCapabilities()` - Detect available auth methods
- `isAuthenticationMethodAvailable(method)` - Check if method is available
- `setupPIN(options)` - Create PIN credential
- `verifyPIN(options, credential)` - Verify PIN
- `changePIN(options, credential)` - Change PIN
- `resetPIN()` - Reset PIN
- `registerWebAuthn(walletId, options)` - Register WebAuthn credential
- `authenticateWebAuthn(credential, options)` - Authenticate with WebAuthn

### Types

See full type definitions in `src/wallet/authentication/types.ts`.

## Examples

Complete examples are available in the repository:
- Basic PIN authentication
- WebAuthn setup and fallback
- Session management
- Integration with wallet signing

## Support

For issues or questions:
- GitHub Issues: [sorokit-core/issues](https://github.com/Just-Bamford/sorokit-core/issues)
- Documentation: [docs/wallet-authentication.md](./wallet-authentication.md)
