import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState } from "./types";

/**
 * Connect a wallet via its adapter and return the resolved `WalletState`.
 *
 * Returns `WALLET_BROWSER_ONLY` if the adapter reports it is unavailable
 * (e.g. extension not installed or not a browser environment).
 * Propagates adapter-specific errors (e.g. `WALLET_CONNECT_FAILED`) unchanged.
 *
 * @param adapter - The wallet adapter to connect through (e.g. `FreighterAdapter`).
 * @returns `ok({ connected: true, publicKey, walletType })` on success,
 *          or an `error` SorokitResult on failure.
 *
 * @example
 * const adapter = new FreighterAdapter();
 * const result = await connectWallet(adapter);
 * if (result.status === "ok") {
 *   console.log("Connected as", result.data.publicKey);
 * }
 */
export async function connectWallet(
  adapter: WalletAdapter,
  cache?: SorokitCache,
): Promise<SorokitResult<WalletState>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  const result = await adapter.connect();
  if (result.status === "error") return result;

  const state: WalletState = {
    connected: true,
    publicKey: result.data,
    walletType: adapter.walletType,
  };

  if (cache) {
    cache.set("wallet:state", state);
  }

  return ok(state);
}

