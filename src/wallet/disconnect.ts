import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState } from "./types";
import { emitObservabilityEvent } from "../shared/observability";

/**
 * Disconnect a wallet via its adapter and return a clean disconnected `WalletState`.
 *
 * Propagates adapter errors unchanged. On success the returned state has
 * `connected: false` and `null` values for `publicKey` and `walletType`.
 * State ownership belongs to the consuming layer (sorokit-ui or app).
 *
 * @param adapter - The wallet adapter to disconnect.
 * @returns `ok({ connected: false, publicKey: null, walletType: null })` on success,
 *          or an `error` SorokitResult if the adapter raises an error.
 *
 * @example
 * const result = await disconnectWallet(adapter);
 * if (result.status === "ok") {
 *   console.log("Wallet disconnected");
 * }
 */
export async function disconnectWallet(
  adapter: WalletAdapter,
  cache?: SorokitCache,
): Promise<SorokitResult<WalletState>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  const result = await adapter.disconnect();
  if (result.status === "error") return result;

  if (cache) {
    cache.invalidate("wallet:state");
  }

  try {
    emitObservabilityEvent({
      type: "wallet_state_change",
      event: "disconnected",
      walletType: adapter.walletType,
    });
  } catch {
    // Ignore observability hook errors
  }

  return ok({
    connected: false,
    publicKey: null,
    walletType: null,
  });
}

