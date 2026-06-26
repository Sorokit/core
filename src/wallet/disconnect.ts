import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState } from "./types";

/**
 * Disconnect a wallet via its adapter and return a clean disconnected WalletState.
 * State ownership belongs to the consuming layer (sorokit-ui or app).
 */
export async function disconnectWallet(
  adapter: WalletAdapter,
  cache?: SorokitCache,
): Promise<SorokitResult<WalletState>> {
  const result = await adapter.disconnect();
  if (result.status === "error") return result;

  if (cache) {
    cache.invalidate("wallet:state");
  }

  return ok({
    connected: false,
    publicKey: null,
    walletType: null,
  });
}

