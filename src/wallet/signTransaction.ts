import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletAdapter, SignTransactionInput } from "./types";

/**
 * Sign a transaction XDR using the provided wallet adapter.
 *
 * The adapter handles wallet-specific signing logic and user rejection detection.
 * This function only enforces the browser guard before delegating.
 */
export async function signTransaction(
  adapter: WalletAdapter,
  input: SignTransactionInput,
): Promise<SorokitResult<string>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }
  return adapter.signTransaction(input);
}
