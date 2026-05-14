/**
 * xBull wallet adapter.
 *
 * xBull is a Stellar wallet available as both a browser extension and PWA.
 * Wraps the SWK instance — same pattern as FreighterAdapter.
 */

import { WalletType } from "../types";
import type {
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isBrowser, toMessage, isUserRejection } from "../../shared";

export class XBullAdapter implements WalletAdapter {
  readonly walletType = WalletType.XBULL;

  constructor(private readonly kit: SWKInstance) {}

  isAvailable(): boolean {
    return isBrowser();
  }

  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "xBull requires a browser environment.",
      );
    }
    try {
      const { address } = await this.kit.getAddress();
      return ok(address);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        `xBull connection failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  async disconnect(): Promise<SorokitResult<void>> {
    return ok(undefined);
  }

  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "xBull requires a browser environment.",
      );
    }
    try {
      const { signedTxXdr } = await this.kit.signTransaction(
        input.transactionXdr,
        {
          networkPassphrase: input.networkPassphrase,
          ...(input.accountToSign !== undefined && {
            address: input.accountToSign,
          }),
        },
      );
      return ok(signedTxXdr);
    } catch (cause) {
      return err(
        isUserRejection(cause)
          ? SorokitErrorCode.WALLET_SIGN_REJECTED
          : SorokitErrorCode.WALLET_SIGN_FAILED,
        isUserRejection(cause)
          ? "User rejected the xBull signature request."
          : `xBull signing failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }
}
