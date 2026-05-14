import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, WalletState } from "./types";

/**
 * Connect a wallet via its adapter and return the resolved WalletState.
 */
export async function connectWallet(
  adapter: WalletAdapter,
): Promise<SorokitResult<WalletState>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  const result = await adapter.connect();
  if (result.status === "error") return result;

  return ok({
    connected: true,
    publicKey: result.data,
    walletType: adapter.walletType,
  });
}
