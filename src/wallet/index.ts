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
import type { WalletState, SignTransactionInput } from "./types";

/**
 * Return a canonical disconnected WalletState wrapped in SorokitResult.
 * Use this to initialise wallet state in the UI layer.
 */
export function emptyWalletState(): SorokitResult<WalletState> {
  return ok({ connected: false, publicKey: null, walletType: null });
}

/**
 * Collect signatures from multiple signers sequentially for a multi-signature
 * transaction. Each signer's `signFn` receives the current (partially-signed)
 * XDR and must return the XDR with their signature appended.
 *
 * Signatures are applied in the order the `signers` array is provided.
 * If any signer's function returns an error result, collection stops
 * immediately and the error is returned — no partial XDR is returned on
 * failure.
 *
 * @param transactionXdr  The unsigned (or partially-signed) transaction XDR.
 * @param signers         Ordered list of signer public keys.
 * @param signFn          Function that, given a `SignTransactionInput`, returns
 *                        a SorokitResult<string> containing the signed XDR.
 * @returns               SorokitResult<string> with the fully-signed XDR.
 */
export async function collectMultiSignatures(
  transactionXdr: string,
  signers: string[],
  signFn: (input: SignTransactionInput) => Promise<SorokitResult<string>>,
  networkPassphrase: string,
): Promise<SorokitResult<string>> {
  if (signers.length === 0) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "collectMultiSignatures: signers array must not be empty",
    );
  }

  let currentXdr = transactionXdr;

  for (const signer of signers) {
    const result = await signFn({
      transactionXdr: currentXdr,
      networkPassphrase,
      accountToSign: signer,
    });

    if (result.status === "error") {
      return err(
        result.error.code,
        `collectMultiSignatures: signer ${signer} failed — ${result.error.message}`,
        result.error.cause,
      );
    }

    currentXdr = result.data;
  }

  return ok(currentXdr);
}
