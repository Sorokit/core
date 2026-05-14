import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, WalletState } from "./types";

/**
 * Disconnect a wallet via its adapter and return a clean disconnected WalletState.
 * State ownership belongs to the consuming layer (sorokit-ui or app).
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
