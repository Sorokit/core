import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, WalletState } from "./types";

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
): Promise<SorokitResult<WalletState>> {
  const result = await adapter.disconnect();
  if (result.status === "error") return result;

  return ok({
    connected: false,
    publicKey: null,
    walletType: null,
  });
}
