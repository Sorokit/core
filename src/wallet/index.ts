export { connectWallet } from "./connect";
export { disconnectWallet } from "./disconnect";
export { signTransaction } from "./signTransaction";
export { FreighterAdapter } from "./adapters/freighter";
export { XBullAdapter } from "./adapters/xbull";
export { LobstrAdapter } from "./adapters/lobstr";
export type {
  WalletType,
  WalletState,
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "./types";
export { WalletType as WalletTypeEnum } from "./types";

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { WalletState } from "./types";

/**
 * Return a canonical disconnected WalletState wrapped in SorokitResult.
 * Use this to initialise wallet state in the UI layer.
 */
export function emptyWalletState(): SorokitResult<WalletState> {
  return ok({ connected: false, publicKey: null, walletType: null });
}

/**
 * Collect signatures from multiple signers sequentially, returning the fully-signed XDR.
 *
 * Each `signFn` call receives the current (partially-signed) XDR and the signer's public key.
 * It should return the XDR with that signer's signature appended.
 * If any signer fails, the error is returned immediately and remaining signers are skipped.
 *
 * @param xdr - The unsigned (or partially-signed) transaction XDR.
 * @param signers - Ordered list of signer public keys.
 * @param signFn - Signing function called for each signer in order.
 * @returns The fully-signed XDR on success, or the first encountered error.
 */
export async function collectMultiSignatures(
  xdr: string,
  signers: string[],
  signFn: (xdr: string, signer: string) => Promise<SorokitResult<string>>,
): Promise<SorokitResult<string>> {
  if (signers.length === 0) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "collectMultiSignatures: signers list must not be empty.",
    );
  }

  let currentXdr = xdr;
  for (const signer of signers) {
    const result = await signFn(currentXdr, signer);
    if (result.status !== "ok") return result;
    currentXdr = result.data;
  }

  return ok(currentXdr);
}
