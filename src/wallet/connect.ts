import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { WalletAdapter, WalletState } from "./types";
import { traceWalletConnect, type TelemetrySpan } from "../performance/telemetry";

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
  return traceWalletConnect(
    (span) => connectWalletImpl(adapter, cache, span),
    { "wallet.type": adapter.walletType },
  );
}

async function connectWalletImpl(
  adapter: WalletAdapter,
  cache: SorokitCache | undefined,
  span: TelemetrySpan | undefined,
): Promise<SorokitResult<WalletState>> {
  if (!adapter.isAvailable()) {
    span?.setAttribute("wallet.browser_only", true);
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  const result = await adapter.connect();
  if (result.status === "error") {
    span?.recordError(new Error(result.error.message));
    return result;
  }

  // Validate that the adapter returned a non-empty public key string (#267).
  // An empty string (e.g. from an installed wallet without a configured account)
  // is invalid for downstream Stellar operations and should fail immediately.
  if (!result.data || typeof result.data !== "string" || result.data === "") {
    const message = "Wallet returned an empty public key.";
    span?.recordError(new Error(message));
    return err<WalletState>(SorokitErrorCode.WALLET_CONNECT_FAILED, message);
  }

  const state: WalletState = {
    connected: true,
    publicKey: result.data,
    walletType: adapter.walletType,
  };

  if (cache) {
    cache.set("wallet:state", state);
  }

  span?.setStatus("ok");
  return ok(state);
}

