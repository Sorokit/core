import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isUserRejection,
  toMessage,
} from "../../shared";
import type { SignTransactionInput, SWKInstance } from "../types";

export function describeSignFailure(
  walletName: string,
  action: "connection" | "signing",
  cause: unknown,
): string {
  const msg = toMessage(cause).toLowerCase();
  if (isUserRejection(cause) || msg.includes("reject") || msg.includes("denied") || msg.includes("cancel")) {
    return `Approve the ${action} request in your ${walletName} wallet and try again.`;
  }
  if (msg.includes("locked") || msg.includes("unlock")) {
    return `Unlock your ${walletName} wallet and try again.`;
  }
  if (msg.includes("not installed") || msg.includes("not found") || msg.includes("missing")) {
    return `Install the ${walletName} extension and try again.`;
  }
  if (isTimeoutError(cause) || msg.includes("time out") || msg.includes("timeout")) {
    return `The ${walletName} ${action} timed out after 30 seconds. Make sure your wallet is open and try again.`;
  }
  if (isNetworkConnectivityError(cause) || msg.includes("network") || msg.includes("offline")) {
    return `Make sure your ${walletName} wallet is open and responding, then try again.`;
  }
  return `${walletName} ${action} failed: ${toMessage(cause)}`;
}

export async function swkSignTransaction(
  kit: SWKInstance,
  walletName: string,
  input: SignTransactionInput,
): Promise<SorokitResult<string>> {
  try {
    const { signedTxXdr } = await kit.signTransaction(input.transactionXdr, {
      networkPassphrase: input.networkPassphrase,
      ...(input.accountToSign !== undefined && { address: input.accountToSign }),
    });
    return ok(signedTxXdr);
  } catch (cause) {
    const rejected = isUserRejection(cause);
    return err(
      rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
      rejected
        ? `User rejected the ${walletName} signature request.`
        : describeSignFailure(walletName, "signing", cause),
      cause,
    );
  }
}
