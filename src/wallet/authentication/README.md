# Wallet Authentication Module

Application-level authentication layer for wallet access, implementing issue #500.

## Features

✅ **WebAuthn authentication** - Biometric and security key support where available  
✅ **PIN-based fallback** - Works everywhere, never stores plaintext  
✅ **Rate limiting** - Protection against brute-force attacks  
✅ **Session management** - Configurable timeouts with automatic expiration  
✅ **Authentication states** - Explicit locked/unlocked/expired states  
✅ **Secure storage** - Never exposes private keys or raw biometric data  
✅ **Backward compatible** - Existing wallet connections work without changes  
✅ **Comprehensive tests** - Full coverage of all authentication flows  

## Quick Example

```typescript
import { WalletAuthenticationManager } from "sorokit-core";

const authManager = new WalletAuthenticationManager({
  sessionTimeoutMs: 900000, // 15 minutes
});

// Setup
await authManager.setupPINAuthentication("wallet-123", { pin: "1234" });

// Lock
await authManager.lock("wallet-123");

// Unlock
await authManager.unlock("wallet-123", {
  method: "PIN",
  pin: "1234",
});

// Check before sensitive operations
const authCheck = await authManager.requireAuthentication("wallet-123");
if (authCheck.status === "ok") {
  // Proceed with wallet operation
}
```

## Files

- `types.ts` - Type definitions and interfaces
- `capabilities.ts` - Authentication capability detection
- `pinAuth.ts` - PIN authentication implementation
- `webAuthnAuth.ts` - WebAuthn authentication implementation
- `storage.ts` - Storage adapters (in-memory and localStorage)
- `authenticationManager.ts` - Main authentication coordinator
- `index.ts` - Public API exports

## Documentation

See [docs/wallet-authentication.md](../../../docs/wallet-authentication.md) for complete documentation.

## Testing

```bash
npm test -- walletAuthentication.test.ts
```

## Security

- Private keys are NEVER stored or accessed
- PINs are hashed with random salts
- WebAuthn private keys never leave the authenticator device
- Rate limiting prevents brute-force attacks
- Sessions expire automatically

## Browser Support

- WebAuthn: Chrome 67+, Firefox 60+, Safari 13+, Edge 18+
- PIN: All environments (Node, browser, React Native)
