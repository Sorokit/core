/**
 * Freighter wallet adapter.
 *
 * Freighter is the SDF-maintained browser extension wallet.
 * This adapter wraps the SWK instance provided by the consumer —
 * sorokit-core never instantiates SWK directly.
 *
 * Consumer responsibilities:
 * - Install @creit.tech/stellar-wallets-kit (peer dependency)
 * - Initialise StellarWalletsKit with the Freighter module
 * - Pass the kit instance to this adapter
 */

import { WalletType } from "../types";
import type {
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import {
  isBrowser,
  isNetworkConnectivityError,
  isTimeoutError,
  isUserRejection,
  toMessage,
} from "../../shared";

function describeFreighterFailure(action: "connection" | "signing", cause: unknown): string {
  if (isTimeoutError(cause)) {
    return `Freighter ${action} timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Freighter ${action} failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `Freighter ${action} failed: ${toMessage(cause)}`;
}

export class FreighterAdapter implements WalletAdapter {
  readonly walletType = WalletType.FREIGHTER;

  constructor(private readonly kit: SWKInstance) {}

  isAvailable(): boolean {
    return isBrowser();
  }

  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Freighter requires a browser environment.",
      );
    }
    try {
      const { address } = await this.kit.getAddress();
      return ok(address);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeFreighterFailure("connection", cause),
        cause,
      );
    }
  }

  async disconnect(): Promise<SorokitResult<void>> {
    // Freighter does not expose a programmatic disconnect.
    // Return success — state cleanup is the consumer's responsibility.
    return ok(undefined);
  }

  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Freighter requires a browser environment.",
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
      const rejected = isUserRejection(cause);
      return err(
        rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
        rejected
          ? "User rejected the Freighter signature request."
          : describeFreighterFailure("signing", cause),
        cause,
      );
    }
  }
}
